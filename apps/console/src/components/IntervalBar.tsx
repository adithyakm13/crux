/**
 * The page's primary object.
 *
 * Every claim this project makes is a rate with a confidence interval, and a
 * gate passes on the LOWER bound — so the interval is drawn full width, the
 * threshold is a hard line across it, and the point estimate is a tick rather
 * than a headline. Reading the point estimate alone should feel like reading
 * half the sentence.
 */

interface Props {
  lower: number;
  upper: number;
  point: number;
  /** Omitted when no threshold has been stated; the bar then shows only the interval. */
  threshold?: number;
  /** Domain end. Rates are 0-1; leave at 1 unless the figure is not a rate. */
  max?: number;
}

export function IntervalBar({ lower, upper, point, threshold, max = 1 }: Props) {
  const at = (v: number) => `${Math.max(0, Math.min(1, v / max)) * 100}%`;
  const clears = threshold !== undefined && lower >= threshold;

  return (
    <div className="interval">
      <div className="scale">
        <div className="axis" />
        <div
          className="span"
          style={{ left: at(lower), width: `calc(${at(upper)} - ${at(lower)})` }}
          title={`95% interval ${lower.toFixed(3)} to ${upper.toFixed(3)}`}
        />
        <div className="point" style={{ left: at(point) }} title={`point estimate ${point.toFixed(3)}`} />
        {threshold !== undefined && (
          <div className="threshold" style={{ left: at(threshold) }}>
            <b>{threshold.toFixed(2)}</b>
          </div>
        )}
      </div>
      <div className="legend">
        <span>{lower.toFixed(3)} lower</span>
        <span
          style={
            threshold === undefined
              ? undefined
              : { color: clears ? 'var(--pass)' : 'var(--fail)' }
          }
        >
          {threshold === undefined
            ? `point ${point.toFixed(3)}`
            : clears
              ? 'clears the threshold'
              : 'below the threshold'}
        </span>
        <span>{upper.toFixed(3)} upper</span>
      </div>
    </div>
  );
}
