import {
  pgTable, uuid, text, timestamp, integer, jsonb, primaryKey, uniqueIndex, index, doublePrecision,
} from 'drizzle-orm/pg-core';

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  name: text('name').notNull(),
  passwordHash: text('password_hash').notNull(),
  createdAt: createdAt(),
});

export const workspaces = pgTable('workspaces', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  createdBy: uuid('created_by').notNull().references(() => users.id),
  createdAt: createdAt(),
});

export const workspaceMembers = pgTable('workspace_members', {
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  role: text('role').$type<'admin' | 'member'>().notNull().default('member'),
  createdAt: createdAt(),
}, (t) => [primaryKey({ columns: [t.workspaceId, t.userId] })]);

export type Provider = 'claude' | 'codex';
// 'claude' & 'codex' = API key; 'claude_oauth' = token langganan dari `claude setup-token`.
export type CredentialKind = Provider | 'claude_oauth';

export const agents = pgTable('agents', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  handle: text('handle').notNull(),
  provider: text('provider').$type<Provider>().notNull(),
  model: text('model'),
  systemPrompt: text('system_prompt').notNull().default(''),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('agents_ws_handle').on(t.workspaceId, t.handle)]);

// BYOK: API key per workspace per provider, terenkripsi AES-256-GCM.
export const apiKeys = pgTable('api_keys', {
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  provider: text('provider').$type<CredentialKind>().notNull(),
  ciphertext: text('ciphertext').notNull(),
  last4: text('last4').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.workspaceId, t.provider] })]);

export const channels = pgTable('channels', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  name: text('name'),
  kind: text('kind').$type<'channel' | 'dm'>().notNull(),
  createdAt: createdAt(),
}, (t) => [index('channels_ws').on(t.workspaceId)]);

// Channel biasa: semua member workspace bisa akses; tabel ini mencatat agent
// yang ada di channel. DM: mencatat kedua peserta.
export const channelMembers = pgTable('channel_members', {
  channelId: uuid('channel_id').notNull().references(() => channels.id, { onDelete: 'cascade' }),
  memberType: text('member_type').$type<'user' | 'agent'>().notNull(),
  memberId: uuid('member_id').notNull(),
}, (t) => [primaryKey({ columns: [t.channelId, t.memberType, t.memberId] })]);

export type Activity = { kind: 'tool' | 'command' | 'file' | 'note'; label: string; detail?: string };

export const messages = pgTable('messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  channelId: uuid('channel_id').notNull().references(() => channels.id, { onDelete: 'cascade' }),
  authorType: text('author_type').$type<'user' | 'agent'>().notNull(),
  authorId: uuid('author_id').notNull(),
  content: text('content').notNull().default(''),
  status: text('status').$type<'pending' | 'streaming' | 'done' | 'error'>().notNull().default('done'),
  activity: jsonb('activity').$type<Activity[]>().notNull().default([]),
  // Kedalaman rantai agent→agent, untuk mencegah loop.
  depth: integer('depth').notNull().default(0),
  createdAt: createdAt(),
}, (t) => [index('messages_channel_time').on(t.channelId, t.createdAt)]);

export const agentSessions = pgTable('agent_sessions', {
  agentId: uuid('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
  channelId: uuid('channel_id').notNull().references(() => channels.id, { onDelete: 'cascade' }),
  sessionId: text('session_id').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.agentId, t.channelId] })]);

// Catatan tiap run: dasar dashboard pemakaian & debugging.
export const agentRuns = pgTable('agent_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  agentId: uuid('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
  channelId: uuid('channel_id').notNull().references(() => channels.id, { onDelete: 'cascade' }),
  messageId: uuid('message_id').notNull().references(() => messages.id, { onDelete: 'cascade' }),
  triggerMessageId: uuid('trigger_message_id').notNull(),
  status: text('status').$type<'queued' | 'running' | 'done' | 'error'>().notNull().default('queued'),
  inputTokens: integer('input_tokens'),
  outputTokens: integer('output_tokens'),
  costUsd: doublePrecision('cost_usd'),
  error: text('error'),
  createdAt: createdAt(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
}, (t) => [index('runs_ws_time').on(t.workspaceId, t.createdAt)]);
