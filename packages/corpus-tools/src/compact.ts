/**
 * Caps on stored payload.
 *
 * A failure record holds message, stack, stdout and stderr as the CI run
 * emitted them, and CI emits without limit. One quarkus run carried 1549
 * failures whose stack, stdout and stderr averaged about a megabyte each:
 * 147 MB in one file, past GitHub's 100 MB limit and far past anything a
 * person could read while labelling.
 *
 * So the payload is capped. Two rules make the cap honest:
 *
 *  - the original length is recorded in `truncated`, so a record that was cut
 *    says so and by how much. A labeller judging a truncated stack is judging
 *    different evidence than the run produced, and a corpus that hides that is
 *    not a ground truth.
 *  - the cut keeps the head and the tail rather than just the head. The
 *    proximate frame is at the top of a stack and the root cause is often at
 *    the bottom ("Caused by:" chains, pytest's final assertion), so a
 *    head-only cut discards the half that usually carries the answer.
 */

const marker = (omitted: number) =>
  `\n\n... [crux: truncated, ${omitted} characters omitted] ...\n\n`;

/** Default cap per text field. Generous for a stack, tiny against a log dump. */
export const DEFAULT_MAX_FIELD_BYTES = 64 * 1024;

export const TRUNCATABLE = ['message', 'stackText', 'stdout', 'stderr'] as const;

/**
 * Cut to fit INSIDE `maxBytes`, marker included.
 *
 * The marker has to come out of the budget rather than be added to it, or the
 * result is longer than the cap and a second pass cuts it again — compounding
 * the loss and overwriting the record of what the run originally produced.
 */
export function truncateField(value: string, maxBytes: number): string {
  if (value.length <= maxBytes) return value;
  const reserve = marker(value.length).length;
  const budget = Math.max(0, maxBytes - reserve);
  // Two thirds head, one third tail: the proximate frame leads, but "Caused
  // by" chains and final assertions land at the end.
  const head = Math.floor((budget * 2) / 3);
  const tail = budget - head;
  const omitted = value.length - head - tail;
  return value.slice(0, head) + marker(omitted) + (tail > 0 ? value.slice(value.length - tail) : '');
}

export interface CompactResult {
  fieldsTruncated: number;
  charactersDropped: number;
}

/**
 * Cap every truncatable field on a failure record, in place.
 *
 * Idempotent: a field already at or under the cap is untouched, and a record
 * already carrying `truncated` for a field is not re-marked, so running this
 * twice does not compound the record of what was lost.
 */
export function compactFailure(
  failure: Record<string, unknown>,
  maxBytes: number = DEFAULT_MAX_FIELD_BYTES,
): CompactResult {
  let fieldsTruncated = 0;
  let charactersDropped = 0;
  for (const field of TRUNCATABLE) {
    const value = failure[field];
    if (typeof value !== 'string' || value.length <= maxBytes) continue;
    const original = value.length;
    failure[field] = truncateField(value, maxBytes);
    const record = (failure['truncated'] ??= {}) as Record<string, number>;
    // Keep the FIRST original length seen: that is the length the CI run
    // actually produced, and a second pass must not overwrite it with the
    // already-shortened one.
    record[field] ??= original;
    fieldsTruncated++;
    charactersDropped += original - (failure[field] as string).length;
  }
  return { fieldsTruncated, charactersDropped };
}
