/**
 * Why a scan says a repository yielded nothing.
 *
 * This looks like cosmetics and is not. The scan's output is the candidate
 * list for the next scan, so a wrong reason sends the next sweep back to
 * repositories that can never work. Fifty candidates were scanned and
 * twenty-five reported "all artifacts expired" when in fact they upload no
 * artifacts at all — `[].every(...)` is `true`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { probeReason } from '../src/harvest.ts';

test('no artifacts at all is not the same fact as artifacts that expired', () => {
  assert.equal(
    probeReason({ sawAnyArtifact: false, sawLiveArtifact: false, sawCandidate: false }),
    'uploads no artifacts at all',
  );
  assert.equal(
    probeReason({ sawAnyArtifact: true, sawLiveArtifact: false, sawCandidate: false }),
    'all artifacts expired',
  );
});

test('the later stages are reported only once the earlier ones passed', () => {
  assert.equal(
    probeReason({ sawAnyArtifact: true, sawLiveArtifact: true, sawCandidate: false }),
    'no test-like artifact',
  );
  assert.equal(
    probeReason({ sawAnyArtifact: true, sawLiveArtifact: true, sawCandidate: true }),
    'artifacts downloaded but nothing parsed to a failure',
  );
});
