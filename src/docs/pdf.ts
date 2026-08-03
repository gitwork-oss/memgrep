import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const LIBREOFFICE_NOT_FOUND_MESSAGE =
  'LibreOffice not found. Install it (e.g. brew install --cask libreoffice) and retry.';

export class LibreOfficeNotFoundError extends Error {
  readonly code = 'LIBREOFFICE_NOT_FOUND' as const;

  constructor(message = LIBREOFFICE_NOT_FOUND_MESSAGE) {
    super(message);
    this.name = 'LibreOfficeNotFoundError';
  }
}

export class PdfConvertError extends Error {
  readonly code = 'PDF_CONVERT_FAILED' as const;

  constructor(message: string) {
    super(message);
    this.name = 'PdfConvertError';
  }
}

const MAC_SOFFICE = '/Applications/LibreOffice.app/Contents/MacOS/soffice';
const DEFAULT_TIMEOUT_MS = 60_000;

export type RunCommandResult = {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
};

export type RunCommand = (
  command: string,
  args: string[],
  options: { timeoutMs: number },
) => Promise<RunCommandResult>;

export type DocxToPdfDeps = {
  resolveSoffice?: () => string | null;
  runCommand?: RunCommand;
  mkdtemp?: (prefix: string) => string;
  readFile?: (filePath: string) => Buffer;
  rm?: (dir: string) => void;
  timeoutMs?: number;
};

/** Locate LibreOffice `soffice` on PATH or the macOS app bundle. */
export function resolveSoffice(
  env: NodeJS.ProcessEnv = process.env,
  fileExists: (p: string) => boolean = existsSync,
): string | null {
  const fromEnv = env.MEMGREP_SOFFICE?.trim();
  if (fromEnv && fileExists(fromEnv)) return fromEnv;

  const pathEnv = env.PATH ?? '';
  const binary = process.platform === 'win32' ? 'soffice.exe' : 'soffice';
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, binary);
    if (fileExists(candidate)) return candidate;
  }

  if (process.platform === 'darwin' && fileExists(MAC_SOFFICE)) {
    return MAC_SOFFICE;
  }

  return null;
}

export function defaultRunCommand(
  command: string,
  args: string[],
  options: { timeoutMs: number },
): Promise<RunCommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: process.env,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result: RunCommandResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ code: null, stdout, stderr, timedOut: true });
    }, options.timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => {
      finish({ code: null, stdout, stderr: stderr || err.message });
    });
    child.on('close', (code) => {
      finish({ code, stdout, stderr });
    });
  });
}

/**
 * Convert a .docx to PDF via LibreOffice headless.
 * Writes into a temp directory and returns the PDF bytes.
 */
export async function docxToPdf(docxPath: string, deps: DocxToPdfDeps = {}): Promise<Buffer> {
  const resolve = deps.resolveSoffice ?? (() => resolveSoffice());
  const runCommand = deps.runCommand ?? defaultRunCommand;
  const mkdtemp = deps.mkdtemp ?? ((prefix) => mkdtempSync(prefix));
  const readFile = deps.readFile ?? ((p) => readFileSync(p));
  const rm = deps.rm ?? ((dir) => rmSync(dir, { recursive: true, force: true }));
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const soffice = resolve();
  if (!soffice) {
    throw new LibreOfficeNotFoundError();
  }
  if (!existsSync(docxPath)) {
    throw new PdfConvertError(`Docx not found: ${docxPath}`);
  }

  const outDir = mkdtemp(path.join(tmpdir(), 'memgrep-docs-pdf-'));
  const baseName = path.basename(docxPath, path.extname(docxPath));
  const pdfPath = path.join(outDir, `${baseName}.pdf`);

  try {
    const result = await runCommand(
      soffice,
      ['--headless', '--norestore', '--convert-to', 'pdf', '--outdir', outDir, docxPath],
      { timeoutMs },
    );

    if (result.timedOut) {
      throw new PdfConvertError(`LibreOffice timed out after ${timeoutMs}ms`);
    }
    if (result.code !== 0) {
      const detail = [result.stderr, result.stdout].filter(Boolean).join('\n').trim();
      throw new PdfConvertError(
        detail
          ? `LibreOffice convert failed (exit ${result.code}): ${detail}`
          : `LibreOffice convert failed (exit ${result.code})`,
      );
    }
    try {
      return readFile(pdfPath);
    } catch {
      throw new PdfConvertError(`LibreOffice finished but PDF missing at ${pdfPath}`);
    }
  } finally {
    try {
      rm(outDir);
    } catch {
      // ignore cleanup errors
    }
  }
}

export function isLibreOfficeNotFound(error: unknown): boolean {
  return (
    error instanceof LibreOfficeNotFoundError ||
    (error instanceof Error &&
      (error as Error & { code?: string }).code === 'LIBREOFFICE_NOT_FOUND')
  );
}
