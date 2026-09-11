import { useEffect, useState } from 'react';
import { loadSnapshot, type Snapshot } from './data.ts';
import { GateView } from './views/GateView.tsx';
import { CorpusView } from './views/CorpusView.tsx';
import { LabellingView } from './views/LabellingView.tsx';

type Tab = 'gate' | 'corpus' | 'labelling';

/**
 * Theme is a three-state setting, not a toggle: an explicit choice, or the
 * operating system's. Unset is the common case and must render correctly.
 */
function useTheme() {
  const [theme, setTheme] = useState<'system' | 'light' | 'dark'>(() => {
    try {
      const v = localStorage.getItem('crux.theme');
      return v === 'light' || v === 'dark' ? v : 'system';
    } catch {
      return 'system';
    }
  });
  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', theme);
    try {
      localStorage.setItem('crux.theme', theme);
    } catch {
      /* private window: the choice simply does not persist */
    }
  }, [theme]);
  return [theme, setTheme] as const;
}

export function App() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('gate');
  const [theme, setTheme] = useTheme();

  useEffect(() => {
    loadSnapshot().then(setSnap, (e: unknown) => setError(String((e as Error).message ?? e)));
  }, []);

  if (error !== null) {
    return (
      <div className="main">
        <div className="sheet">
          <div className="pagehead">
            <h2>No snapshot</h2>
            <p>{error}</p>
          </div>
        </div>
      </div>
    );
  }
  if (snap === null) {
    return (
      <div className="main">
        <div className="empty">Reading the corpus…</div>
      </div>
    );
  }

  const open = snap.gate.requirements.filter((r) => !r.met).length;
  const humans = snap.labelers.filter((l) => !l.machine).length;

  return (
    <div className="app">
      <nav className="rail">
        <div className="brand">
          <h1>crux</h1>
          <div className="tag">
            Gate 0 evidence.
            <br />
            Nothing ships until it is met or reported failed.
          </div>
        </div>

        <div className="nav">
          <button onClick={() => setTab('gate')} aria-current={tab === 'gate'}>
            Gate 0 <span className="n">{open} open</span>
          </button>
          <button onClick={() => setTab('corpus')} aria-current={tab === 'corpus'}>
            Corpus <span className="n">{snap.gate.runs}</span>
          </button>
          <button onClick={() => setTab('labelling')} aria-current={tab === 'labelling'}>
            Labelling <span className="n">{humans}</span>
          </button>
        </div>

        <div className="foot">
          Snapshot {snap.generatedAt.slice(0, 16).replace('T', ' ')} UTC
          <br />
          <button
            onClick={() => setTheme(theme === 'dark' ? 'light' : theme === 'light' ? 'system' : 'dark')}
          >
            theme: {theme}
          </button>
        </div>
      </nav>

      <main className="main">
        {tab === 'gate' && <GateView snap={snap} />}
        {tab === 'corpus' && <CorpusView snap={snap} />}
        {tab === 'labelling' && <LabellingView snap={snap} />}
      </main>
    </div>
  );
}
