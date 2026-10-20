import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, chownSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { env } from './env';

/**
 * Login langganan ChatGPT untuk Codex disimpan sekali di server (CODEX_SHARED_HOME), dipakai
 * semua agent Codex. Semua run Codex-langganan jalan sebagai satu user Linux khusus agar bisa
 * membaca & memperbarui token di auth.json.
 */
export const CODEX_SHARED_UID = 150_000;
const isRoot = () => process.getuid?.() === 0;

export function ensureCodexHome() {
  mkdirSync(env.CODEX_SHARED_HOME, { recursive: true });
  if (isRoot()) { chownSync(env.CODEX_SHARED_HOME, CODEX_SHARED_UID, CODEX_SHARED_UID); chmodSync(env.CODEX_SHARED_HOME, 0o700); }
  return env.CODEX_SHARED_HOME;
}

export const codexLoggedIn = () => existsSync(join(env.CODEX_SHARED_HOME, 'auth.json'));

let login: { child: ChildProcess; output: string; status: 'running' | 'success' | 'failed' } | null = null;
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');

export function startCodexLogin() {
  if (login?.status === 'running') return;
  const home = ensureCodexHome();
  const child = spawn('codex', ['login', '--device-auth'], {
    ...(isRoot() ? { uid: CODEX_SHARED_UID, gid: CODEX_SHARED_UID } : {}),
    env: { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', HOME: home, CODEX_HOME: home, LANG: 'C.UTF-8', NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const state = { child, output: '', status: 'running' as 'running' | 'success' | 'failed' };
  login = state;
  const add = (c: Buffer) => { state.output = (state.output + stripAnsi(c.toString())).slice(-4000); };
  child.stdout?.on('data', add);
  child.stderr?.on('data', add);
  child.on('error', (e) => { state.output += `\n${e.message}`; state.status = 'failed'; });
  child.on('close', (code) => { if (state.status === 'running') state.status = code === 0 && codexLoggedIn() ? 'success' : 'failed'; });
  setTimeout(() => { if (state.status === 'running') child.kill(); }, 15 * 60_000);
}

export function codexLogout() {
  if (login?.status === 'running') login.child.kill();
  login = null;
  rmSync(join(env.CODEX_SHARED_HOME, 'auth.json'), { force: true });
}

export function codexLoginState() {
  return {
    loggedIn: codexLoggedIn(),
    supported: env.AGENT_RUNNER === 'process',
    login: login ? { status: login.status, output: login.output } : null,
  };
}
