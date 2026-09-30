import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { ChatInput } from '../store.js';
import { cleanUserText, makeTitle, type TranscriptSource } from './types.js';

interface CopilotEvent {
  type?: string;
  timestamp?: string;
  data?: {
    content?: unknown;
    startTime?: string;
    context?: { cwd?: string };
    parentToolCallId?: string;
  };
}

/**
 * GitHub Copilot CLI stores one event log per session at:
 *   ~/.copilot/session-state/<session-id>/events.jsonl
 * alongside workspace.yaml (cwd, user-assigned name). Sessions that never
 * received a message have no events.jsonl and are skipped.
 */
export function copilotSource(sessionsDir?: string): TranscriptSource {
  const root =
    sessionsDir ??
    path.join(process.env.COPILOT_HOME ?? path.join(homedir(), '.copilot'), 'session-state');
  return {
    name: 'copilot',
    async *scan(): AsyncGenerator<ChatInput> {
      const sessions = await readdir(root, { withFileTypes: true }).catch(() => []);
      for (const session of sessions) {
        if (!session.isDirectory()) continue;
        const dir = path.join(root, session.name);
        const file = path.join(dir, 'events.jsonl');
        const raw = await readFile(file, 'utf8').catch(() => null);
        if (!raw) continue;
        const parsed = parseCopilotEvents(raw);
        if (!parsed) continue;
        const meta = parseWorkspaceYaml(await readFile(path.join(dir, 'workspace.yaml'), 'utf8').catch(() => ''));
        const cwd = meta.cwd ?? parsed.cwd;
        const info = await stat(file);
        yield {
          title: (meta.user_named === 'true' && meta.name) || parsed.title,
          project: cwd ? path.basename(cwd) : session.name,
          content: parsed.content,
          source: file,
          tool: 'copilot',
          createdAt: parsed.createdAt ?? meta.created_at,
          modifiedAt: info.mtime.toISOString(),
        };
      }
    },
  };
}

export function parseCopilotEvents(
  raw: string,
): { title: string; content: string; cwd?: string; createdAt?: string } | null {
  const turns: string[] = [];
  let title = '';
  let cwd: string | undefined;
  let createdAt: string | undefined;

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let obj: CopilotEvent;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const data = obj.data;
    if (!data) continue;
    if (obj.type === 'session.start') {
      cwd ??= data.context?.cwd;
      createdAt ??= data.startTime;
      continue;
    }
    // Sub-agent chatter is tagged with the spawning tool call; keep the main thread only.
    if (data.parentToolCallId) continue;
    if (typeof data.content !== 'string') continue;
    const text = data.content.trim();
    if (!text) continue; // assistant turns that are pure tool calls
    if (obj.type === 'user.message') {
      const query = cleanUserText(text);
      if (!query) continue;
      if (!title && query.length > 3) title = makeTitle(query);
      turns.push(`User: ${query}`);
    } else if (obj.type === 'assistant.message') {
      turns.push(`Assistant: ${text}`);
    }
  }

  if (turns.length === 0) return null;
  return { title: title || makeTitle(turns[0]), content: turns.join('\n\n'), cwd, createdAt };
}

/** workspace.yaml is flat `key: value`; avoid pulling in a YAML dependency. */
function parseWorkspaceYaml(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const m = line.match(/^(\w+):\s*(.*)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}
