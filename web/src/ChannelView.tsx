import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { Socket } from 'socket.io-client';
import { api, providerLabel } from './api';
import type { Agent, Boot, Channel, Me, Message } from './types';
import { Avatar, Markdown } from './bits';

type Props = { channel: Channel; boot: Boot; me: Me; socket: Socket | null; onToggleNav: () => void; onChanged: () => void };

const timeFmt = new Intl.DateTimeFormat('id-ID', { hour: '2-digit', minute: '2-digit' });
const dayFmt = new Intl.DateTimeFormat('id-ID', { weekday: 'long', day: 'numeric', month: 'long' });

export function ChannelView({ channel, boot, me, socket, onToggleNav, onChanged }: Props) {
  const [msgs, setMsgs] = useState<Message[]>([]);
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [picker, setPicker] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  const channelAgents = useMemo(() => boot.agents.filter((a) => channel.members.some((m) => m.type === 'agent' && m.id === a.id)), [boot, channel]);
  const nameOf = (m: Pick<Message, 'authorType' | 'authorId'>) =>
    m.authorType === 'user' ? boot.people.find((p) => p.id === m.authorId)?.name ?? 'Mantan anggota'
      : boot.agents.find((a) => a.id === m.authorId)?.handle ?? 'agent dihapus';

  const title = channel.kind === 'channel' ? `#${channel.name}` : (() => {
    const other = channel.members.find((m) => !(m.type === 'user' && m.id === me.user.id));
    return other ? nameOf({ authorType: other.type, authorId: other.id }) : `${me.user.name} (catatan pribadi)`;
  })();
  const dmAgent = channel.kind === 'dm' ? channelAgents[0] : undefined;

  useEffect(() => {
    api<Message[]>(`/api/channels/${channel.id}/messages`).then(setMsgs).catch((e) => setError(e.message));
    if (!socket) return;
    socket.emit('channel:join', channel.id);
    const upsert = (m: Message) => {
      if (m.channelId !== channel.id) return;
      setMsgs((cur) => {
        const i = cur.findIndex((x) => x.id === m.id);
        if (i === -1) return [...cur, m];
        const next = cur.slice(); next[i] = m; return next;
      });
    };
    socket.on('message:new', upsert);
    socket.on('message:update', upsert);
    return () => { socket.off('message:new', upsert); socket.off('message:update', upsert); };
  }, [channel.id, socket]);

  useEffect(() => {
    const el = listRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [msgs]);

  // Autocomplete @mention: ambil kata yang sedang diketik setelah '@'.
  const mentionQuery = /(?:^|\s)@([a-z0-9_-]*)$/i.exec(text)?.[1];
  const suggestions = mentionQuery !== undefined && channel.kind === 'channel'
    ? channelAgents.filter((a) => a.handle.startsWith(mentionQuery.toLowerCase())) : [];

  function complete(a: Agent) {
    setText(text.replace(/@([a-z0-9_-]*)$/i, `@${a.handle} `));
  }

  async function send() {
    const content = text.trim();
    if (!content) return;
    setText('');
    setError('');
    stick.current = true;
    try {
      await api(`/api/channels/${channel.id}/messages`, { body: { content } });
    } catch (e) {
      setError((e as Error).message);
      setText(content);
    }
  }

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Tab' && suggestions[0]) { e.preventDefault(); complete(suggestions[0]); return; }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); }
  }

  async function toggleAgent(a: Agent, on: boolean) {
    await api(`/api/channels/${channel.id}/agents/${a.id}`, { method: on ? 'PUT' : 'DELETE' });
    onChanged();
  }

  const unmentionedHint = channel.kind === 'channel' && channelAgents.length > 0 && text.length > 0 && !/@\w/.test(text);

  return (
    <section className="channel">
      <header className="channel-head">
        <button className="icon nav-toggle" onClick={onToggleNav} aria-label="Buka menu">☰</button>
        <div className="channel-title">
          <h1>{title}</h1>
          {dmAgent && <p className="hint">{dmAgent.name} · {providerLabel[dmAgent.provider]}{dmAgent.model ? ` · ${dmAgent.model}` : ''}</p>}
        </div>
        {channel.kind === 'channel' && (
          <div className="agent-chips">
            {channelAgents.map((a) => (
              <span key={a.id} className="chip"><Avatar kind="agent" name={a.handle} size={16} />{a.handle}</span>
            ))}
            <div className="picker-wrap">
              <button className="ghost" onClick={() => setPicker(!picker)} aria-expanded={picker}>Atur agent</button>
              {picker && (
                <div className="picker" role="menu">
                  {boot.agents.length === 0 && <p className="hint">Belum ada agent. Admin bisa menambahkannya di Pengaturan.</p>}
                  {boot.agents.map((a) => {
                    const on = channelAgents.some((x) => x.id === a.id);
                    return (
                      <label key={a.id} className="check">
                        <input type="checkbox" checked={on} onChange={() => toggleAgent(a, !on)} />
                        @{a.handle} <span className="hint">{providerLabel[a.provider]}</span>
                      </label>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}
      </header>

      <div className="messages" ref={listRef}
        onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}>
        {msgs.length === 0 && (
          <div className="empty">
            {channel.kind === 'channel'
              ? channelAgents.length
                ? <>Mulai dengan menyapa tim, atau tulis <code>@{channelAgents[0].handle}</code> untuk memberi tugas ke agent.</>
                : 'Belum ada pesan. Tambahkan agent lewat tombol "Atur agent" kalau ingin mereka ikut bekerja di sini.'
              : dmAgent ? `Tulis tugas untuk ${dmAgent.name}. Di percakapan pribadi, agent selalu membalas tanpa perlu di-mention.` : 'Belum ada pesan.'}
          </div>
        )}
        {msgs.map((m, i) => {
          const prev = msgs[i - 1];
          const newDay = !prev || new Date(prev.createdAt).toDateString() !== new Date(m.createdAt).toDateString();
          const grouped = !newDay && prev && prev.authorId === m.authorId && prev.status === 'done'
            && new Date(m.createdAt).getTime() - new Date(prev.createdAt).getTime() < 5 * 60_000;
          return (
            <div key={m.id}>
              {newDay && <div className="day"><span>{dayFmt.format(new Date(m.createdAt))}</span></div>}
              <MessageRow m={m} name={nameOf(m)} grouped={!!grouped} />
            </div>
          );
        })}
      </div>

      <div className="composer">
        {suggestions.length > 0 && (
          <ul className="mentions" role="listbox">
            {suggestions.map((a, i) => (
              <li key={a.id}>
                <button className={i === 0 ? 'on' : ''} onMouseDown={(e) => { e.preventDefault(); complete(a); }}>
                  <Avatar kind="agent" name={a.handle} size={18} /> @{a.handle} <span className="hint">{a.name}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {error && <p className="error" role="alert">{error}</p>}
        <div className="composer-box">
          <textarea value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKey} rows={1}
            placeholder={channel.kind === 'channel' ? `Kirim pesan ke ${title}` : `Kirim pesan ke ${title}`} aria-label="Tulis pesan" />
          <button className="primary" onClick={send} disabled={!text.trim()}>Kirim</button>
        </div>
        <p className="composer-hint">
          {unmentionedHint ? 'Agent di channel hanya membalas kalau di-@mention.' : 'Enter untuk kirim · Shift+Enter baris baru'}
        </p>
      </div>
    </section>
  );
}

function MessageRow({ m, name, grouped }: { m: Message; name: string; grouped: boolean }) {
  const isAgent = m.authorType === 'agent';
  const working = m.status === 'pending' || m.status === 'streaming';
  return (
    <article className={`msg ${isAgent ? 'from-agent' : ''} ${grouped ? 'grouped' : ''} ${m.status}`}>
      <div className="msg-gutter">{grouped ? <time>{timeFmt.format(new Date(m.createdAt))}</time> : <Avatar kind={m.authorType} name={name} />}</div>
      <div className="msg-body">
        {!grouped && (
          <header>
            <strong>{isAgent ? `@${name}` : name}</strong>
            <time dateTime={m.createdAt}>{timeFmt.format(new Date(m.createdAt))}</time>
          </header>
        )}
        {working && (
          <p className="working" aria-live="polite">
            <span className="pulse" />{m.status === 'pending' ? 'Mengantre…' : m.activity.length ? m.activity[m.activity.length - 1].label + '…' : 'Sedang berpikir…'}
          </p>
        )}
        {m.content && <Markdown text={m.content} />}
        {m.activity.length > 0 && (
          <details className="activity">
            <summary>{m.activity.length} langkah kerja</summary>
            <ol>
              {m.activity.map((a, i) => (
                <li key={i} className={`act-${a.kind}`}><span>{a.label}</span>{a.detail && <code>{a.detail}</code>}</li>
              ))}
            </ol>
          </details>
        )}
      </div>
    </article>
  );
}
