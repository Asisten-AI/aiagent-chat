import { and, eq } from 'drizzle-orm';
import { db, agents, channelMembers, messages, agentRuns, channels } from './db';
import { env } from './env';
import { publish, type MessageRow } from './events';
import { agentQueue } from './queue';

type Channel = typeof channels.$inferSelect;

/** Tentukan agent mana yang harus membalas pesan ini, lalu masukkan ke antrean. */
export async function dispatchAgents(msg: MessageRow, channel: Channel) {
  if (msg.depth >= env.MAX_AGENT_DEPTH) return;

  const inChannel = await db.select({ agent: agents }).from(channelMembers)
    .innerJoin(agents, eq(agents.id, channelMembers.memberId))
    .where(and(eq(channelMembers.channelId, channel.id), eq(channelMembers.memberType, 'agent')));
  const candidates = inChannel.map((r) => r.agent).filter((a) => a.id !== msg.authorId);

  let targets = candidates;
  if (channel.kind === 'channel') {
    const handles = new Set([...msg.content.matchAll(/@([a-z0-9][a-z0-9_-]*)/gi)].map((m) => m[1].toLowerCase()));
    targets = candidates.filter((a) => handles.has(a.handle));
  } else if (msg.authorType === 'agent') {
    targets = []; // DM: agent tidak memicu agent lain tanpa diminta
  }

  for (const agent of targets) {
    const [placeholder] = await db.insert(messages).values({
      channelId: channel.id, authorType: 'agent', authorId: agent.id,
      content: '', status: 'pending', depth: msg.depth + 1,
    }).returning();
    const [run] = await db.insert(agentRuns).values({
      workspaceId: channel.workspaceId, agentId: agent.id, channelId: channel.id,
      messageId: placeholder.id, triggerMessageId: msg.id,
    }).returning();
    await publish('message:new', placeholder);
    await agentQueue.add('run', { runId: run.id }, { removeOnComplete: 1000, removeOnFail: 1000 });
  }
}
