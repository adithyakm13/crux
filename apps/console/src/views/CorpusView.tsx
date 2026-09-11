import { useMemo, useState } from 'react';
import type { Snapshot, SnapshotRun } from '../data.ts';
import { num } from '../data.ts';

type SortKey = 'failures' | 'repo' | 'harvestedAt' | 'bytes';

const COLUMNS: { key: SortKey | null; label: string; numeric?: boolean }[] = [
  { key: 'repo', label: 'repository' },
  { key: null, label: 'workflow' },
  { key: null, label: 'frameworks' },
  { key: 'failures', label: 'failures', numeric: true },
  { key: null, label: 'licence' },
  { key: 'harvestedAt', label: 'harvested' },
];

export function CorpusView({ snap }: { snap: Snapshot }) {
  const [query, setQuery] = useState('');
  const [framework, setFramework] = useState('all');
  const [band, setBand] = useState('all');
  const [held, setHeld] = useState('committable');
  const [sort, setSort] = useState<SortKey>('failures');
  const [desc, setDesc] = useState(true);

  const frameworks = useMemo(() => {
    const seen = new Set<string>();
    for (const r of snap.runs) for (const f of r.frameworks) seen.add(f);
    return [...seen].sort();
  }, [snap]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const out = snap.runs.filter((r) => {
      if (held === 'committable' && r.heldOut !== null) return false;
      if (held === 'heldout' && r.heldOut === null) return false;
      if (framework !== 'all' && !r.frameworks.includes(framework)) return false;
      if (band === 'band' && (r.failures < 5 || r.failures > 24)) return false;
      if (band === 'pairs' && r.failures < 2) return false;
      if (q !== '' && !`${r.repo} ${r.workflow ?? ''} ${r.id}`.toLowerCase().includes(q)) {
        return false;
      }
      return true;
    });
    const dir = desc ? -1 : 1;
    return out.sort((a, b) => {
      const av = a[sort];
      const bv = b[sort];
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
      return String(av ?? '').localeCompare(String(bv ?? '')) * dir;
    });
  }, [snap, query, framework, band, held, sort, desc]);

  const failures = rows.reduce((n, r) => n + r.failures, 0);

  return (
    <div className="sheet">
      <div className="pagehead">
        <h2>Corpus</h2>
        <p>
          Real failed CI runs, harvested with their licence recorded. Nothing here is synthetic and
          nothing was written by hand &mdash; a corpus that contains an example someone invented
          cannot falsify anything.
        </p>
      </div>

      <section className="panel">
        <div className="controls">
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="repository or workflow"
            aria-label="Filter by repository or workflow"
          />
          <select value={held} onChange={(e) => setHeld(e.target.value)} aria-label="Git status">
            <option value="committable">committable</option>
            <option value="heldout">held out</option>
            <option value="all">all on disk</option>
          </select>
          <select
            value={framework}
            onChange={(e) => setFramework(e.target.value)}
            aria-label="Framework"
          >
            <option value="all">any framework</option>
            {frameworks.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
          <select value={band} onChange={(e) => setBand(e.target.value)} aria-label="Run size">
            <option value="all">any size</option>
            <option value="band">5&ndash;24 failures</option>
            <option value="pairs">carries a pair</option>
          </select>
          <span className="count">
            {num(rows.length)} runs &middot; {num(failures)} failures
          </span>
        </div>

        <div className="tablewrap">
          <table className="grid">
            <thead>
              <tr>
                {COLUMNS.map((c) => (
                  <th
                    key={c.label}
                    onClick={() => {
                      if (c.key === null) return;
                      if (c.key === sort) setDesc(!desc);
                      else {
                        setSort(c.key);
                        setDesc(true);
                      }
                    }}
                    {...(c.key !== null && c.key === sort
                      ? { 'aria-sort': desc ? ('descending' as const) : ('ascending' as const) }
                      : {})}
                    style={c.numeric ? { textAlign: 'right' } : undefined}
                  >
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <Row key={r.id} run={r} />
              ))}
            </tbody>
          </table>
          {rows.length === 0 && <div className="empty">No runs match those filters.</div>}
        </div>
      </section>
    </div>
  );
}

function Row({ run }: { run: SnapshotRun }) {
  return (
    <tr>
      <td>
        <div className="mono" style={{ fontSize: 12 }}>
          {run.repo}
        </div>
        {run.heldOut !== null && (
          <span className="chip held" title={run.heldOut}>
            held out
          </span>
        )}
      </td>
      <td style={{ color: 'var(--ink-2)' }}>{run.workflow ?? '—'}</td>
      <td>
        {run.frameworks.map((f) => (
          <span key={f} className="chip" style={{ marginRight: 4 }}>
            {f}
          </span>
        ))}
      </td>
      <td className="num">{num(run.failures)}</td>
      <td className="mono" style={{ fontSize: 11.5 }}>
        {run.license}
      </td>
      <td className="num" style={{ color: 'var(--muted)' }}>
        {run.harvestedAt !== null ? run.harvestedAt.slice(0, 10) : '—'}
      </td>
    </tr>
  );
}
