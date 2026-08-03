import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import { createDocsEditorApp } from '../server.js';
import { DocsService } from '../service.js';
import {
  LIBREOFFICE_NOT_FOUND_MESSAGE,
  LibreOfficeNotFoundError,
  PdfConvertError,
  defaultRunCommand,
  docxToPdf,
  isLibreOfficeNotFound,
  resolveSoffice,
} from '../pdf.js';

const scratchDirs: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'memgrep-docs-pdf-'));
  scratchDirs.push(dir);
  return dir;
}

function seedFilledDoc(cwd: string, slug = 'demo', body = 'fake-docx'): string {
  mkdirSync(path.join(cwd, '.memgrep', 'docs'), { recursive: true });
  mkdirSync(path.join(cwd, '.memgrep', 'templates'), { recursive: true });
  const docxPath = path.join(cwd, '.memgrep', 'docs', `${slug}.docx`);
  writeFileSync(docxPath, body);
  writeFileSync(
    path.join(cwd, '.memgrep', 'docs', `${slug}.context.json`),
    JSON.stringify({
      version: 1,
      template: 't.docx',
      context: {},
      fields: [],
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01',
    }),
  );
  return docxPath;
}

afterEach(() => {
  while (scratchDirs.length) {
    const dir = scratchDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('resolveSoffice', () => {
  it('returns null when nothing is on PATH or known locations', () => {
    expect(
      resolveSoffice({ PATH: '/nonexistent-memgrep-path-xyz' }, () => false),
    ).toBeNull();
  });

  it('ignores blank MEMGREP_SOFFICE and keeps searching PATH', () => {
    const found = resolveSoffice(
      { PATH: '/opt/lo/bin', MEMGREP_SOFFICE: '   ' },
      (p) => p === path.join('/opt/lo/bin', 'soffice'),
    );
    expect(found).toBe(path.join('/opt/lo/bin', 'soffice'));
  });

  it('prefers MEMGREP_SOFFICE when the file exists', () => {
    const found = resolveSoffice(
      { PATH: '/opt/lo/bin', MEMGREP_SOFFICE: '/custom/soffice' },
      (p) => p === '/custom/soffice' || p === path.join('/opt/lo/bin', 'soffice'),
    );
    expect(found).toBe('/custom/soffice');
  });

  it('finds soffice on PATH and skips empty PATH segments', () => {
    const found = resolveSoffice(
      { PATH: path.delimiter + '/opt/lo/bin' + path.delimiter },
      (p) => p === path.join('/opt/lo/bin', 'soffice'),
    );
    expect(found).toBe(path.join('/opt/lo/bin', 'soffice'));
  });

  it('falls back to macOS app bundle path on darwin', () => {
    if (process.platform !== 'darwin') return;
    const mac = '/Applications/LibreOffice.app/Contents/MacOS/soffice';
    const found = resolveSoffice({ PATH: '' }, (p) => p === mac);
    expect(found).toBe(mac);
  });
});

describe('LibreOfficeNotFoundError / isLibreOfficeNotFound', () => {
  it('uses the default install hint message and code', () => {
    const err = new LibreOfficeNotFoundError();
    expect(err.message).toBe(LIBREOFFICE_NOT_FOUND_MESSAGE);
    expect(err.code).toBe('LIBREOFFICE_NOT_FOUND');
    expect(err.name).toBe('LibreOfficeNotFoundError');
    expect(isLibreOfficeNotFound(err)).toBe(true);
  });

  it('detects duck-typed errors with the same code', () => {
    const err = Object.assign(new Error('missing lo'), { code: 'LIBREOFFICE_NOT_FOUND' });
    expect(isLibreOfficeNotFound(err)).toBe(true);
    expect(isLibreOfficeNotFound(new PdfConvertError('nope'))).toBe(false);
    expect(isLibreOfficeNotFound('string')).toBe(false);
  });
});

describe('defaultRunCommand', () => {
  it('captures stdout from a successful process', async () => {
    const result = await defaultRunCommand(
      process.execPath,
      ['-e', "process.stdout.write('hello-pdf')"],
      { timeoutMs: 10_000 },
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('hello-pdf');
    expect(result.timedOut).toBeFalsy();
  });

  it('captures non-zero exit codes and stderr', async () => {
    const result = await defaultRunCommand(
      process.execPath,
      ['-e', "process.stderr.write('boom'); process.exit(7)"],
      { timeoutMs: 10_000 },
    );
    expect(result.code).toBe(7);
    expect(result.stderr).toBe('boom');
  });

  it('times out and marks timedOut', async () => {
    const result = await defaultRunCommand(
      process.execPath,
      ['-e', 'setTimeout(() => {}, 60_000)'],
      { timeoutMs: 200 },
    );
    expect(result.timedOut).toBe(true);
    expect(result.code).toBeNull();
  });

  it('returns an error when the binary cannot be spawned', async () => {
    const result = await defaultRunCommand('/nonexistent/memgrep-soffice-xyz', [], {
      timeoutMs: 5_000,
    });
    expect(result.code).toBeNull();
    expect(result.stderr.length).toBeGreaterThan(0);
  });
});

describe('docxToPdf', () => {
  it('throws LibreOfficeNotFoundError when soffice is missing', async () => {
    await expect(
      docxToPdf('/tmp/missing.docx', { resolveSoffice: () => null }),
    ).rejects.toBeInstanceOf(LibreOfficeNotFoundError);
  });

  it('throws PdfConvertError when the docx path does not exist', async () => {
    await expect(
      docxToPdf(path.join(scratch(), 'absent.docx'), {
        resolveSoffice: () => '/usr/bin/soffice',
      }),
    ).rejects.toMatchObject({
      name: 'PdfConvertError',
      message: expect.stringMatching(/Docx not found/),
    });
  });

  it('runs headless convert args and returns PDF bytes', async () => {
    const dir = scratch();
    const docxPath = path.join(dir, 'sample.docx');
    writeFileSync(docxPath, 'fake-docx');

    const calls: Array<{ command: string; args: string[]; timeoutMs: number }> = [];
    const pdfBytes = Buffer.from('%PDF-1.4 mock');
    let cleaned: string | undefined;

    const buffer = await docxToPdf(docxPath, {
      resolveSoffice: () => '/usr/bin/soffice',
      timeoutMs: 12_000,
      runCommand: async (command, args, options) => {
        calls.push({ command, args, timeoutMs: options.timeoutMs });
        return { code: 0, stdout: '', stderr: '' };
      },
      mkdtemp: (prefix) => {
        const out = mkdtempSync(prefix);
        scratchDirs.push(out);
        return out;
      },
      readFile: (pdfPath) => {
        expect(pdfPath.endsWith(`${path.sep}sample.pdf`)).toBe(true);
        return pdfBytes;
      },
      rm: (outDir) => {
        cleaned = outDir;
      },
    });

    expect(buffer.equals(pdfBytes)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe('/usr/bin/soffice');
    expect(calls[0]!.timeoutMs).toBe(12_000);
    expect(calls[0]!.args.slice(0, 5)).toEqual([
      '--headless',
      '--norestore',
      '--convert-to',
      'pdf',
      '--outdir',
    ]);
    expect(calls[0]!.args[5]).toBeTruthy();
    expect(calls[0]!.args[6]).toBe(docxPath);
    expect(cleaned).toBe(calls[0]!.args[5]);
  });

  it('throws on LibreOffice timeout and still cleans the temp dir', async () => {
    const dir = scratch();
    const docxPath = path.join(dir, 'sample.docx');
    writeFileSync(docxPath, 'fake');
    let cleaned = false;

    await expect(
      docxToPdf(docxPath, {
        resolveSoffice: () => '/usr/bin/soffice',
        timeoutMs: 1000,
        runCommand: async () => ({ code: null, stdout: '', stderr: '', timedOut: true }),
        mkdtemp: () => path.join(dir, 'out'),
        rm: () => {
          cleaned = true;
        },
      }),
    ).rejects.toMatchObject({
      name: 'PdfConvertError',
      message: expect.stringMatching(/timed out after 1000ms/),
    });
    expect(cleaned).toBe(true);
  });

  it('includes stderr/stdout when convert exits non-zero', async () => {
    const dir = scratch();
    const docxPath = path.join(dir, 'sample.docx');
    writeFileSync(docxPath, 'fake');

    await expect(
      docxToPdf(docxPath, {
        resolveSoffice: () => '/usr/bin/soffice',
        runCommand: async () => ({
          code: 1,
          stdout: 'stdout-hint',
          stderr: 'stderr-hint',
        }),
        mkdtemp: () => path.join(dir, 'out'),
        rm: () => undefined,
      }),
    ).rejects.toMatchObject({
      name: 'PdfConvertError',
      message: expect.stringMatching(/exit 1[\s\S]*stderr-hint[\s\S]*stdout-hint/),
    });
  });

  it('throws a generic message when convert fails with empty output', async () => {
    const dir = scratch();
    const docxPath = path.join(dir, 'sample.docx');
    writeFileSync(docxPath, 'fake');

    await expect(
      docxToPdf(docxPath, {
        resolveSoffice: () => '/usr/bin/soffice',
        runCommand: async () => ({ code: 2, stdout: '', stderr: '' }),
        mkdtemp: () => path.join(dir, 'out'),
        rm: () => undefined,
      }),
    ).rejects.toMatchObject({
      message: 'LibreOffice convert failed (exit 2)',
    });
  });

  it('throws when LibreOffice exits 0 but the PDF file is missing', async () => {
    const dir = scratch();
    const docxPath = path.join(dir, 'sample.docx');
    writeFileSync(docxPath, 'fake');

    await expect(
      docxToPdf(docxPath, {
        resolveSoffice: () => '/usr/bin/soffice',
        runCommand: async () => ({ code: 0, stdout: '', stderr: '' }),
        mkdtemp: () => path.join(dir, 'out'),
        readFile: () => {
          throw new Error('ENOENT');
        },
        rm: () => undefined,
      }),
    ).rejects.toMatchObject({
      name: 'PdfConvertError',
      message: expect.stringMatching(/PDF missing/),
    });
  });

  it('ignores cleanup failures in finally', async () => {
    const dir = scratch();
    const docxPath = path.join(dir, 'sample.docx');
    writeFileSync(docxPath, 'fake');

    const buffer = await docxToPdf(docxPath, {
      resolveSoffice: () => '/usr/bin/soffice',
      runCommand: async () => ({ code: 0, stdout: '', stderr: '' }),
      mkdtemp: () => path.join(dir, 'out'),
      readFile: () => Buffer.from('pdf'),
      rm: () => {
        throw new Error('cleanup failed');
      },
    });
    expect(buffer.toString()).toBe('pdf');
  });
});

describe('DocsService readDocx / exportPdf', () => {
  it('resolveDocxPath and readDocx return the filled file', () => {
    const dir = scratch();
    seedFilledDoc(dir, 'sprint', 'DOCX-BYTES');
    const service = new DocsService(dir);

    const resolved = service.resolveDocxPath('sprint');
    expect(resolved.endsWith(`${path.sep}sprint.docx`)).toBe(true);

    const file = service.readDocx('sprint');
    expect(file.slug).toBe('sprint');
    expect(file.filename).toBe('sprint.docx');
    expect(file.buffer.toString()).toBe('DOCX-BYTES');
  });

  it('resolveDocxPath throws when the docx is missing', () => {
    const dir = scratch();
    mkdirSync(path.join(dir, '.memgrep', 'docs'), { recursive: true });
    const service = new DocsService(dir);
    expect(() => service.resolveDocxPath('missing')).toThrow(/Docx missing/);
  });

  it('exportPdf wraps docxToPdf with slug and filename', async () => {
    const dir = scratch();
    const docxPath = seedFilledDoc(dir, 'minutes');
    const service = new DocsService(dir);
    const pdf = Buffer.from('%PDF-minutes');

    const result = await service.exportPdf('minutes', {
      resolveSoffice: () => '/usr/bin/soffice',
      runCommand: async () => ({ code: 0, stdout: '', stderr: '' }),
      mkdtemp: () => path.join(dir, 'pdf-out'),
      readFile: () => pdf,
      rm: () => undefined,
    });

    expect(result.slug).toBe('minutes');
    expect(result.filename).toBe('minutes.pdf');
    expect(result.docxPath).toBe(docxPath);
    expect(result.buffer.equals(pdf)).toBe(true);
  });
});

describe('docs editor download routes', () => {
  it('returns 404 for missing docx download', async () => {
    const dir = scratch();
    mkdirSync(path.join(dir, '.memgrep', 'docs'), { recursive: true });
    mkdirSync(path.join(dir, '.memgrep', 'templates'), { recursive: true });
    const app = createDocsEditorApp(new DocsService(dir));

    const res = await request(app, 'GET', '/api/doc/nope/docx');
    expect(res.status).toBe(404);
    expect(res.json?.error).toMatch(/missing|not found/i);
  });

  it('streams a filled docx with attachment headers', async () => {
    const dir = scratch();
    seedFilledDoc(dir, 'demo', 'hello-docx');
    const app = createDocsEditorApp(new DocsService(dir));

    const res = await requestBinary(app, 'GET', '/api/doc/demo/docx');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/wordprocessingml/);
    expect(res.headers.get('content-disposition')).toMatch(/attachment; filename="demo\.docx"/);
    expect(res.body.toString()).toBe('hello-docx');
  });

  it('returns 503 when LibreOffice is missing for PDF', async () => {
    const dir = scratch();
    seedFilledDoc(dir, 'demo');
    const service = new DocsService(dir);
    const original = service.exportPdf.bind(service);
    service.exportPdf = async (name) => original(name, { resolveSoffice: () => null });

    const app = createDocsEditorApp(service);
    const res = await request(app, 'GET', '/api/doc/demo/pdf');
    expect(res.status).toBe(503);
    expect(res.json?.error).toMatch(/LibreOffice not found/i);
  });

  it('returns 404 when the filled docx is missing for PDF', async () => {
    const dir = scratch();
    mkdirSync(path.join(dir, '.memgrep', 'docs'), { recursive: true });
    const app = createDocsEditorApp(new DocsService(dir));
    const res = await request(app, 'GET', '/api/doc/ghost/pdf');
    expect(res.status).toBe(404);
    expect(res.json?.error).toMatch(/missing/i);
  });

  it('streams a PDF when convert succeeds', async () => {
    const dir = scratch();
    seedFilledDoc(dir, 'demo');
    const service = new DocsService(dir);
    const original = service.exportPdf.bind(service);
    service.exportPdf = async (name) =>
      original(name, {
        resolveSoffice: () => '/usr/bin/soffice',
        runCommand: async () => ({ code: 0, stdout: '', stderr: '' }),
        mkdtemp: () => path.join(dir, 'route-out'),
        readFile: () => Buffer.from('%PDF-route'),
        rm: () => undefined,
      });

    const app = createDocsEditorApp(service);
    const res = await requestBinary(app, 'GET', '/api/doc/demo/pdf');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/application\/pdf/);
    expect(res.headers.get('content-disposition')).toMatch(/attachment; filename="demo\.pdf"/);
    expect(res.body.toString()).toBe('%PDF-route');
  });

  it('returns 500 when convert fails for a reason other than missing LibreOffice', async () => {
    const dir = scratch();
    seedFilledDoc(dir, 'demo');
    const service = new DocsService(dir);
    const original = service.exportPdf.bind(service);
    service.exportPdf = async (name) =>
      original(name, {
        resolveSoffice: () => '/usr/bin/soffice',
        runCommand: async () => ({ code: 9, stdout: '', stderr: 'explode' }),
        mkdtemp: () => path.join(dir, 'fail-out'),
        rm: () => undefined,
      });

    const app = createDocsEditorApp(service);
    const res = await request(app, 'GET', '/api/doc/demo/pdf');
    expect(res.status).toBe(500);
    expect(res.json?.error).toMatch(/explode|convert failed/i);
  });
});

async function request(
  app: express.Express,
  method: string,
  url: string,
): Promise<{ status: number; json?: { error?: string } }> {
  const server = app.listen(0);
  try {
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no address');
    const res = await fetch(`http://127.0.0.1:${addr.port}${url}`, { method });
    const json = (await res.json()) as { error?: string };
    return { status: res.status, json };
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

async function requestBinary(
  app: express.Express,
  method: string,
  url: string,
): Promise<{ status: number; headers: Headers; body: Buffer }> {
  const server = app.listen(0);
  try {
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no address');
    const res = await fetch(`http://127.0.0.1:${addr.port}${url}`, { method });
    const body = Buffer.from(await res.arrayBuffer());
    return { status: res.status, headers: res.headers, body };
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}
