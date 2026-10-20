import { useEffect, useState, type FormEvent } from 'react';
import { api } from './api';

export function Auth({ onDone }: { onDone: () => void }) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [form, setForm] = useState({ email: '', password: '', name: '', workspaceName: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // Pendaftaran hanya terbuka sekali, untuk admin pertama.
  useEffect(() => {
    api<{ needsSetup: boolean }>('/api/auth/setup').then((r) => setMode(r.needsSetup ? 'register' : 'login')).catch(() => {});
  }, []);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      if (mode === 'login') await api('/api/auth/login', { body: { email: form.email, password: form.password } });
      else await api('/api/auth/register', { body: { ...form, workspaceName: form.workspaceName || undefined } });
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth">
      <section className="auth-intro">
        <h1>AI Agent Chat</h1>
        <p>Tempat timmu mengobrol dan bekerja bareng agent AI. Panggil <code>@agent</code> di channel, dan dia mengerjakan tugasnya langsung di folder kerja channel itu.</p>
        <div className="auth-demo" aria-hidden="true">
          <div className="demo-row"><span className="av human">R</span><p><b>Rani</b> @coder tolong buat endpoint ekspor CSV</p></div>
          <div className="demo-row"><span className="av agent">C</span><p><b>coder</b> Sudah. Saya tambahkan <code>/export.csv</code> dan tesnya lulus.</p></div>
        </div>
      </section>
      <form className="auth-card" onSubmit={submit}>
        <h2>{mode === 'login' ? 'Masuk' : 'Buat akun admin'}</h2>
        {mode === 'register' && <p className="hint">Ini akun pertama di aplikasi. Anggota tim lain nanti kamu buatkan dari Pengaturan.</p>}
        {mode === 'register' && (
          <label>Nama<input value={form.name} onChange={set('name')} required autoComplete="name" /></label>
        )}
        <label>Email<input type="email" value={form.email} onChange={set('email')} required autoComplete="email" /></label>
        <label>Kata sandi<input type="password" value={form.password} onChange={set('password')} required minLength={mode === 'register' ? 8 : 1} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} /></label>
        {mode === 'register' && (
          <label>Nama workspace <span className="hint">(opsional)</span><input value={form.workspaceName} onChange={set('workspaceName')} placeholder="Asisten AI" /></label>
        )}
        {error && <p className="error" role="alert">{error}</p>}
        <button className="primary" disabled={busy}>{busy ? 'Sebentar…' : mode === 'login' ? 'Masuk' : 'Buat akun admin'}</button>
        {mode === 'login' && <p className="hint">Belum punya akun? Minta admin timmu membuatkannya.</p>}
      </form>
    </main>
  );
}
