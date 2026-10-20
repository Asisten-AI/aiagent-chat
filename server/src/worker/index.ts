import { Worker } from 'bullmq';
import { and, desc, eq, gt, ne } from 'drizzle-orm';
import {
  db, agents, agentRuns, agentSessions, apiKeys, channels, messages, users, workspaceMembers,
} from '../db';
import { env } from '../env';
import { decrypt } from '../crypto';
import { publish } from '../events';
import { dispatchAgents } from '../dispatch';
import { redisForQueue, type AgentJob } from '../queue';
import { applyClaudeEvent, applyCodexEvent, type RunState } from './parse';
import { startRun } from './runner';
import { codexLoggedIn } from '../subscription';

type Agent = typeof agents.$inferSelect;
const MAX_PROMPT_CHARS = 60_000;

async function buildPrompt(agent: Agent, channelId: string, channelName: string, upTo: Date, resumed: boolean) {
  const [ch] = await db.select().from(channels).where(eq(channels.id, channelId));
  const people = await db.select({ id: users.id, name: users.name }).from(workspaceMembers)
    .innerJoin(users, eq(users.id, workspaceMembers.userId)).where(eq(workspaceMembers.workspaceId, ch.workspaceId));
  const bots = await db.select().from(agents).where(eq(agents.workspaceId, ch.workspaceId));
  const nameOf = (type: string, id: string) =>
    type === 'user' ? people.find((p) => p.id === id)?.name ?? 'Seseorang' : `@${bots.find((b) => b.id === id)?.handle ?? 'agent'}`;

  // Kalau session dilanjutkan, cukup kirim pesan sejak balasan terakhir agent ini.
  let since: Date | undefined;
  if (resumed) {
    const [last] = await db.select({ createdAt: messages.createdAt }).from(messages)
      .where(and(eq(messages.channelId, channelId), eq(messages.authorId, agent.id), eq(messages.status, 'done')))
      .orderBy(desc(messages.createdAt)).limit(1);
    since = last?.createdAt;
  }
  const rows = (await db.select().from(messages).where(and(
    eq(messages.channelId, channelId),
    eq(messages.status, 'done'),
    since ? gt(messages.createdAt, since) : undefined,
    ne(messages.createdAt, upTo),
  )).orderBy(desc(messages.createdAt)).limit(30)).filter((m) => m.createdAt < upTo).reverse();

  let transcript = rows.map((m) => `[${nameOf(m.authorType, m.authorId)}]: ${m.content}`).join('\n\n');
  if (transcript.length > MAX_PROMPT_CHARS) transcript = transcript.slice(-MAX_PROMPT_CHARS);

  const where = ch.kind === 'dm' ? 'percakapan pribadi' : `channel #${channelName}`;
  return [
    `Pesan terbaru di ${where}:`,
    '',
    transcript || '(belum ada pesan)',
    '',
    'Balas sebagai anggota tim di chat ini. Tanggapi pesan terakhir yang ditujukan ke kamu.',
  ].join('\n');
}

function systemPromptFor(agent: Agent, others: Agent[]) {
  return [
    `Kamu adalah ${agent.name} (@${agent.handle}), anggota AI di aplikasi chat tim. Manusia dan agent lain mengobrol bersamamu.`,
    'Tulis balasan seperti pesan chat: ringkas, pakai Markdown seperlunya. Folder kerjamu persisten untuk channel ini.',
    others.length ? `Agent lain yang bisa kamu panggil dengan @mention: ${others.map((o) => `@${o.handle} (${o.name})`).join(', ')}. Panggil hanya kalau benar-benar perlu.` : '',
    agent.systemPrompt,
  ].filter(Boolean).join('\n');
}

function cliArgs(agent: Agent, prompt: string, system: string, session: string | undefined, usingApiKey: boolean) {
  if (agent.provider === 'claude') {
    return [
      'claude', '-p', prompt, '--output-format', 'stream-json', '--verbose',
      // Aman karena seluruh run terkurung di container sandbox.
      '--permission-mode', 'bypassPermissions',
      // Batas biaya hanya relevan untuk API key (langganan punya kuotanya sendiri).
      ...(usingApiKey ? ['--max-budget-usd', env.AGENT_MAX_BUDGET_USD] : []),
      '--append-system-prompt', system,
      ...(agent.model ? ['--model', agent.model] : []),
      ...(session ? ['--resume', session] : []),
    ];
  }
  // Codex tidak punya flag system prompt; instruksi digabung ke prompt.
  const full = `${system}\n\n---\n\n${prompt}`;
  const common = ['--json', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox',
    ...(agent.model ? ['-m', agent.model] : [])];
  return session
    ? ['codex', 'exec', 'resume', ...common, session, full]
    : ['codex', 'exec', ...common, full];
}

