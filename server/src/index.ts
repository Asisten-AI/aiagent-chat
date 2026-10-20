import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { fileURLToPath } from 'node:url';
import { db } from './db';
import { Server } from 'socket.io';
import { parse as parseCookie } from 'cookie';
import { ZodError } from 'zod';
import { env } from './env';
import { COOKIE, HttpError, verifySession } from './auth';
import { requireChannel } from './access';
import { subscribe } from './events';
import { routes } from './routes';

// Migrasi skema otomatis saat boot (folder ./drizzle hasil `npm run db:generate`).
if (process.env.RUN_MIGRATIONS !== 'false') {
  await migrate(db, { migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url)) });
}

const app = Fastify({ logger: { level: env.isProd ? 'info' : 'warn' } });
await app.register(cookie);
await app.register(cors, { origin: env.WEB_ORIGIN, credentials: true });

app.setErrorHandler((err, _req, reply) => {
  if (err instanceof HttpError) return reply.status(err.status).send({ error: err.message });
  if (err instanceof ZodError) return reply.status(400).send({ error: err.issues[0]?.message ?? 'Input tidak valid' });
  app.log.error(err);
  return reply.status(500).send({ error: 'Terjadi kesalahan di server' });
});

await app.register(routes);
app.get('/health', async () => ({ ok: true }));

// Di produksi, frontend hasil build disajikan dari origin yang sama (cookie sesi aman & sederhana).
if (env.WEB_DIST) {
  await app.register(fastifyStatic, { root: env.WEB_DIST, wildcard: false });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/') || req.method !== 'GET') return reply.status(404).send({ error: 'Tidak ditemukan' });
    return reply.sendFile('index.html');
  });
}

const io = new Server(app.server, { cors: { origin: env.WEB_ORIGIN, credentials: true } });

io.use((socket, next) => {
  const uid = verifySession(parseCookie(socket.handshake.headers.cookie ?? '')[COOKIE]);
  if (!uid) return next(new Error('unauthorized'));
  socket.data.userId = uid;
  next();
});

io.on('connection', (socket) => {
  socket.on('channel:join', async (channelId: string, ack?: (r: { ok: boolean }) => void) => {
    try {
      await requireChannel(socket.data.userId, channelId);
      await socket.join(`ch:${channelId}`);
      ack?.({ ok: true });
    } catch {
      ack?.({ ok: false });
    }
  });
});

// Teruskan event dari Redis (server ini & worker) ke browser di room channel tsb.
subscribe((e) => io.to(`ch:${e.channelId}`).emit(e.type, e.payload));

await app.listen({ port: env.PORT, host: '0.0.0.0' });
console.log(`AI Agent Chat API berjalan di :${env.PORT}`);
