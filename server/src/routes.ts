import type { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { and, desc, eq, inArray, lt, or, sql } from 'drizzle-orm';
import {
  db, users, workspaces, workspaceMembers, agents, apiKeys, channels, channelMembers, messages, agentRuns,
} from './db';
import { COOKIE, cookieOptions, HttpError, signSession, userIdOf } from './auth';
import { requireAdmin, requireChannel, requireMember } from './access';
import { encrypt } from './crypto';
import { publish, serializeMessage } from './events';
import { dispatchAgents } from './dispatch';
import { env } from './env';
import { codexLoginState, codexLogout, startCodexLogin } from './subscription';

const slug = (s: string) => s.toLowerCase().trim().replace(/[^a-z0-9-_]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
const handleRe = /^[a-z0-9][a-z0-9_-]{1,30}$/;
const provider = z.enum(['claude', 'codex']);
const credential = z.enum(['claude', 'codex', 'claude_oauth']);

async function createWorkspace(userId: string, name: string) {
  return db.transaction(async (tx) => {
    const [ws] = await tx.insert(workspaces).values({ name, createdBy: userId }).returning();
    await tx.insert(workspaceMembers).values({ workspaceId: ws.id, userId, role: 'admin' });
    await tx.insert(channels).values({ workspaceId: ws.id, name: 'umum', kind: 'channel' });
    return ws;
  });
}

export async function routes(app: FastifyInstance) {
  // ---------- Auth ----------
  // Pendaftaran publik ditutup. Hanya admin pertama (ADMIN_EMAIL) yang bisa daftar sendiri,
  // dan hanya selama belum ada user sama sekali. User lain dibuat admin dari Pengaturan.
  const needsSetup = async () => (await db.select({ n: sql<number>`count(*)::int` }).from(users))[0].n === 0;

  app.get('/api/auth/setup', async () => ({ needsSetup: await needsSetup(), adminEmailRequired: !!env.ADMIN_EMAIL }));

  app.post('/api/auth/register', async (req, reply) => {
    const body = z.object({
      email: z.string().email().toLowerCase(),
      name: z.string().min(1).max(60),
      password: z.string().min(8),
      workspaceName: z.string().min(1).max(60).optional(),
    }).parse(req.body);
    if (!(await needsSetup())) throw new HttpError(403, 'Pendaftaran ditutup. Minta admin membuatkan akun untukmu.');
    if (env.ADMIN_EMAIL && body.email !== env.ADMIN_EMAIL) throw new HttpError(403, 'Email ini tidak terdaftar sebagai admin aplikasi.');
    const [user] = await db.insert(users).values({
      email: body.email, name: body.name, passwordHash: await bcrypt.hash(body.password, 11),
    }).returning();
    await createWorkspace(user.id, body.workspaceName ?? 'Tim');
    reply.setCookie(COOKIE, signSession(user.id), cookieOptions);
    return { ok: true };
  });

  app.post('/api/auth/password', async (req) => {
    const uid = userIdOf(req);
    const body = z.object({ current: z.string(), next: z.string().min(8, 'Kata sandi baru minimal 8 karakter') }).parse(req.body);
    const [user] = await db.select().from(users).where(eq(users.id, uid));
    if (!user || !(await bcrypt.compare(body.current, user.passwordHash))) throw new HttpError(400, 'Kata sandi saat ini salah');
    await db.update(users).set({ passwordHash: await bcrypt.hash(body.next, 11) }).where(eq(users.id, uid));
    return { ok: true };
  });

  app.post('/api/auth/login', async (req, reply) => {
    const body = z.object({ email: z.string().toLowerCase(), password: z.string() }).parse(req.body);
    const [user] = await db.select().from(users).where(eq(users.email, body.email));
    if (!user || !(await bcrypt.compare(body.password, user.passwordHash))) {
      throw new HttpError(401, 'Email atau kata sandi salah');
    }
    reply.setCookie(COOKIE, signSession(user.id), cookieOptions);
    return { ok: true };
  });

  app.post('/api/auth/logout', async (_req, reply) => {
    reply.clearCookie(COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/me', async (req) => {
    const uid = userIdOf(req);
    const [user] = await db.select({ id: users.id, name: users.name, email: users.email }).from(users).where(eq(users.id, uid));
    if (!user) throw new HttpError(401, 'Sesi tidak valid');
    const wss = await db.select({ id: workspaces.id, name: workspaces.name, role: workspaceMembers.role })
      .from(workspaceMembers).innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
      .where(eq(workspaceMembers.userId, uid)).orderBy(workspaces.createdAt);
    return { user, workspaces: wss };
  });

  // ---------- Workspace ----------
  app.post('/api/workspaces', async (req) => {
    const uid = userIdOf(req);
    const { name } = z.object({ name: z.string().min(1).max(60) }).parse(req.body);
    return createWorkspace(uid, name);
  });

  app.get('/api/workspaces/:wid/bootstrap', async (req) => {
    const uid = userIdOf(req);
    const { wid } = req.params as { wid: string };
    const me = await requireMember(uid, wid);
    const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, wid));
    const people = await db.select({ id: users.id, name: users.name, email: users.email, role: workspaceMembers.role })
      .from(workspaceMembers).innerJoin(users, eq(users.id, workspaceMembers.userId))
      .where(eq(workspaceMembers.workspaceId, wid));
    const bots = await db.select().from(agents).where(eq(agents.workspaceId, wid)).orderBy(agents.createdAt);

    const myDms = db.select({ id: channelMembers.channelId }).from(channelMembers)
      .where(and(eq(channelMembers.memberType, 'user'), eq(channelMembers.memberId, uid)));
    const chs = await db.select().from(channels).where(and(
      eq(channels.workspaceId, wid),
      or(eq(channels.kind, 'channel'), inArray(channels.id, myDms)),
    )).orderBy(channels.createdAt);
    const members = chs.length
      ? await db.select().from(channelMembers).where(inArray(channelMembers.channelId, chs.map((c) => c.id)))
      : [];

    return {
      workspace: { id: ws.id, name: ws.name, role: me.role },
      people,
      agents: bots.map(({ systemPrompt, ...a }) => ({ ...a, systemPrompt })),
      channels: chs.map((c) => ({
        id: c.id, name: c.name, kind: c.kind,
        members: members.filter((m) => m.channelId === c.id).map((m) => ({ type: m.memberType, id: m.memberId })),
      })),
    };
  });

  // Admin membuat akun anggota (atau menambahkan akun yang sudah ada) secara manual.
  app.post('/api/workspaces/:wid/members', async (req) => {
    const uid = userIdOf(req);
    const { wid } = req.params as { wid: string };
    await requireAdmin(uid, wid);
    const body = z.object({
      email: z.string().email().toLowerCase(),
      name: z.string().min(1).max(60).optional(),
      password: z.string().min(8, 'Kata sandi sementara minimal 8 karakter').optional(),
      role: z.enum(['admin', 'member']).default('member'),
    }).parse(req.body);
    let [u] = await db.select().from(users).where(eq(users.email, body.email));
    if (!u) {
      if (!body.name || !body.password) throw new HttpError(400, 'Akun baru butuh nama dan kata sandi sementara');
      [u] = await db.insert(users).values({ email: body.email, name: body.name, passwordHash: await bcrypt.hash(body.password, 11) }).returning();
    }
    await db.insert(workspaceMembers).values({ workspaceId: wid, userId: u.id, role: body.role }).onConflictDoNothing();
    return { ok: true, created: !!body.password };
  });

  app.delete('/api/workspaces/:wid/members/:userId', async (req) => {
    const uid = userIdOf(req);
    const { wid, userId } = req.params as { wid: string; userId: string };
    await requireAdmin(uid, wid);
    if (userId === uid) throw new HttpError(400, 'Kamu tidak bisa mengeluarkan dirimu sendiri');
    await db.delete(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, wid), eq(workspaceMembers.userId, userId)));
    return { ok: true };
  });

  // ---------- Channels & DM ----------
  app.post('/api/workspaces/:wid/channels', async (req) => {
    const uid = userIdOf(req);
    const { wid } = req.params as { wid: string };
    await requireMember(uid, wid);
    const body = z.object({ name: z.string().min(1), agentIds: z.array(z.string().uuid()).default([]) }).parse(req.body);
    const name = slug(body.name);
    if (!name) throw new HttpError(400, 'Nama channel hanya boleh huruf, angka, dan tanda hubung');
    const [ch] = await db.insert(channels).values({ workspaceId: wid, name, kind: 'channel' }).returning();
    if (body.agentIds.length) {
      const valid = await db.select({ id: agents.id }).from(agents)
        .where(and(eq(agents.workspaceId, wid), inArray(agents.id, body.agentIds)));
      if (valid.length) {
        await db.insert(channelMembers).values(valid.map((a) => ({ channelId: ch.id, memberType: 'agent' as const, memberId: a.id })));
      }
    }
    return ch;
  });

  app.post('/api/workspaces/:wid/dms', async (req) => {
    const uid = userIdOf(req);
    const { wid } = req.params as { wid: string };
    await requireMember(uid, wid);
    const target = z.object({ type: z.enum(['user', 'agent']), id: z.string().uuid() }).parse(req.body);
    if (target.type === 'agent') {
      const [a] = await db.select().from(agents).where(and(eq(agents.id, target.id), eq(agents.workspaceId, wid)));
      if (!a) throw new HttpError(404, 'Agent tidak ditemukan');
    } else {
      await requireMember(target.id, wid);
    }
    const existing = await db.execute<{ id: string }>(sql`
      select c.id from channels c
      join channel_members a on a.channel_id = c.id and a.member_type = 'user' and a.member_id = ${uid}
      join channel_members b on b.channel_id = c.id and b.member_type = ${target.type} and b.member_id = ${target.id}
      where c.workspace_id = ${wid} and c.kind = 'dm'
        and (select count(*) from channel_members x where x.channel_id = c.id) = ${target.type === 'user' && target.id === uid ? 1 : 2}
      limit 1`);
    if (existing.rows[0]) return { id: existing.rows[0].id };

    return db.transaction(async (tx) => {
      const [ch] = await tx.insert(channels).values({ workspaceId: wid, kind: 'dm' }).returning();
      await tx.insert(channelMembers).values([
        { channelId: ch.id, memberType: 'user', memberId: uid },
        ...(target.type === 'user' && target.id === uid ? [] : [{ channelId: ch.id, memberType: target.type, memberId: target.id }]),
      ]);
      return { id: ch.id };
    });
  });

  app.put('/api/channels/:cid/agents/:aid', async (req) => {
    const uid = userIdOf(req);
    const { cid, aid } = req.params as { cid: string; aid: string };
    const ch = await requireChannel(uid, cid);
    if (ch.kind !== 'channel') throw new HttpError(400, 'Agent hanya bisa ditambahkan ke channel');
    const [a] = await db.select().from(agents).where(and(eq(agents.id, aid), eq(agents.workspaceId, ch.workspaceId)));
    if (!a) throw new HttpError(404, 'Agent tidak ditemukan');
    await db.insert(channelMembers).values({ channelId: cid, memberType: 'agent', memberId: aid }).onConflictDoNothing();
    return { ok: true };
  });

  app.delete('/api/channels/:cid/agents/:aid', async (req) => {
    const uid = userIdOf(req);
    const { cid, aid } = req.params as { cid: string; aid: string };
    await requireChannel(uid, cid);
    await db.delete(channelMembers).where(and(
      eq(channelMembers.channelId, cid), eq(channelMembers.memberType, 'agent'), eq(channelMembers.memberId, aid)));
    return { ok: true };
  });

  // ---------- Messages ----------
  app.get('/api/channels/:cid/messages', async (req) => {
    const uid = userIdOf(req);
    const { cid } = req.params as { cid: string };
    await requireChannel(uid, cid);
    const { before } = z.object({ before: z.string().datetime().optional() }).parse(req.query);
    const rows = await db.select().from(messages)
      .where(and(eq(messages.channelId, cid), before ? lt(messages.createdAt, new Date(before)) : undefined))
      .orderBy(desc(messages.createdAt)).limit(60);
    return rows.reverse().map(serializeMessage);
  });

  app.post('/api/channels/:cid/messages', async (req) => {
    const uid = userIdOf(req);
    const { cid } = req.params as { cid: string };
    const ch = await requireChannel(uid, cid);
    const { content } = z.object({ content: z.string().trim().min(1).max(20_000) }).parse(req.body);
    const [msg] = await db.insert(messages).values({ channelId: cid, authorType: 'user', authorId: uid, content }).returning();
    await publish('message:new', msg);
    await dispatchAgents(msg, ch);
    return serializeMessage(msg);
  });

  // ---------- Agents ----------
  const agentBody = z.object({
    name: z.string().min(1).max(40),
    handle: z.string().toLowerCase().regex(handleRe, 'Handle: 2–31 karakter, huruf kecil/angka/-/_'),
    provider,
    model: z.string().max(80).optional().nullable(),
    systemPrompt: z.string().max(8000).default(''),
  });

  app.post('/api/workspaces/:wid/agents', async (req) => {
    const uid = userIdOf(req);
    const { wid } = req.params as { wid: string };
    await requireAdmin(uid, wid);
    const body = agentBody.parse(req.body);
    const [clash] = await db.select({ id: agents.id }).from(agents).where(and(eq(agents.workspaceId, wid), eq(agents.handle, body.handle)));
    if (clash) throw new HttpError(409, `@${body.handle} sudah dipakai agent lain`);
    const [a] = await db.insert(agents).values({ ...body, model: body.model || null, workspaceId: wid }).returning();
    return a;
  });

  app.patch('/api/agents/:aid', async (req) => {
    const uid = userIdOf(req);
    const { aid } = req.params as { aid: string };
    const [a] = await db.select().from(agents).where(eq(agents.id, aid));
    if (!a) throw new HttpError(404, 'Agent tidak ditemukan');
    await requireAdmin(uid, a.workspaceId);
    const body = agentBody.omit({ handle: true, provider: true }).partial().parse(req.body);
    const [updated] = await db.update(agents).set({ ...body, model: body.model === '' ? null : body.model })
      .where(eq(agents.id, aid)).returning();
    return updated;
  });

  app.delete('/api/agents/:aid', async (req) => {
    const uid = userIdOf(req);
    const { aid } = req.params as { aid: string };
    const [a] = await db.select().from(agents).where(eq(agents.id, aid));
    if (!a) throw new HttpError(404, 'Agent tidak ditemukan');
    await requireAdmin(uid, a.workspaceId);
    await db.delete(channelMembers).where(and(eq(channelMembers.memberType, 'agent'), eq(channelMembers.memberId, aid)));
    await db.delete(agents).where(eq(agents.id, aid));
    return { ok: true };
  });

  // ---------- BYOK API keys ----------
  app.get('/api/workspaces/:wid/keys', async (req) => {
    const uid = userIdOf(req);
    const { wid } = req.params as { wid: string };
    await requireMember(uid, wid);
    const keys = await db.select({ provider: apiKeys.provider, last4: apiKeys.last4, updatedAt: apiKeys.updatedAt })
      .from(apiKeys).where(eq(apiKeys.workspaceId, wid));
    return { keys, codex: codexLoginState() };
  });

  app.put('/api/workspaces/:wid/keys/:provider', async (req) => {
    const uid = userIdOf(req);
    const { wid } = req.params as { wid: string };
    const p = credential.parse((req.params as { provider: string }).provider);
    await requireAdmin(uid, wid);
    const { key } = z.object({ key: z.string().trim().min(20).max(2000) }).parse(req.body);
    const row = { ciphertext: encrypt(key), last4: key.slice(-4), updatedAt: new Date() };
    await db.insert(apiKeys).values({ workspaceId: wid, provider: p, ...row })
      .onConflictDoUpdate({ target: [apiKeys.workspaceId, apiKeys.provider], set: row });
    return { ok: true };
  });

  app.delete('/api/workspaces/:wid/keys/:provider', async (req) => {
    const uid = userIdOf(req);
    const { wid } = req.params as { wid: string };
    const p = credential.parse((req.params as { provider: string }).provider);
    await requireAdmin(uid, wid);
    await db.delete(apiKeys).where(and(eq(apiKeys.workspaceId, wid), eq(apiKeys.provider, p)));
    return { ok: true };
  });

  // ---------- Login ChatGPT untuk Codex (device code, dijalankan di server) ----------
  app.post('/api/workspaces/:wid/codex-login', async (req) => {
    const uid = userIdOf(req);
    const { wid } = req.params as { wid: string };
    await requireAdmin(uid, wid);
    startCodexLogin();
    return codexLoginState();
  });

  app.get('/api/workspaces/:wid/codex-login', async (req) => {
    const uid = userIdOf(req);
    await requireMember(uid, (req.params as { wid: string }).wid);
    return codexLoginState();
  });

  app.delete('/api/workspaces/:wid/codex-login', async (req) => {
    const uid = userIdOf(req);
    await requireAdmin(uid, (req.params as { wid: string }).wid);
    codexLogout();
    return codexLoginState();
  });

  // ---------- Usage ----------
  app.get('/api/workspaces/:wid/usage', async (req) => {
    const uid = userIdOf(req);
    const { wid } = req.params as { wid: string };
    await requireMember(uid, wid);
    return db.select({
      agentId: agentRuns.agentId,
      runs: sql<number>`count(*)::int`,
      inputTokens: sql<number>`coalesce(sum(${agentRuns.inputTokens}),0)::int`,
      outputTokens: sql<number>`coalesce(sum(${agentRuns.outputTokens}),0)::int`,
      costUsd: sql<number>`coalesce(sum(${agentRuns.costUsd}),0)::float`,
    }).from(agentRuns)
      .where(and(eq(agentRuns.workspaceId, wid), sql`${agentRuns.createdAt} > now() - interval '30 days'`))
      .groupBy(agentRuns.agentId);
  });
}
