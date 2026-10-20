import { and, eq } from 'drizzle-orm';
import { db, workspaceMembers, channels, channelMembers } from './db';
import { HttpError } from './auth';

export async function requireMember(userId: string, workspaceId: string) {
  const [m] = await db.select().from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)));
  if (!m) throw new HttpError(403, 'Kamu bukan anggota workspace ini');
  return m;
}

export async function requireAdmin(userId: string, workspaceId: string) {
  const m = await requireMember(userId, workspaceId);
  if (m.role !== 'admin') throw new HttpError(403, 'Hanya admin yang bisa mengubah ini');
  return m;
}

export async function requireChannel(userId: string, channelId: string) {
  const [ch] = await db.select().from(channels).where(eq(channels.id, channelId));
  if (!ch) throw new HttpError(404, 'Channel tidak ditemukan');
  await requireMember(userId, ch.workspaceId);
  if (ch.kind === 'dm') {
    const [cm] = await db.select().from(channelMembers).where(and(
      eq(channelMembers.channelId, ch.id),
      eq(channelMembers.memberType, 'user'),
      eq(channelMembers.memberId, userId),
    ));
    if (!cm) throw new HttpError(403, 'Ini percakapan pribadi orang lain');
  }
  return ch;
}