async function runAgent(runId: string) {
  const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, runId));
  if (!run) return;
  const [agent] = await db.select().from(agents).where(eq(agents.id, run.agentId));
  const [msg] = await db.select().from(messages).where(eq(messages.id, run.messageId));
  const [channel] = await db.select().from(channels).where(eq(channels.id, run.channelId));
  if (!agent || !msg || !channel) return;

  const finish = async (s: RunState) => {
    const failed = !!s.error && !s.text;
    const content = failed ? `⚠️ ${s.error}` : s.text || '_(agent selesai tanpa balasan)_';
    const [final] = await db.update(messages).set({ content, activity: s.activity, status: failed ? 'error' : 'done' })
      .where(eq(messages.id, msg.id)).returning();
    await db.update(agentRuns).set({
      status: failed ? 'error' : 'done', error: s.error ?? null, finishedAt: new Date(),
      inputTokens: s.inputTokens ?? null, outputTokens: s.outputTokens ?? null, costUsd: s.costUsd ?? null,
    }).where(eq(agentRuns.id, runId));
    await publish('message:update', final);
    if (!failed) await dispatchAgents(final, channel); // agent boleh @mention agent lain (dibatasi depth)
  };

  // Prioritas: login langganan dulu, lalu API key.
  const creds = await db.select().from(apiKeys).where(eq(apiKeys.workspaceId, channel.workspaceId));
  const find = (k: string) => creds.find((c) => c.provider === k);
  let secrets: Record<string, string> = {};
  let codexShared = false;
  let usingApiKey = false;
  if (agent.provider === 'claude') {
    const oauth = find('claude_oauth');
    const key = find('claude');
    if (oauth) secrets = { CLAUDE_CODE_OAUTH_TOKEN: decrypt(oauth.ciphertext) };
    else if (key) { secrets = { ANTHROPIC_API_KEY: decrypt(key.ciphertext) }; usingApiKey = true; }
    else return finish({ text: '', activity: [], error: 'Claude belum tersambung. Admin bisa menempelkan token langganan Claude atau API key Anthropic di Pengaturan → Akses AI.' });
  } else {
    const key = find('codex');
    if (codexLoggedIn() && env.AGENT_RUNNER === 'process') codexShared = true;
    else if (key) { const v = decrypt(key.ciphertext); secrets = { OPENAI_API_KEY: v, CODEX_API_KEY: v }; usingApiKey = true; }
    else return finish({ text: '', activity: [], error: 'Codex belum tersambung. Admin bisa login dengan akun ChatGPT atau menempelkan API key OpenAI di Pengaturan → Akses AI.' });
  }

  const [sess] = await db.select().from(agentSessions)
    .where(and(eq(agentSessions.agentId, agent.id), eq(agentSessions.channelId, channel.id)));
  const others = (await db.select().from(agents).where(eq(agents.workspaceId, channel.workspaceId))).filter((a) => a.id !== agent.id);
  const system = systemPromptFor(agent, others);

  await db.update(agentRuns).set({ status: 'running' }).where(eq(agentRuns.id, runId));
  const [streaming] = await db.update(messages).set({ status: 'streaming' }).where(eq(messages.id, msg.id)).returning();
  await publish('message:update', streaming);

  const attempt = async (session?: string) => {
    const prompt = await buildPrompt(agent, channel.id, channel.name ?? 'dm', msg.createdAt, !!session);
    const state: RunState = { text: '', activity: [] };
    let started;
    try {
      started = startRun({ runId, agentId: agent.id, channelId: channel.id, args: cliArgs(agent, prompt, system, session, usingApiKey), secrets, codexShared });
    } catch (err) {
      state.error = (err as Error).message;
      return state;
    }
    const { child, kill, redact } = started;
    const apply = agent.provider === 'claude' ? applyClaudeEvent : applyCodexEvent;
    let buf = '';
    let stderr = '';
    let dirty = false;

    child.stdout!.on('data', (chunk: Buffer) => {
      buf += chunk.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        try { apply(state, JSON.parse(line)); dirty = true; } catch { /* baris non-JSON diabaikan */ }
      }
    });
    child.stderr!.on('data', (c: Buffer) => { stderr = (stderr + c.toString()).slice(-4000); });

    // Kirim progres ke chat secara berkala (bukan per token) supaya ringan.
    const tick = setInterval(async () => {
      if (!dirty) return;
      dirty = false;
      const [m] = await db.update(messages).set({ content: state.text, activity: state.activity })
        .where(eq(messages.id, msg.id)).returning();
      await publish('message:update', m);
    }, 700);
    const timeout = setTimeout(() => {
      state.error = `Run dihentikan karena melebihi batas ${Math.round(env.AGENT_TIMEOUT_MS / 60000)} menit`;
      kill();
    }, env.AGENT_TIMEOUT_MS);

    const code: number = await new Promise((resolve) => {
      child.on('error', (err) => { state.error = `Gagal menjalankan agent: ${err.message}`; resolve(1); });
      child.on('close', (c) => resolve(c ?? 1));
    });
    clearInterval(tick);
    clearTimeout(timeout);
    if (code !== 0 && !state.error) {
      state.error = redact(stderr.trim().split('\n').slice(-3).join(' ')) || `Agent keluar dengan kode ${code}`;
    }
    if (state.error) state.error = redact(state.error);
    return state;
  };

  let state = await attempt(sess?.sessionId);
  // Folder session bisa hilang (redeploy di disk sementara): ulangi sekali tanpa resume.
  if (sess && state.error && !state.text) {
    await db.delete(agentSessions).where(and(eq(agentSessions.agentId, agent.id), eq(agentSessions.channelId, channel.id)));
    state = await attempt(undefined);
  }

  if (state.sessionId) {
    await db.insert(agentSessions).values({ agentId: agent.id, channelId: channel.id, sessionId: state.sessionId })
      .onConflictDoUpdate({ target: [agentSessions.agentId, agentSessions.channelId], set: { sessionId: state.sessionId, updatedAt: new Date() } });
  }
  await finish(state);
}

export const worker = new Worker<AgentJob>('agent-runs', (job) => runAgent(job.data.runId), {
  connection: redisForQueue(),
  concurrency: env.WORKER_CONCURRENCY,
});
worker.on('failed', (job, err) => console.error(`Run ${job?.data.runId} gagal:`, err));
console.log(`Worker agent siap (concurrency ${env.WORKER_CONCURRENCY})`);
