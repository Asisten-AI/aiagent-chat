import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, chownSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { env } from '../env';
import { CODEX_SHARED_UID, ensureCodexHome } from '../subscription';

export type RunSpec = {
  runId: string;
  agentId: string;
  channelId: string;
  args: string[];          // perintah CLI, mis. ['claude', '-p', ...]
  secrets: Record<string, string>; // env berisi API key / token langganan
  codexShared?: boolean;            // pakai login ChatGPT bersama (CODEX_SHARED_HOME)
};

export type Started = { child: ChildProcess; kill: () => void; redact: (s: string) => string };

/** Docker: satu container per run. Butuh akses Docker daemon (VPS sendiri). */
function startDocker(spec: RunSpec): Started {
  if (spec.codexShared) throw new Error('Login ChatGPT untuk Codex baru didukung di runner "process". Pakai API key OpenAI untuk mode docker.');
  const name = `ruang-run-${spec.runId}`;
  const volume = `ruang_${spec.agentId}_${spec.channelId}`.replace(/-/g, '');
  const keys = Object.keys(spec.secrets);
  const child = spawn('docker', [
    'run', '--rm', '--name', name,
    '--memory', '2g', '--cpus', '1', '--pids-limit', '256',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '-v', `${volume}:/home/agent`, '-w', '/home/agent/work',
    ...keys.flatMap((k) => ['-e', k]), // nilai diambil dari env, tidak muncul di `ps`
    env.AGENT_IMAGE, ...spec.args,
  ], { env: { ...process.env, ...spec.secrets }, stdio: ['ignore', 'pipe', 'pipe'] });
  return { child, kill: () => { spawn('docker', ['kill', name]); }, redact: redactor(spec.secrets) };
}

/**
 * Process: tiap pasangan (agent, channel) jalan sebagai user Linux tersendiri, dengan
 * HOME & folder kerja chmod 700 dan env minimal (tanpa secret server). Proses lain tidak
 * bisa membaca file atau /proc/<pid>/environ milik uid berbeda. Lebih lemah dari container
 * per run (jaringan & kernel tetap dibagi), tapi bisa jalan di Render.
 */
function startProcess(spec: RunSpec): Started {
  const slot = `${spec.agentId}_${spec.channelId}`;
  const home = join(env.AGENT_DATA_DIR, slot);
  // Codex-langganan memakai satu user khusus supaya bisa membaca & memperbarui auth.json bersama.
  const uid = spec.codexShared ? CODEX_SHARED_UID
    : 200_000 + (createHash('sha256').update(slot).digest().readUInt32BE(0) % 1_000_000_000);
  const isRoot = process.getuid?.() === 0;
  if (!isRoot && process.env.AGENT_ALLOW_SHARED_UID !== 'true') {
    throw new Error('Runner "process" harus berjalan sebagai root agar tiap agent mendapat user Linux sendiri');
  }
  const fresh = !existsSync(home);
  for (const d of [home, join(home, 'work'), join(home, 'tmp')]) mkdirSync(d, { recursive: true });
  if (isRoot) {
    // Pemilik folder bisa berubah kalau agent pindah dari API key ke langganan (atau sebaliknya).
    if (!fresh && statSync(home).uid !== uid) spawnSync('chown', ['-R', `${uid}:${uid}`, home]);
    for (const d of [home, join(home, 'work'), join(home, 'tmp')]) { chownSync(d, uid, uid); chmodSync(d, 0o700); }
  }
  const codexHome = spec.codexShared ? ensureCodexHome() : undefined;
  chmodSync(env.AGENT_DATA_DIR, 0o711); // boleh masuk, tidak boleh melihat isi daftar folder

  const child = spawn(spec.args[0], spec.args.slice(1), {
    cwd: join(home, 'work'),
    ...(isRoot ? { uid, gid: uid } : {}),
    detached: true, // grup proses sendiri supaya bisa dihentikan seluruhnya
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
      HOME: home,
      TMPDIR: join(home, 'tmp'),
      LANG: 'C.UTF-8',
      ...(codexHome ? { CODEX_HOME: codexHome } : {}),
      ...spec.secrets,
    },
  });
  const kill = () => { try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch { /* sudah berhenti */ } };
  return { child, kill, redact: redactor(spec.secrets) };
}

function redactor(secrets: Record<string, string>) {
  const values = [...new Set(Object.values(secrets))].filter(Boolean);
  return (s: string) => values.reduce((acc, v) => acc.split(v).join('***'), s);
}

export function startRun(spec: RunSpec): Started {
  return env.AGENT_RUNNER === 'process' ? startProcess(spec) : startDocker(spec);
}
