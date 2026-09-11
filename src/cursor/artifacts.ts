import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

/** Deliverable file metadata returned with cursor_run. */
export type RunArtifactMeta = {
  path: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
};

export const MAX_ARTIFACT_BYTES = 20 * 1024 * 1024;
export const MAX_ARTIFACTS_PER_RUN = 3;
const ALLOWED_DIRS = new Set(['output', 'data']);
const ALLOWED_EXT = new Set(['.pdf']);

/** Per-cwd paths registered via register_artifact before/during a run. */
const registeredByCwd = new Map<string, Set<string>>();

export function registerArtifactPath(cwd: string, relativePath: string): RunArtifactMeta {
  const normalized = normalizeArtifactPath(cwd, relativePath);
  const abs = path.join(cwd, normalized);
  if (!existsSync(abs)) {
    throw new Error(`artifact not found: ${normalized}`);
  }
  const stat = statSync(abs);
  if (!stat.isFile()) {
    throw new Error(`artifact is not a file: ${normalized}`);
  }
  if (stat.size > MAX_ARTIFACT_BYTES) {
    throw new Error(`artifact too large (max ${MAX_ARTIFACT_BYTES} bytes): ${normalized}`);
  }
  let set = registeredByCwd.get(cwd);
  if (!set) {
    set = new Set();
    registeredByCwd.set(cwd, set);
  }
  set.add(normalized);
  return metaForFile(cwd, normalized, stat.size);
}

export function clearRegisteredArtifacts(cwd: string): void {
  registeredByCwd.delete(cwd);
}

function registeredPaths(cwd: string): string[] {
  return [...(registeredByCwd.get(cwd) ?? [])];
}

/** Relative path under cwd; must be output/ or data/ with allowlisted extension. */
export function normalizeArtifactPath(cwd: string, relativePath: string): string {
  const raw = relativePath.trim().replace(/\\/g, '/');
  if (!raw || raw.startsWith('/') || raw.includes('..')) {
    throw new Error(`invalid artifact path: ${relativePath}`);
  }
  const segments = raw.split('/').filter(Boolean);
  if (segments.length < 2) {
    throw new Error(`artifact path must be under output/ or data/: ${relativePath}`);
  }
  const top = segments[0]!;
  if (!ALLOWED_DIRS.has(top)) {
    throw new Error(`artifact dir not allowed (use output/ or data/): ${relativePath}`);
  }
  const ext = path.extname(segments[segments.length - 1]!).toLowerCase();
  if (!ALLOWED_EXT.has(ext)) {
    throw new Error(`artifact extension not allowed: ${ext || '(none)'}`);
  }
  const resolved = path.resolve(cwd, ...segments);
  const rel = path.relative(cwd, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`artifact escapes workspace: ${relativePath}`);
  }
  return rel.split(path.sep).join('/');
}

export function readWorkspaceArtifact(cwd: string, relativePath: string): Buffer {
  const normalized = normalizeArtifactPath(cwd, relativePath);
  const abs = path.join(cwd, normalized);
  if (!existsSync(abs)) {
    throw new Error(`file not found: ${normalized}`);
  }
  const stat = statSync(abs);
  if (!stat.isFile()) {
    throw new Error(`not a file: ${normalized}`);
  }
  if (stat.size > MAX_ARTIFACT_BYTES) {
    throw new Error(`file too large (max ${MAX_ARTIFACT_BYTES} bytes)`);
  }
  return readFileSync(abs);
}

function metaForFile(_cwd: string, relativePath: string, sizeBytes: number): RunArtifactMeta {
  const ext = path.extname(relativePath).toLowerCase();
  const mimeType = ext === '.pdf' ? 'application/pdf' : 'application/octet-stream';
  return {
    path: relativePath,
    name: path.basename(relativePath),
    mimeType,
    sizeBytes,
  };
}

