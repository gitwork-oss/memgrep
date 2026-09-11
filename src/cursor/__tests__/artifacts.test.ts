import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  appendArtifactsToText,
  collectRunArtifacts,
  normalizeArtifactPath,
  parseArtifactsFromText,
  readWorkspaceArtifact,
  registerArtifactPath,
} from '../artifacts.js';

const dirs: string[] = [];

function tempCwd(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'memgrep-artifacts-'));
  dirs.push(dir);
  mkdirSync(path.join(dir, 'output'), { recursive: true });
  return dir;
}

afterEach(() => {
  while (dirs.length) {
    rmSync(dirs.pop()!, { recursive: true, force: true });
  }
});

describe('artifacts', () => {
  it('normalizes output pdf paths', () => {
    const cwd = tempCwd();
    const rel = normalizeArtifactPath(cwd, 'output/cv.pdf');
    expect(rel).toBe('output/cv.pdf');
  });

  it('rejects path traversal', () => {
    const cwd = tempCwd();
    expect(() => normalizeArtifactPath(cwd, '../etc/passwd')).toThrow();
  });

  it('collects registered and new pdfs', () => {
    const cwd = tempCwd();
    const pdf = path.join(cwd, 'output', 'cv.pdf');
    writeFileSync(pdf, '%PDF-1.4 test');
    registerArtifactPath(cwd, 'output/cv.pdf');
    const since = Date.now() - 1000;
    const artifacts = collectRunArtifacts(cwd, since);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.name).toBe('cv.pdf');
  });

  it('round-trips artifact marker in text', () => {
    const artifacts = [
      {
        path: 'output/cv.pdf',
        name: 'cv.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 10,
      },
    ];
    const wrapped = appendArtifactsToText('hello', artifacts);
    const parsed = parseArtifactsFromText(wrapped);
    expect(parsed.text).toBe('hello');
    expect(parsed.artifacts).toEqual(artifacts);
  });

  it('reads workspace pdf bytes', () => {
    const cwd = tempCwd();
    writeFileSync(path.join(cwd, 'output', 'x.pdf'), 'pdf-bytes');
    const buf = readWorkspaceArtifact(cwd, 'output/x.pdf');
    expect(buf.toString()).toBe('pdf-bytes');
  });
});
