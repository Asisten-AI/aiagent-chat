import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, providerLabel } from './api';
import type { Agent, Boot, Provider } from './types';
import { Avatar, Modal } from './bits';

type Tab = 'agents' | 'access' | 'people' | 'account' | 'usage';

export function Settings({ boot, meId, onClose, onChanged }: { boot: Boot; meId: string; onClose: () => void; onChanged: () => void }) {
  const [tab, setTab] = useState<Tab>('agents');
  const isAdmin = boot.workspace.role === 'admin';
  const tabs: [Tab, string][] = [['agents', 'Agent'], ['access', 'Akses AI'], ['people', 'Anggota'], ['account', 'Akun'], ['usage', 'Pemakaian']];
  return (
    <Modal title={`Pengaturan ${boot.workspace.name}`} onClose={onClose} wide>
      <div className="tabs" role="tablist">
        {tabs.map(([id, label]) => (
          <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'on' : ''} onClick={() => setTab(id)}>{label}</button>
        ))}
      </div>
      {!isAdmin && ['agents', 'access', 'people'].includes(tab) && <p className="notice">Hanya admin yang bisa mengubah bagian ini.</p>}
      {tab === 'agents' && <Agents boot={boot} isAdmin={isAdmin} onChanged={onChanged} />}
      {tab === 'access' && <Access wid={boot.workspace.id} isAdmin={isAdmin} />}
      {tab === 'people' && <People boot={boot} meId={meId} isAdmin={isAdmin} onChanged={onChanged} />}
      {tab === 'account' && <Account />}
      {tab === 'usage' && <Usage boot={boot} />}
    </Modal>
  );
}

const blank = { name: '', handle: '', provider: 'claude' as Provider, model: '', systemPrompt: '' };

function Agents({ boot, isAdmin, onChanged }: { boot: Boot; isAdmin: boolean; onChanged: () => void }) {
  const [form, setForm] = useState(blank);
  const [editing, setEditing] = useState<Agent | null>(null);
  const [error, setError] = useState('');

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    try {
      if (editing) await api(`/api/agents/${editing.id}`, { method: 'PATCH', body: { name: form.name, model: form.model, systemPrompt: form.systemPrompt } });
      else await api(`/api/workspaces/${boot.workspace.id}/agents`, { body: { ...form, model: form.model || null } });
      setForm(blank); setEditing(null); onChanged();
    } catch (err) { setError((err as Error).message); }
  }

  return (
    <div className="split">
      <ul className="rows">
        {boot.agents.length === 0 && <li className="hint">Belum ada agent.</li>}
        {boot.agents.map((a) => (
          <li key={a.id} className="row">
            <Avatar kind="agent" name={a.handle} size={28} />
            <div><strong>@{a.handle}</strong><span className="hint">{a.name} · {providerLabel[a.provider]}{a.model ? ` · ${a.model}` : ''}</span></div>
            {isAdmin && (
              <span className="row-actions">
                <button className="link" onClick={() => { setEditing(a); setForm({ name: a.name, handle: a.handle, provider: a.provider, model: a.model ?? '', systemPrompt: a.systemPrompt }); }}>Ubah</button>
                <button className="link danger" onClick={async () => {
                  if (confirm(`Hapus @${a.handle}? Riwayat pesannya tetap ada.`)) { await api(`/api/agents/${a.id}`, { method: 'DELETE' }); onChanged(); }
                }}>Hapus</button>
              </span>
            )}
          </li>
        ))}
      </ul>
      {isAdmin && (
        <form className="stack" onSubmit={submit}>
          <h3>{editing ? `Ubah @${editing.handle}` : 'Tambah agent'}</h3>
          <label>Nama tampilan<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Coder Backend" required /></label>
          {!editing && (
            <>
              <label>Handle<input value={form.handle} onChange={(e) => setForm({ ...form, handle: e.target.value.toLowerCase() })} placeholder="coder" pattern="[a-z0-9][a-z0-9_-]{1,30}" required />
                <span className="hint">Dipanggil dengan @{form.handle || 'handle'}</span></label>
              <label>Mesin agent
                <select value={form.provider} onChange={(e) => setForm({ ...form, provider: e.target.value as Provider })}>
                  <option value="claude">Claude Code</option>
                  <option value="codex">Codex</option>
                </select>
              </label>
            </>
          )}
          <label>Model <span className="hint">(opsional, kosongkan untuk default)</span>
            <input value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} placeholder={form.provider === 'claude' ? 'misal: sonnet' : 'misal: gpt-5-codex'} /></label>
          <label>Instruksi khusus
            <textarea rows={5} value={form.systemPrompt} onChange={(e) => setForm({ ...form, systemPrompt: e.target.value })}
              placeholder="Kamu fokus di backend Node.js. Selalu tulis tes untuk perubahan yang kamu buat." /></label>
          {error && <p className="error" role="alert">{error}</p>}
          <div className="actions">
            {editing && <button type="button" className="ghost" onClick={() => { setEditing(null); setForm(blank); }}>Batal</button>}
            <button className="primary">{editing ? 'Simpan perubahan' : 'Tambah agent'}</button>
          </div>
        </form>
      )}
    </div>
  );
}

