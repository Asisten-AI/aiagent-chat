export type Role = 'admin' | 'member';
export type Provider = 'claude' | 'codex';
export type WorkspaceRef = { id: string; name: string; role: Role };
export type Me = { user: { id: string; name: string; email: string }; workspaces: WorkspaceRef[] };
export type Person = { id: string; name: string; email: string; role: Role };
export type Agent = { id: string; workspaceId: string; name: string; handle: string; provider: Provider; model: string | null; systemPrompt: string };
export type Member = { type: 'user' | 'agent'; id: string };
export type Channel = { id: string; name: string | null; kind: 'channel' | 'dm'; members: Member[] };
export type Activity = { kind: 'tool' | 'command' | 'file' | 'note'; label: string; detail?: string };
export type Message = {
  id: string; channelId: string; authorType: 'user' | 'agent'; authorId: string;
  content: string; status: 'pending' | 'streaming' | 'done' | 'error'; activity: Activity[]; createdAt: string;
};
export type Boot = { workspace: WorkspaceRef; people: Person[]; agents: Agent[]; channels: Channel[] };
