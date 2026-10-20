import { useMemo, type ReactNode } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

marked.setOptions({ gfm: true, breaks: true });

/** Manusia = lingkaran, agent = bentuk bersudut terpotong. Bentuk itu satu-satunya
 *  penanda visual pembeda yang konsisten di seluruh aplikasi. */
export function Avatar({ kind, name, size = 36 }: { kind: 'user' | 'agent'; name: string; size?: number }) {
  return (
    <span className={`av ${kind === 'agent' ? 'agent' : 'human'}`} style={{ width: size, height: size, fontSize: size * 0.42 }} aria-hidden="true">
      {name.replace(/^@/, '').slice(0, 1).toUpperCase()}
    </span>
  );
}

export function Markdown({ text }: { text: string }) {
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(text, { async: false }) as string), [text]);
  return <div className="md" dangerouslySetInnerHTML={{ __html: html }} />;
}

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}
        onKeyDown={(e) => e.key === 'Escape' && onClose()}>
        <header>
          <h2>{title}</h2>
          <button className="icon" onClick={onClose} aria-label="Tutup">✕</button>
        </header>
        {children}
      </div>
    </div>
  );
}
