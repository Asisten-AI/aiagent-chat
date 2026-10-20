import type { Activity } from '../db';

/** State yang dibangun dari stream JSONL CLI agent. */
export type RunState = {
  text: string;
  activity: Activity[];
  sessionId?: string;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  error?: string;
};

const short = (s: unknown, n = 160) => {
  const str = typeof s === 'string' ? s : JSON.stringify(s);
  return str && str.length > n ? `${str.slice(0, n)}…` : str;
};

function describeClaudeTool(name: string, input: Record<string, unknown>): Activity {
  if (name === 'Bash') return { kind: 'command', label: 'Menjalankan perintah', detail: short(input.command) };
  if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(name)) return { kind: 'file', label: 'Mengubah file', detail: short(input.file_path) };
  if (name === 'Read') return { kind: 'file', label: 'Membaca file', detail: short(input.file_path) };
  if (name === 'Grep' || name === 'Glob') return { kind: 'tool', label: 'Mencari', detail: short(input.pattern) };
  if (name === 'WebFetch' || name === 'WebSearch') return { kind: 'tool', label: 'Membuka web', detail: short(input.url ?? input.query) };
  return { kind: 'tool', label: name, detail: short(input) };
}

/** Claude Code: `--output-format stream-json --verbose` */
export function applyClaudeEvent(s: RunState, ev: any) {
  if (ev.type === 'system' && ev.subtype === 'init') s.sessionId = ev.session_id;
  if (ev.type === 'assistant') {
    for (const block of ev.message?.content ?? []) {
      if (block.type === 'text' && block.text) s.text += (s.text ? '\n\n' : '') + block.text;
      if (block.type === 'tool_use') s.activity.push(describeClaudeTool(block.name, block.input ?? {}));
    }
  }
  if (ev.type === 'result') {
    s.sessionId = ev.session_id ?? s.sessionId;
    if (typeof ev.result === 'string' && ev.result.trim()) s.text = ev.result; // jawaban final
    s.costUsd = ev.total_cost_usd;
    s.inputTokens = (ev.usage?.input_tokens ?? 0) + (ev.usage?.cache_read_input_tokens ?? 0) + (ev.usage?.cache_creation_input_tokens ?? 0);
    s.outputTokens = ev.usage?.output_tokens;
    if (ev.is_error) s.error = typeof ev.result === 'string' ? ev.result : `Run berakhir dengan status ${ev.subtype}`;
  }
}

/** Codex: `codex exec --json` */
export function applyCodexEvent(s: RunState, ev: any) {
  if (ev.type === 'thread.started') s.sessionId = ev.thread_id;
  if (ev.type === 'item.completed') {
    const it = ev.item ?? {};
    if (it.type === 'agent_message' && it.text) s.text += (s.text ? '\n\n' : '') + it.text;
    if (it.type === 'command_execution') s.activity.push({ kind: 'command', label: 'Menjalankan perintah', detail: short(it.command) });
    if (it.type === 'file_change') {
      for (const c of it.changes ?? []) s.activity.push({ kind: 'file', label: 'Mengubah file', detail: short(c.path) });
    }
    if (it.type === 'web_search') s.activity.push({ kind: 'tool', label: 'Mencari di web', detail: short(it.query) });
    if (it.type === 'error') s.activity.push({ kind: 'note', label: 'Peringatan', detail: short(it.message) });
  }
  if (ev.type === 'turn.completed') {
    s.inputTokens = ev.usage?.input_tokens;
    s.outputTokens = ev.usage?.output_tokens;
  }
  if (ev.type === 'turn.failed') s.error = ev.error?.message ?? 'Codex gagal menyelesaikan tugas';
  if (ev.type === 'error') s.error = ev.message ?? 'Codex error';
}