type CodexState = { loggedIn: boolean; supported: boolean; login: null | { status: 'running' | 'success' | 'failed'; output: string } };
type AccessState = { keys: { provider: string; last4: string }[]; codex: CodexState };

function SecretRow({ wid, kind, title, hint, placeholder, saved, isAdmin, onSaved }: {
  wid: string; kind: string; title: string; hint: string; placeholder: string; saved?: { last4: string }; isAdmin: boolean; onSaved: (m: string) => void;
}) {
  const [value, setValue] = useState('');
  return (
    <form className="key-row" onSubmit={async (e) => {
      e.preventDefault();
      try { await api(`/api/workspaces/${wid}/keys/${kind}`, { method: 'PUT', body: { key: value } }); setValue(''); onSaved(`${title} tersimpan`); }
      catch (err) { onSaved((err as Error).message); }
    }}>
      <div><strong>{title}</strong><span className="hint">{saved ? `Tersimpan, berakhiran …${saved.last4}` : hint}</span></div>
      {isAdmin && (
        <>
          <input type="password" value={value} onChange={(e) => setValue(e.target.value)} placeholder={placeholder} autoComplete="off" aria-label={title} />
          <button className="primary" disabled={!value}>{saved ? 'Ganti' : 'Simpan'}</button>
          {saved && <button type="button" className="link danger" onClick={async () => { await api(`/api/workspaces/${wid}/keys/${kind}`, { method: 'DELETE' }); onSaved(`${title} dihapus`); }}>Hapus</button>}
        </>
      )}
    </form>
  );
}

function Access({ wid, isAdmin }: { wid: string; isAdmin: boolean }) {
  const [state, setState] = useState<AccessState | null>(null);
  const [msg, setMsg] = useState('');
  const load = useCallback(() => api<AccessState>(`/api/workspaces/${wid}/keys`).then(setState), [wid]);
  useEffect(() => { load(); }, [load]);

  const codex = state?.codex;
  useEffect(() => {
    if (codex?.login?.status !== 'running') return;
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, [codex?.login?.status, load]);

  if (!state) return <p className="hint">Memuat…</p>;
  const saved = (k: string) => state.keys.find((x) => x.provider === k);
  const done = (m: string) => { setMsg(m); load(); };
  const using = (sub: boolean, key: boolean) => (sub ? 'langganan' : key ? 'API key' : null);
  const claudeUsing = using(!!saved('claude_oauth'), !!saved('claude'));
  const codexUsing = using(!!codex?.loggedIn && !!codex?.supported, !!saved('codex'));

  return (
    <div className="stack">
      <p className="hint">Agent memakai login langganan lebih dulu. Kalau tidak ada, agent memakai API key. Semua kredensial disimpan terenkripsi atau hanya di server, dan tidak pernah ditampilkan lagi.</p>

      <section className="stack">
        <h3>Claude Code <span className="hint">{claudeUsing ? `· sekarang memakai ${claudeUsing}` : '· belum tersambung'}</span></h3>
        <SecretRow wid={wid} kind="claude_oauth" title="Token langganan Claude" placeholder="sk-ant-oat01-…" isAdmin={isAdmin} saved={saved('claude_oauth')} onSaved={done}
          hint="Dari perintah claude setup-token. Memakai paket Pro/Max-mu." />
        <SecretRow wid={wid} kind="claude" title="API key Anthropic" placeholder="sk-ant-api03-…" isAdmin={isAdmin} saved={saved('claude')} onSaved={done}
          hint="Opsional. Dipakai hanya kalau token langganan belum diisi." />
      </section>

      <section className="stack">
        <h3>Codex <span className="hint">{codexUsing ? `· sekarang memakai ${codexUsing}` : '· belum tersambung'}</span></h3>
        <div className="key-row">
          <div>
            <strong>Login dengan akun ChatGPT</strong>
            <span className="hint">{!codex?.supported ? 'Hanya tersedia di server produksi (runner process).' : codex.loggedIn ? 'Tersambung ke akun ChatGPT.' : 'Memakai paket ChatGPT-mu.'}</span>
          </div>
          {isAdmin && codex?.supported && (codex.loggedIn
            ? <button className="link danger" onClick={async () => { await api(`/api/workspaces/${wid}/codex-login`, { method: 'DELETE' }); done('Login ChatGPT dilepas'); }}>Keluar</button>
            : <button className="primary" disabled={codex.login?.status === 'running'} onClick={async () => { await api(`/api/workspaces/${wid}/codex-login`, { body: {} }); load(); }}>
                {codex.login?.status === 'running' ? 'Menunggu persetujuan…' : 'Login dengan ChatGPT'}
              </button>)}
        </div>
        {codex?.login && !codex.loggedIn && (
          <div className="device-code">
            <p className="hint">{codex.login.status === 'running'
              ? 'Buka tautan di bawah, masuk ke ChatGPT, lalu masukkan kodenya. Halaman ini akan memperbarui statusnya sendiri.'
              : codex.login.status === 'failed' ? 'Login gagal atau kedaluwarsa. Coba lagi.' : 'Login berhasil.'}</p>
            <pre>{codex.login.output || 'Menyiapkan kode…'}</pre>
          </div>
        )}
        <SecretRow wid={wid} kind="codex" title="API key OpenAI" placeholder="sk-…" isAdmin={isAdmin} saved={saved('codex')} onSaved={done}
          hint="Opsional. Dipakai hanya kalau login ChatGPT belum tersambung." />
      </section>
      {msg && <p className="notice" role="status">{msg}</p>}
    </div>
  );
}

function People({ boot, meId, isAdmin, onChanged }: { boot: Boot; meId: string; isAdmin: boolean; onChanged: () => void }) {
  const [form, setForm] = useState({ name: '', email: '', password: '', role: 'member' });
  const [msg, setMsg] = useState('');
  return (
    <div className="split">
      <ul className="rows">
        {boot.people.map((p) => (
          <li key={p.id} className="row">
            <Avatar kind="user" name={p.name} size={28} />
            <div><strong>{p.name}{p.id === meId ? ' (kamu)' : ''}</strong><span className="hint">{p.email}{p.role === 'admin' ? ' · admin' : ''}</span></div>
            {isAdmin && p.id !== meId && (
              <span className="row-actions">
                <button className="link danger" onClick={async () => {
                  if (confirm(`Keluarkan ${p.name} dari workspace ini?`)) { await api(`/api/workspaces/${boot.workspace.id}/members/${p.id}`, { method: 'DELETE' }); onChanged(); }
                }}>Keluarkan</button>
              </span>
            )}
          </li>
        ))}
      </ul>
      {isAdmin && (
        <form className="stack" onSubmit={async (e) => {
          e.preventDefault();
          try {
            await api(`/api/workspaces/${boot.workspace.id}/members`, { body: { ...form, password: form.password || undefined, name: form.name || undefined } });
            setMsg(`Akun ${form.email} siap. Kirim email dan kata sandi sementaranya ke ${form.name || 'anggota itu'}, lalu minta dia menggantinya di Pengaturan → Akun.`);
            setForm({ name: '', email: '', password: '', role: 'member' }); onChanged();
          } catch (err) { setMsg((err as Error).message); }
        }}>
          <h3>Tambah anggota</h3>
          <label>Nama<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Rani" /></label>
          <label>Email<input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required /></label>
          <label>Kata sandi sementara<input value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} minLength={8} autoComplete="off" />
            <span className="hint">Kosongkan kalau orangnya sudah punya akun di aplikasi ini.</span></label>
          <label>Peran
            <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
              <option value="member">Anggota</option>
              <option value="admin">Admin</option>
            </select>
          </label>
          <button className="primary">Tambah anggota</button>
          {msg && <p className="notice" role="status">{msg}</p>}
        </form>
      )}
    </div>
  );
}