function scanDirForArtifacts(
  cwd: string,
  dirName: string,
  sinceMs: number,
  found: Map<string, RunArtifactMeta>,
): void {
  const dir = path.join(cwd, dirName);
  if (!existsSync(dir)) return;

  const walk = (relDir: string) => {
    const absDir = path.join(cwd, relDir);
    let entries: string[];
    try {
      entries = readdirSync(absDir);
    } catch {
      return;
    }
    for (const name of entries) {
      const rel = path.posix.join(relDir.split(path.sep).join('/'), name);
      const abs = path.join(cwd, rel);
      let stat;
      try {
        stat = statSync(abs);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        walk(rel);
        continue;
      }
      if (!stat.isFile()) continue;
      const ext = path.extname(name).toLowerCase();
      if (!ALLOWED_EXT.has(ext)) continue;
      if (stat.mtimeMs < sinceMs - 2000) continue;
      if (stat.size > MAX_ARTIFACT_BYTES) continue;
      try {
        const normalized = normalizeArtifactPath(cwd, rel.split(path.sep).join('/'));
        found.set(normalized, metaForFile(cwd, normalized, stat.size));
      } catch {
        // skip paths outside allowlist
      }
    }
  };

  walk(dirName);
}

const PDF_NAME_RE =
  /\b(?:output\/[a-zA-Z0-9._-]+\.pdf|[a-zA-Z0-9][a-zA-Z0-9._-]*\.pdf)\b/gi;

function tryOutputPdf(cwd: string, rel: string, found: Map<string, RunArtifactMeta>): void {
  const normalized = rel.replace(/\\/g, '/').trim();
  if (!normalized.toLowerCase().endsWith('.pdf')) return;
  const relative = normalized.includes('/') ? normalized : `output/${normalized}`;
  if (!relative.startsWith('output/')) return;
  try {
    const abs = path.join(cwd, relative);
    if (!existsSync(abs)) return;
    const stat = statSync(abs);
    if (!stat.isFile() || stat.size > MAX_ARTIFACT_BYTES) return;
    found.set(relative, metaForFile(cwd, relative, stat.size));
  } catch {
    // skip invalid paths
  }
}

/** Paths the agent mentioned in prose (fallback when register_artifact was skipped). */
export function inferArtifactsFromText(text: string, cwd: string): RunArtifactMeta[] {
  const found = new Map<string, RunArtifactMeta>();
  for (const raw of text.match(PDF_NAME_RE) ?? []) {
    tryOutputPdf(cwd, raw, found);
  }
  for (const m of text.matchAll(/[`'"]([^`'"]+\.pdf)[`'"]/gi)) {
    tryOutputPdf(cwd, m[1] ?? '', found);
  }
  return [...found.values()].slice(0, MAX_ARTIFACTS_PER_RUN);
}

/** Collect registered + newly written artifacts for a cursor_run turn. */
export function collectRunArtifacts(
  cwd: string,
  sinceMs: number,
): RunArtifactMeta[] {
  const found = new Map<string, RunArtifactMeta>();

  for (const rel of registeredPaths(cwd)) {
    try {
      const abs = path.join(cwd, rel);
      if (!existsSync(abs)) continue;
      const stat = statSync(abs);
      if (!stat.isFile() || stat.size > MAX_ARTIFACT_BYTES) continue;
      found.set(rel, metaForFile(cwd, rel, stat.size));
    } catch {
      // ignore invalid registered paths
    }
  }

  for (const dirName of ALLOWED_DIRS) {
    scanDirForArtifacts(cwd, dirName, sinceMs, found);
  }

  return [...found.values()].slice(0, MAX_ARTIFACTS_PER_RUN);
}

const ARTIFACTS_RE =
  /\n\n\[MEMGREP_ARTIFACTS\]([\s\S]*?)\[\/MEMGREP_ARTIFACTS\]\s*$/;

export function appendArtifactsToText(
  text: string,
  artifacts: RunArtifactMeta[],
): string {
  if (!artifacts.length) return text;
  return (
    text +
    `\n\n[MEMGREP_ARTIFACTS]${JSON.stringify({ artifacts })}[/MEMGREP_ARTIFACTS]`
  );
}

export function parseArtifactsFromText(text: string): {
  text: string;
  artifacts: RunArtifactMeta[];
} {
  const match = ARTIFACTS_RE.exec(text);
  if (!match) return { text, artifacts: [] };
  const stripped = text.slice(0, match.index).trimEnd();
  try {
    const parsed = JSON.parse(match[1]!) as { artifacts?: RunArtifactMeta[] };
    const artifacts = Array.isArray(parsed.artifacts) ? parsed.artifacts : [];
    return { text: stripped, artifacts };
  } catch {
    return { text: stripped, artifacts: [] };
  }
}
