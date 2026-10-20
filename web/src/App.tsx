import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import type { Me } from './types';
import { Auth } from './Auth';
import { Shell } from './Shell';

export function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [wid, setWid] = useState<string | null>(() => localStorage.getItem('ruang:ws'));

  const load = useCallback(async () => {
    try {
      const m = await api<Me>('/api/me');
      setMe(m);
      setWid((cur) => (cur && m.workspaces.some((w) => w.id === cur) ? cur : m.workspaces[0]?.id ?? null));
    } catch {
      setMe(null);
    }
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (wid) localStorage.setItem('ruang:ws', wid); }, [wid]);

  if (me === undefined) return <div className="splash">Memuat…</div>;
  if (me === null || !wid) return <Auth onDone={load} />;
  return (
    <Shell
      key={wid}
      me={me}
      workspaceId={wid}
      onSwitch={setWid}
      onReloadMe={load}
      onLogout={async () => { await api('/api/auth/logout', { body: {} }); setMe(null); }}
    />
  );
}
