import type { Requirement, Snapshot, SnapshotBaseline } from '../data.ts';
import { num, pct } from '../data.ts';
import { IntervalBar } from '../components/IntervalBar.tsx';

/**
 * A requirement is one of three states, not two.
 *
 * "Not measured" is distinct from "failed": agreement cannot be computed until
 * two labellers overlap, and showing that as a failure would imply the number
 * came out low. The gate blocks either way; the reason differs, and the reason
 * is what tells you what to do next.
 */
function stateOf(r: Requirement): 'met' | 'unmet' | 'blocked' {
  if (r.met) return 'met';
  return Number.isFinite(r.observed) && r.observed > 0 ? 'unmet' : 'blocked';
}

function Req({ r }: { r: Requirement }) {
  const state = stateOf(r);
  const share =
    r.required > 0 && Number.isFinite(r.observed)
      ? Math.max(0, Math.min(1, r.observed / r.required))
      : 0;
  // A rate requirement states a threshold, not a count, so its "observed"
  // reads as a fraction and its progress track would be meaningless.
  const isRate = r.required <= 1 && r.required > 0;

  return (
    <div className={`req ${state}`}>
      <span className="mark" aria-hidden="true" />
      <span className="what">
        {r.description}
        {r.note !== undefined && <span className="why">{r.note}</span>}
      </span>
      {isRate ? (
        <span />
      ) : (
        <span className="track" title={`${r.observed} of ${r.required}`}>
          <span className="fill" style={{ width: `${share * 100}%` }} />
        </span>
      )}
      <span className="figure">
        {Number.isFinite(r.observed) ? <b>{num(r.observed)}</b> : <b>&mdash;</b>}
        <span> / {isRate ? r.required : num(r.required)}</span>
      </span>
    </div>
  );
}

function Baseline({ b }: { b: SnapshotBaseline }) {
  return (
    <div style={{ marginBottom: 18 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: 10,
          flexWrap: 'wrap',
          marginBottom: 6,
        }}
      >
        <span className="mono" style={{ fontSize: 13, fontWeight: 500 }}>
          {b.labeler}
        </span>
        {b.machine && <span className="chip machine">excluded from the gate</span>}
        <span className="eyebrow">
          {num(b.runsScored)} runs &middot; {num(b.pairsScored)} pairs &middot; P{' '}
          {b.precision.toFixed(3)} &middot; R {b.recall.toFixed(3)}
        </span>
      </div>
      <IntervalBar lower={b.lower} upper={b.upper} point={b.f1} />
    </div>
  );
}

export function GateView({ snap }: { snap: Snapshot }) {
  const g = snap.gate;
  const open = g.requirements.filter((r) => !r.met);
  const c = g.concentration;

  return (
    <div className="sheet">
      <div className="pagehead">
        <h2>Gate 0</h2>
        <p>
          No clustering, no classification, no CLI until this gate is met or reported failed. Every
          figure below is computed over the <strong>committable</strong> corpus, so it is
          reproducible from a clone rather than from this machine.
        </p>
      </div>

      <div className={`verdict ${g.met ? 'met' : ''}`}>
        <span className="state">{g.met ? 'GATE 0 MET' : 'GATE 0 NOT MET'}</span>
        <span className="detail">
          {g.requirements.length - open.length} of {g.requirements.length} requirements satisfied
          {open.length > 0 && <> &mdash; {open.length} open</>}
        </span>
      </div>

      <div className="reqs">
        {g.requirements.map((r) => (
          <Req key={r.id} r={r} />
        ))}
      </div>

      {g.heldOut.runs > 0 && (
        <section className="panel">
          <header>
            <h3>Held out of git</h3>
            <span className="note">on disk here, absent from a clone</span>
          </header>
          <div className="body prose">
            <strong>
              {num(g.heldOut.runs)} runs, {num(g.heldOut.failures)} failures,{' '}
              {g.heldOut.repositories} repositories
            </strong>{' '}
            are excluded: copyleft licences, licences GitHub could not identify, and run files too
            large to redistribute. {g.heldOut.runsInBand} of them sit in the 5&ndash;24 failure band.
            A gate computed over them would be a claim about one filesystem rather than a gate.
          </div>
        </section>
      )}

      <section className="panel">
        <header>
          <h3>Run sizes</h3>
          <span className="note">
            {num(c.runsWithPairs)} of {num(g.runs)} runs carry a pair
          </span>
        </header>
        <div className="body">
          <div className="bands">
            {snap.sizeBands.map((b) => {
              const most = Math.max(...snap.sizeBands.map((x) => x.runs), 1);
              return (
                <div key={b.band} className={`band ${b.band === '5-24' ? 'useful' : ''}`}>
                  <span className="label">{b.band}</span>
                  <span className="bar">
                    <i style={{ width: `${(b.runs / most) * 100}%` }} />
                  </span>
                  <span className="n">{num(b.runs)}</span>
                </div>
              );
            })}
          </div>
          <p className="prose" style={{ marginTop: 14 }}>
            The clustering interval bootstraps over <strong>runs</strong>, not failures. A run of one
            contributes no pairs at all; a run of two hundred is a single draw that swamps every
            other. Around <strong>80 labelled runs</strong> is where an F1 lower bound starts to mean
            anything, which is why the 5&ndash;24 band is the one worth growing.
          </p>
        </div>
      </section>

      {snap.baselines.length > 0 && (
        <section className="panel">
          <header>
            <h3>Clustering baseline</h3>
            <span className="note">what the fingerprint rule scores against each labeller</span>
          </header>
          <div className="body">
            {snap.baselines.map((b) => (
              <Baseline key={b.labeler} b={b} />
            ))}
            <p className="prose" style={{ marginTop: 4 }}>
              The width is the point. An interval this wide clears no threshold and rejects none,
              and it narrows with the number of <strong>runs</strong> labelled rather than the
              number of failures. No Gate 1 target is drawn because the specification does not
              state one &mdash; putting a line here would be inventing the thing being measured
              against.
            </p>
          </div>
        </section>
      )}

      <section className="panel">
        <header>
          <h3>Concentration</h3>
          <span className="note">check no one repository carries the result</span>
        </header>
        <div className="body prose">
          Largest run <strong>{pct(c.topRunShare)}</strong> of failures, largest repository{' '}
          <strong>{pct(c.topRepoShare)}</strong>, top three <strong>{pct(c.top3RepoShare)}</strong>.
          Median {c.medianFailuresPerRun} failures per run
          {c.runsOver200Failures > 0 && <>, {c.runsOver200Failures} runs over 200</>}. Frameworks
          seen: {g.frameworksSeen.join(', ')}
          {g.unidentifiedFrameworkFailures > 0 && (
            <>
              {' '}
              &mdash; plus {num(g.unidentifiedFrameworkFailures)} failures whose framework could not
              be identified from evidence, counted as unknown rather than guessed
            </>
          )}
          .
        </div>
      </section>
    </div>
  );
}