function Account() {
  const [form, setForm] = useState({ current: '', next: '' });
  const [msg, setMsg] = useState('');
  return (
    <form className="stack narrow" onSubmit={async (e) => {
      e.preventDefault();
      try { await api('/api/auth/password', { body: form }); setForm({ current: '', next: '' }); setMsg('Kata sandi diganti'); }
      catch (err) { setMsg((err as Error).message); }
    }}>
      <h3>Ganti kata sandi</h3>
      <label>Kata sandi saat ini<input type="password" value={form.current} onChange={(e) => setForm({ ...form, current: e.target.value })} required autoComplete="current-password" /></label>
      <label>Kata sandi baru<input type="password" value={form.next} onChange={(e) => setForm({ ...form, next: e.target.value })} required minLength={8} autoComplete="new-password" /></label>
      <button className="primary">Ganti kata sandi</button>
      {msg && <p className="notice" role="status">{msg}</p>}
    </form>
  );
}

function Usage({ boot }: { boot: Boot }) {
  const [rows, setRows] = useState<{ agentId: string; runs: number; inputTokens: number; outputTokens: number; costUsd: number }[]>([]);
  useEffect(() => { api<typeof rows>(`/api/workspaces/${boot.workspace.id}/usage`).then(setRows); }, [boot.workspace.id]);
  const num = new Intl.NumberFormat('id-ID');
  return (
    <div className="stack">
      <p className="hint">30 hari terakhir. Biaya dalam USD hanya muncul untuk run Claude yang memakai API key.</p>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Agent</th><th>Run</th><th>Token masuk</th><th>Token keluar</th><th>Biaya</th></tr></thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={5} className="hint">Belum ada pemakaian.</td></tr>}
            {rows.map((r) => (
              <tr key={r.agentId}>
                <td>@{boot.agents.find((a) => a.id === r.agentId)?.handle ?? 'dihapus'}</td>
                <td>{num.format(r.runs)}</td><td>{num.format(r.inputTokens)}</td><td>{num.format(r.outputTokens)}</td>
                <td>{r.costUsd ? `$${r.costUsd.toFixed(2)}` : '–'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
