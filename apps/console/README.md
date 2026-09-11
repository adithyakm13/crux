# crux console

A static site over the Gate 0 evidence: what the corpus contains, who has
labelled it, and the intervals every claim is stated in.

```
pnpm console          # regenerate the snapshot and serve with HMR
pnpm console:build    # typecheck, regenerate, build to apps/console/dist
```

## It derives, it does not compute

The console reads one file, `public/corpus.json`, produced by
`corpus snapshot`. Every gate figure in it comes from `gateZeroStatus` — the
same function the CLI prints from. A console that computed its own numbers
would be a second implementation of the gate, and the two would drift until
both claimed to be Gate 0. `snapshot.test.ts` asserts the gate block is
identical to the CLI's.

That also makes the site deployable anywhere: no server, no API, `base: './'`
so it works from a subpath or from `file://`.

## What the design argues

Every claim this project makes is a rate with a confidence interval, and a gate
passes on the **lower bound**. So the interval bar is the primary object and the
point estimate is a tick inside it, not a headline. The two baselines on the
Gate page make the argument without a word of explanation: the same fingerprint
rule scores 0.80 against 4 labelled runs and 0.73 against 191, and the first
interval is nearly three times wider. Reading either point estimate alone is
reading half the sentence.

No Gate 1 threshold is drawn on those bars, because the specification does not
state one. A dashed line there would be inventing the thing being measured
against.

Three other things the interface refuses to smooth over:

- **Held out of git** is stated above the gate table, not below it, because it
  changes what every number in that table is a number about. Figures are
  computed over the committable corpus so they reproduce from a clone.
- **Machine labels** are drawn dashed, greyed, and captioned *excluded from
  every gate*. Gate 0 asks what a human concludes.
- **Not measured** is a third requirement state, distinct from failed. Agreement
  cannot be computed until two labellers overlap, and showing that as a failure
  would imply the number came out low.

## Structure

```
src/
  data.ts                 types mirroring snapshot.ts, plus the loader
  components/IntervalBar  the signature object
  views/GateView          requirements, hold-out, run sizes, baselines
  views/CorpusView        filterable run table
  views/LabellingView     labeller progress and what is still blocked
```

Theme follows the viewer and can be overridden; the unset state is the common
one and is styled first.
