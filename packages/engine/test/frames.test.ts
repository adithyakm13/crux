import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseStack } from '../src/frames.ts';

test('every dialect parses Windows absolute paths as well as POSIX ones', () => {
  // Regression: the Go, Vitest and Ruby patterns bounded the file group with a
  // class excluding ':' and anchored at the line start, so a `C:` drive prefix
  // matched no parser and the frame was silently dropped — on Windows only,
  // which is exactly the cross-platform determinism §6 gates on.
  const B = String.fromCharCode(92);
  const cases: [string, string, string][] = [
    ['pytest', '  File "tests/test_a.py", line 5, in test_x',
      `  File "C:${B}proj${B}tests${B}test_a.py", line 5, in test_x`],
    ['go', '\tsrc/main.go:42 +0x1', `\tC:${B}proj${B}src${B}main.go:42 +0x1`],
    ['ruby', "\tapp/models/u.rb:12:in `save'", `\tC:${B}proj${B}app${B}u.rb:12:in \`save'`],
    ['vitest', ' ❯ run src/a.ts:9:3', ` ❯ run C:${B}proj${B}src${B}a.ts:9:3`],
    ['v8', '    at fn (src/a.ts:1:2)', `    at fn (C:${B}proj${B}src${B}a.ts:1:2)`],
  ];
  for (const [dialect, posix, windows] of cases) {
    assert.equal(parseStack(posix).length, 1, `${dialect}: POSIX form did not parse`);
    assert.equal(parseStack(windows).length, 1, `${dialect}: Windows form did not parse`);
  }
});
