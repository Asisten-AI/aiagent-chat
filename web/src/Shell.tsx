import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { io, type Socket } from 'socket.io-client';
import { api } from './api';
import type { Boot, Channel, Me, Message } from './types';
import { Avatar, Modal } from './bits';
import { ChannelView } from './ChannelView';
import { Settings } from './Settings';

type Props = { me: Me; workspaceId: string; onSwitch: (id: string) => void; onReloadMe: () => void; onLogout: () => void };

export function Shell({ me, workspaceId, onSwitch, onReloadMe, onLogout }: Props) {
  const [boot, setBoot] = useState<Boot | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [unread, setUnread] = useState<Set<string>>(new Set());
  const [modal, setModal] = useState<null | 'channel' | 'settings' | 'workspace'>(null);
  const [navOpen, setNavOpen] = useState(false);
  const socketRef = useRef<Socket | null>(null);
  const activeRef = useRef<string | null>(null);
  activeRef.current = activeId;

  const reload = useCallback(async () => {
    const b = await api<Boot>(`/api/workspaces/${workspaceId}/bootstrap`);
    setBoot(b);
    setActiveId((cur) => cur ?? b.channels.find((c) => c.kind === 'channel')?.id ?? null);
    b.channels.forEach((c) => socketRef.current?.emit('channel:join', c.id));
    return b;
  }, [workspaceId]);

  useEffect(() => {
    const s = io({ withCredentials: true });
    socketRef.current = s;
    s.on('connect', () => reload());
    s.on('message:new', (m: Message) => {
      if (m.channelId !== activeRef.current) setUnread((u) => new Set(u).add(m.channelId));
    });
    return () => { s.disconnect(); };
  }, [reload]);

  const open = (id: string) => {
    setActiveId(id);
    setNavOpen(false);
    setUnread((u) => { const n = new Set(u); n.delete(id); return n; });
  };

  async function openDm(type: 'user' | 'agent', id: string) {
    const dm = await api<{ id: string }>(`/api/workspaces/${workspaceId}/dms`, { body: { type, id } });
    const b = boot?.channels.some((c) => c.id === dm.id) ? boot : await reload();
    if (b) open(dm.id);
  }

  const dmFor = useCallback((type: 'user' | 'agent', id: string) =>
    boot?.channels.find((c) => c.kind === 'dm' && c.members.some((m) => m.type === type && m.id === id)
      && (type === 'agent' || c.members.filter((m) => m.type === 'user').length === (id === me.user.id ? 1 : 2))),
  [boot, me.user.id]);

  const active = useMemo(() => boot?.channels.find((c) => c.id === activeId) ?? null, [boot, activeId]);

  if (!boot) return <div className="splash">Membuka workspace…</div>;
  const isAdmin = boot.workspace.role === 'admin';

  const dmRow = (type: 'user' | 'agent', id: string, label: string, sub?: string) => {
    const ch = dmFor(type, id);
    return (
      <li key={`${type}-${id}`}>
        <button className={`nav-item ${ch && ch.id === activeId ? 'on' : ''} ${ch && unread.has(ch.id) ? 'unread' : ''}`}
          onClick={() => (ch ? open(ch.id) : openDm(type, id))}>
          <Avatar kind={type} name={label} size={20} />
          <span className="nav-label">{label}</span>
          {sub && <span className="nav-sub">{sub}</span>}
        </button>
      </li>
    );
  };

  return (
    <div className={`shell ${navOpen ? 'nav-open' : ''}`}>
      <aside className="sidebar">
        <div className="ws-head">
          {me.workspaces.length > 1 ? (
            <select value={workspaceId} onChange={(e) => onSwitch(e.target.value)} aria-label="Pilih workspace">
              {me.workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
          ) : <strong>{boot.workspace.name}</strong>}
          <button className="icon" onClick={() => setModal('settings')} aria-label="Pengaturan workspace">⚙</button>
        </div>

        <nav aria-label="Channel">
          <div className="nav-section">
            <h3>Channel</h3>
            <button className="icon small" onClick={() => setModal('channel')} aria-label="Buat channel">＋</button>
          </div>
          <ul>
            {boot.channels.filter((c) => c.kind === 'channel').map((c) => (
              <li key={c.id}>
                <button className={`nav-item ${c.id === activeId ? 'on' : ''} ${unread.has(c.id) ? 'unread' : ''}`} onClick={() => open(c.id)}>
                  <span className="hash">#</span><span className="nav-label">{c.name}</span>
                </button>
              </li>
            ))}
          </ul>

          <div className="nav-section"><h3>Agent</h3></div>
          <ul>
            {boot.agents.length === 0 && (
              <li className="nav-empty">{isAdmin ? <button className="link" onClick={() => setModal('settings')}>Tambah agent pertama</button> : 'Belum ada agent'}</li>
            )}
            {boot.agents.map((a) => dmRow('agent', a.id, a.handle, a.provider === 'claude' ? 'Claude' : 'Codex'))}
          </ul>

          <div className="nav-section"><h3>Orang</h3></div>
          <ul>
            {boot.people.map((p) => dmRow('user', p.id, p.id === me.user.id ? `${p.name} (kamu)` : p.name))}
          </ul>
        </nav>

        <div className="me-row">
          <Avatar kind="user" name={me.user.name} size={24} />
          <span className="nav-label">{me.user.name}</span>
          <button className="link" onClick={() => setModal('workspace')}>Workspace baru</button>
          <button className="link" onClick={onLogout}>Keluar</button>
        </div>
      </aside>

      <main className="main">
        {active ? (
          <ChannelView
            key={active.id}
            channel={active}
            boot={boot}
            me={me}
            socket={socketRef.current}
            onToggleNav={() => setNavOpen((v) => !v)}
            onChanged={reload}
          />
        ) : <div className="empty">Pilih channel atau mulai percakapan dari sidebar.</div>}
      </main>

      {modal === 'channel' && (
        <NewChannel boot={boot} onClose={() => setModal(null)} onCreated={async (id) => { setModal(null); await reload(); open(id); }} />
      )}
      {modal === 'settings' && <Settings boot={boot} meId={me.user.id} onClose={() => setModal(null)} onChanged={reload} />}
      {modal === 'workspace' && (
        <NewWorkspace onClose={() => setModal(null)} onCreated={(id) => { setModal(null); onReloadMe(); onSwitch(id); }} />
      )}
    </div>
  );
}

function NewChannel({ boot, onClose, onCreated }: { boot: Boot; onClose: () => void; onCreated: (id: string) => void }) {
  const [name, setName] = useState('');
  const [agentIds, setAgentIds] = useState<string[]>([]);
  const [error, setError] = useState('');
  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      const ch = await api<Channel>(`/api/workspaces/${boot.workspace.id}/channels`, { body: { name, agentIds } });
      onCreated(ch.id);
    } catch (err) { setError((err as Error).message); }
  }
  return (
    <Modal title="Buat channel" onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <label>Nama channel<input value={name} onChange={(e) => setName(e.target.value)} placeholder="misal: rilis-v2" required autoFocus /></label>
        {boot.agents.length > 0 && (
          <fieldset>
            <legend>Agent di channel ini</legend>
            {boot.agents.map((a) => (
              <label key={a.id} className="check">
                <input type="checkbox" checked={agentIds.includes(a.id)}
                  onChange={(e) => setAgentIds(e.target.checked ? [...agentIds, a.id] : agentIds.filter((x) => x !== a.id))} />
                @{a.handle} <span className="hint">{a.name}</span>
              </label>
            ))}
          </fieldset>
        )}
        {error && <p className="error" role="alert">{error}</p>}
        <button className="primary">Buat channel</button>
      </form>
    </Modal>
  );
}

function NewWorkspace({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const [name, setName] = useState('');
  return (
    <Modal title="Workspace baru" onClose={onClose}>
      <form className="stack" onSubmit={async (e) => {
        e.preventDefault();
        const ws = await api<{ id: string }>('/api/workspaces', { body: { name } });
        onCreated(ws.id);
      }}>
        <label>Nama workspace<input value={name} onChange={(e) => setName(e.target.value)} required autoFocus /></label>
        <button className="primary">Buat workspace</button>
      </form>
    </Modal>
  );
}
