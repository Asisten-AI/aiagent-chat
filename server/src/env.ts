import { config } from 'dotenv';
config({ path: ['.env', '../.env'] });

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Env ${name} belum diisi (lihat .env.example)`);
  return v;
}

export const env = {
  DATABASE_URL: req('DATABASE_URL'),
  REDIS_URL: process.env.REDIS_URL ?? 'redis://localhost:6379',
  JWT_SECRET: req('JWT_SECRET'),
  ENCRYPTION_KEY: req('ENCRYPTION_KEY'),
  PORT: Number(process.env.PORT ?? 4000),
  WEB_ORIGIN: process.env.WEB_ORIGIN ?? 'http://localhost:5173',
  // 'docker' = satu container per run (VPS sendiri). 'process' = proses terisolasi per
  // user Linux di dalam container yang sama (untuk Render & PaaS tanpa akses Docker).
  AGENT_RUNNER: (process.env.AGENT_RUNNER ?? 'docker') as 'docker' | 'process',
  AGENT_DATA_DIR: process.env.AGENT_DATA_DIR ?? '/var/lib/ruang/agents',
  AGENT_IMAGE: process.env.AGENT_IMAGE ?? 'ruang-agent-runner:latest',
  AGENT_TIMEOUT_MS: Number(process.env.AGENT_TIMEOUT_MS ?? 600_000),
  AGENT_MAX_BUDGET_USD: process.env.AGENT_MAX_BUDGET_USD ?? '2',
  MAX_AGENT_DEPTH: Number(process.env.MAX_AGENT_DEPTH ?? 3),
  WORKER_CONCURRENCY: Number(process.env.WORKER_CONCURRENCY ?? 4),
  WEB_DIST: process.env.WEB_DIST,
  // Pendaftaran publik ditutup. Hanya email ini yang boleh membuat akun admin pertama.
  ADMIN_EMAIL: process.env.ADMIN_EMAIL?.toLowerCase(),
  // Folder login Codex (ChatGPT) bersama di server; sebaiknya di persistent disk.
  CODEX_SHARED_HOME: process.env.CODEX_SHARED_HOME ?? '/var/lib/ruang/codex-home',
  isProd: process.env.NODE_ENV === 'production',
};
