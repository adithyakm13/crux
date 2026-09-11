import type { Snapshot, SnapshotLabeler } from '../data.ts';
import { num } from '../data.ts';

const ORDER = [
  'PRODUCT_REGRESSION',
  'TEST_DEFECT',
  'FLAKY',
  'ENVIRONMENT_FAILURE',
  'DEPENDENCY_FAILURE',
  'DATA_FAILURE',
  'PERFORMANCE_REGRESSION',
  'UNKNOWN',
];

function Card({ l }: { l: SnapshotLabeler }) {
  const most = Math.max(1, ...Object.values(l.categories));
  const present = ORDER.filter((c) => (l.categories[c] ?? 0) > 0);

  return (
    <article className={`labeller ${l.machine ? 'machine' : ''}`}>
      <h3>{l.name}</h3>
      <div className="sub">
        {num(l.failures)} failures across {num(l.runs)} runs &middot; {l.contexts.join(', ')}
        {l.machine && ' · excluded from every gate'}
      </div>
      <div className="cats">
        {present.map((c) => {
          const n = l.categories[c] ?? 0;
          return (
            <div key={c} className="cat">
              <span className="name" title={c}>
                {c.toLowerCase().replace(/_/g, ' ')}
              </span>
              <span className="n">{n}</span>
              <span className="bar">
                <i style={{ width: `${(n / most) * 100}%` }} />
              </span>
            </div>
          );
        })}
      </div>
    </article>
  );
}

export function LabellingView({ snap }: { snap: Snapshot }) {
  const human = snap.labelers.filter((l) => !l.machine);
  const machine = snap.labelers.filter((l) => l.machine);

  return (
    <div className="sheet">
      <div className="pagehead">
        <h2>Labelling</h2>
        <p>
          Gate 0 asks what a <strong>human</strong> concludes. Machine labels are kept for
          development and quarantined by a <span className="mono">machine:</span> prefix &mdash;
          they are excluded from every count on the Gate page, and a corpus that counted them would
          be measuring a model against itself.
        </p>
      </div>

      {human.length === 0 ? (
        <div className="panel">
          <div className="empty">
            No human labels yet. Agreement and separability cannot be computed until two labellers
            cover the same runs.
          </div>
        </div>
      ) : (
        <div className="labellers">
          {human.map((l) => (
            <Card key={l.name} l={l} />
          ))}
        </div>
      )}

      {human.length < 2 && (
        <section className="panel">
          <header>
            <h3>What is still blocked</h3>
          </header>
          <div className="body prose">
            <p style={{ marginTop: 0 }}>
              <strong>Inter-labeller agreement</strong> needs two people labelling the same subset
              independently &mdash; Cohen&rsquo;s kappa on category, pairwise agreement on grouping.
              Tooling cannot produce this number.
            </p>
            <p>
              <strong>Separability</strong> needs a labeller who sees only the failure payload,
              scored against the full-context label. It is the figure the Gate 0 stop condition is
              actually stated in.
            </p>
            <p style={{ marginBottom: 0 }}>
              Both are per-failure statistics, so around 150 failures is a real sample for them
              &mdash; unlike the clustering metric, which is pair-based and collapses to the number
              of runs.
            </p>
          </div>
        </section>
      )}

      {machine.length > 0 && (
        <section className="panel">
          <header>
            <h3>Quarantined</h3>
            <span className="note">present on disk, absent from every gate</span>
          </header>
          <div className="body">
            <div className="labellers">
              {machine.map((l) => (
                <Card key={l.name} l={l} />
              ))}
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
