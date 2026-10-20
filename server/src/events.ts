import { Redis } from 'ioredis';
import { env } from './env';
import type { messages } from './db';

// Semua event chat lewat Redis pub/sub, supaya server API, worker,
// dan nanti beberapa instance server bisa saling kirim update.
const CHANNEL = 'ruang:events';
const pub = new Redis(env.REDIS_URL);

export type MessageRow = typeof messages.$inferSelect;
export type ChatEvent = {
  type: 'message:new' | 'message:update';
  channelId: string;
  payload: ReturnType<typeof serializeMessage>;
};

export function serializeMessage(m: MessageRow) {
  return {
    id: m.id, channelId: m.channelId, authorType: m.authorType, authorId: m.authorId,
    content: m.content, status: m.status, activity: m.activity, createdAt: m.createdAt.toISOString(),
  };
}

export async function publish(type: ChatEvent['type'], m: MessageRow) {
  const e: ChatEvent = { type, channelId: m.channelId, payload: serializeMessage(m) };
  await pub.publish(CHANNEL, JSON.stringify(e));
}

export function subscribe(handler: (e: ChatEvent) => void) {
  const sub = new Redis(env.REDIS_URL);
  sub.subscribe(CHANNEL);
  sub.on('message', (_c, raw) => handler(JSON.parse(raw)));
  return sub;
}
