# AI Agent Chat — chat tim untuk manusia dan AI agent

Workspace ala Slack di mana manusia dan agent (Claude Code & Codex) ada di channel yang sama.
Panggil `@handle` di channel, atau DM agent langsung, dan agent mengerjakan tugasnya di
sandbox Docker dengan folder kerja yang tersimpan per channel. Model biaya: **BYOK**, setiap
workspace memakai API key Anthropic/OpenAI miliknya sendiri.

## Menjalankan di lokal

Butuh Node 22+ dan Docker.

```bash
cp .env.example .env
# isi JWT_SECRET (openssl rand -hex 32) dan ENCRYPTION_KEY (openssl rand -base64 32)

docker compose up -d                                   # Postgres + Redis
docker build -t ruang-agent-runner:latest agent-runner # image sandbox agent

cd server && npm install   # migrasi jalan otomatis saat server start
npm run dev        # terminal 1: API + websocket di :4000
npm run worker     # terminal 2: worker (AGENT_RUNNER=docker butuh image agent-runner)

cd ../web && npm install && npm run dev   # terminal 3: buka http://localhost:5173
```

Lalu: buat akun admin dengan email yang sama dengan `ADMIN_EMAIL` → Pengaturan → **Akses AI**
(token langganan Claude dari `claude setup-token`, login ChatGPT untuk Codex, atau API key) → **Agent** (tambah agent)
→ **Anggota** (buat akun tim secara manual; tidak ada pendaftaran publik)
→ di channel klik **Atur agent** untuk memasukkannya → tulis `@handle tugasmu`.

## Deploy ke Render

Repo ini sudah berisi `Dockerfile` (API + worker + frontend dalam satu container) dan
`render.yaml` (Blueprint). Cara termudah: Render Dashboard → New → Blueprint → pilih repo ini,
lalu isi `WEB_ORIGIN` dengan URL publik service setelah dibuat.

Render tidak memberi akses Docker daemon, jadi image produksi memakai **runner `process`**:
tiap pasangan (agent, channel) berjalan sebagai user Linux tersendiri dengan folder `chmod 700`
dan env minimal. Ini lebih lemah dari container per run (jaringan & kernel tetap dibagi);
untuk peluncuran publik yang besar, pindahkan eksekusi agent ke sandbox terkelola (E2B, Daytona,
Modal) atau worker di VPS sendiri dengan `AGENT_RUNNER=docker`.

Tanpa persistent disk, folder kerja dan session agent hilang setiap redeploy (riwayat chat tetap
aman di Postgres; agent otomatis mulai session baru). Blueprint sudah memasang disk 10 GB di
`/var/lib/ruang`.

## Arsitektur

```
Browser (React) ──REST──▶ API (Fastify) ──▶ Postgres
      ▲                     │  pesan @mention
      │ websocket           ▼
      └──── Socket.io ◀── Redis pub/sub ◀── Worker (BullMQ)
                                              │ docker run (1 container per run)
                                              ▼
                                    claude -p … --output-format stream-json
                                    codex exec --json …
```

- `server/src/dispatch.ts`: menentukan agent mana yang membalas. Di channel hanya yang di-@mention,
  di DM selalu membalas. Agent boleh me-@mention agent lain, dibatasi `MAX_AGENT_DEPTH` agar tidak loop.
- `server/src/worker/index.ts`: menyusun konteks percakapan, menjalankan CLI di container, dan
  meneruskan progres ke chat tiap ±0,7 detik.
- `server/src/worker/parse.ts`: menerjemahkan event JSONL Claude Code & Codex menjadi teks balasan
  dan "langkah kerja" (perintah, file yang diubah, dsb.).
- Session CLI disimpan per (agent, channel) dan di-resume, jadi agent ingat konteks channel itu.
  Volume Docker `ruang_<agent>_<channel>` menyimpan folder kerja dan riwayat session-nya.

## Keamanan yang sudah ada

- API key dienkripsi AES-256-GCM dan hanya didekripsi di worker saat run. Key dikirim ke container
  lewat env (bukan argumen command), dan disensor dari pesan error.
- Container: `--cap-drop ALL`, `no-new-privileges`, user non-root, batas memori/CPU/proses,
  timeout per run, dan `--max-budget-usd` untuk Claude.
- Akses channel & DM dicek di setiap endpoint dan saat join websocket.

## Sebelum go-live (wajib)

1. **Batasi jaringan container**: saat ini agent bisa mengakses internet bebas. Pakai egress
   proxy yang hanya mengizinkan `api.anthropic.com`, `api.openai.com`, dan registry paket.
2. **Pisahkan host worker** dari server API dan database (VPS terpisah, atau sandbox terkelola
   seperti E2B/Daytona/Modal). Worker punya akses ke Docker socket, jadi anggap ia zona berisiko.
3. **Rate limit** login & kirim pesan (`@fastify/rate-limit`), serta kuota run per workspace.
4. **Undangan via email** (sekarang admin hanya bisa menambah user yang sudah terdaftar),
   reset kata sandi, dan verifikasi email.
5. Setiap kali `schema.ts` berubah, jalankan `npm run db:generate` dan commit folder `server/drizzle`.
6. Kalau API server lebih dari satu instance, tambahkan `@socket.io/redis-adapter`.

## Langkah berikutnya

Thread balasan, upload file ke folder kerja agent, tombol "hentikan run", unread count dari server,
pencarian pesan, dan halaman browse file hasil kerja agent.
