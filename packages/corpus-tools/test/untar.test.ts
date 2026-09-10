/**
 * The tar reader.
 *
 * It exists because Maven and Gradle CI often tar their surefire reports before
 * uploading, so the artifact zip holds one `test-reports.tgz` rather than XML.
 * It parses attacker-controlled archives, so the security properties matter at
 * least as much as the happy path:
 *
 *  - a member path never reaches the filesystem, so `../../etc/passwd` is inert
 *  - only regular files are extracted; symlinks and devices are skipped
 *  - every cap is enforced, and a truncated or hostile archive returns what it
 *    could read rather than throwing or looping
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'fflate';
import { DEFAULT_UNTAR_LIMITS, isGzipped, isTarball, untar } from '../src/untar.ts';

const BLOCK = 512;
const enc = new TextEncoder();

/** Build a tar member. `type` is the POSIX typeflag: '0' file, '5' dir, '2' symlink. */
function member(name: string, body: string, type = '0', prefix = ''): Uint8Array {
  const data = enc.encode(body);
  const header = new Uint8Array(BLOCK);
  const put = (s: string, at: number, len: number) => {
    const b = enc.encode(s).subarray(0, len);
    header.set(b, at);
  };
  put(name, 0, 100);
  put('000644 ', 100, 8);
  put('0000000 ', 108, 8);
  put('0000000 ', 116, 8);
  // size: 11 octal digits then NUL
  put(data.length.toString(8).padStart(11, '0'), 124, 12);
  put('00000000000 ', 136, 12);
  put(type, 156, 1);
  put(prefix, 345, 155);
  // checksum: spaces during computation, then the octal sum
  header.fill(32, 148, 156);
  let sum = 0;
  for (const b of header) sum += b;
  put(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);

  const padded = Math.ceil(data.length / BLOCK) * BLOCK;
  const out = new Uint8Array(BLOCK + padded);
  out.set(header, 0);
  out.set(data, BLOCK);
  return out;
}

function tar(...members: Uint8Array[]): Uint8Array {
  const end = new Uint8Array(BLOCK * 2); // two zero blocks terminate
  const parts = [...members, end];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const text = (b: Uint8Array) => new TextDecoder().decode(b);

test('extracts regular files with their contents intact', () => {
  const archive = tar(
    member('target/surefire-reports/TEST-a.xml', '<testsuite name="a"/>'),
    member('target/surefire-reports/TEST-b.xml', '<testsuite name="b"/>'),
  );
  const out = untar(archive);
  assert.deepEqual(Object.keys(out).sort(), [
    'target/surefire-reports/TEST-a.xml',
    'target/surefire-reports/TEST-b.xml',
  ]);
  assert.equal(text(out['target/surefire-reports/TEST-a.xml']!), '<testsuite name="a"/>');
});

test('a member spanning several blocks is reassembled exactly', () => {
  // Sizes either side of a block boundary are where naive readers corrupt data.
  for (const n of [1, 511, 512, 513, 1024, 1025, 5000]) {
    const body = 'x'.repeat(n);
    const out = untar(tar(member('big.xml', body)));
    assert.equal(out['big.xml']?.length, n, `length wrong at ${n}`);
    assert.equal(text(out['big.xml']!), body, `content wrong at ${n}`);
  }
});

test('the POSIX prefix field is joined onto the name', () => {
  const out = untar(tar(member('TEST-c.xml', '<testsuite/>', '0', 'deep/nested/path')));
  assert.ok(out['deep/nested/path/TEST-c.xml'], Object.keys(out).join(','));
});

test('GNU long names are honoured for the member that follows', () => {
  const longName = 'integration-tests/' + 'a'.repeat(120) + '/TEST-long.xml';
  const archive = tar(
    member('././@LongLink', longName + '\0', 'L'),
    member('truncated-name.xml', '<testsuite name="long"/>'),
  );
  const out = untar(archive);
  assert.ok(out[longName], `expected the long name, got ${Object.keys(out).join(',')}`);
  assert.equal(text(out[longName]!), '<testsuite name="long"/>');
});

test('directories, symlinks and devices are skipped rather than followed', () => {
  const archive = tar(
    member('dir/', '', '5'),
    member('evil-link', '/etc/passwd', '2'),
    member('dev-node', '', '3'),
    member('real.xml', '<testsuite/>'),
  );
  const out = untar(archive);
  assert.deepEqual(Object.keys(out), ['real.xml']);
});

test('a traversal path is inert: it becomes a key, never a filesystem write', () => {
  // untar returns a map. Nothing here resolves a path, so the classic tar-slip
  // payload cannot escape anywhere — but the name must survive verbatim so the
  // caller can see and report it.
  const out = untar(tar(member('../../../../etc/passwd', 'root:x:0:0')));
  assert.deepEqual(Object.keys(out), ['../../../../etc/passwd']);
  assert.equal(text(out['../../../../etc/passwd']!), 'root:x:0:0');
});

test('caps are enforced', () => {
  const big = untar(tar(member('big.xml', 'x'.repeat(4096))), {
    ...DEFAULT_UNTAR_LIMITS,
    maxEntryBytes: 1024,
  });
  assert.deepEqual(Object.keys(big), [], 'an oversized member must be skipped');

  const many = untar(
    tar(...Array.from({ length: 40 }, (_, i) => member(`f${i}.xml`, '<testsuite/>'))),
    { ...DEFAULT_UNTAR_LIMITS, maxEntries: 10 },
  );
  assert.ok(Object.keys(many).length <= 10, `entry cap ignored: ${Object.keys(many).length}`);

  const total = untar(
    tar(...Array.from({ length: 10 }, (_, i) => member(`f${i}.xml`, 'y'.repeat(1000)))),
    { ...DEFAULT_UNTAR_LIMITS, maxTotalBytes: 2500 },
  );
  const sum = Object.values(total).reduce((n, b) => n + b.length, 0);
  assert.ok(sum <= 2500, `total cap ignored: ${sum}`);
});

test('malformed input returns what it could read instead of throwing or hanging', () => {
  const good = member('ok.xml', '<testsuite/>');
  const cases: [string, Uint8Array][] = [
    ['empty', new Uint8Array(0)],
    ['all zeroes', new Uint8Array(BLOCK * 4)],
    ['random bytes', Uint8Array.from({ length: 2048 }, (_, i) => (i * 37) % 256)],
    ['header only, body truncated', good.subarray(0, BLOCK + 4)],
    ['truncated mid-header', good.subarray(0, 200)],
    ['good member then garbage', tar(good).map ? concat(good, new Uint8Array([1, 2, 3])) : good],
  ];
  for (const [name, input] of cases) {
    const started = Date.now();
    const out = untar(input);
    assert.ok(typeof out === 'object' && out !== null, `${name}: no result`);
    assert.ok(Date.now() - started < 2000, `${name}: took too long, possible loop`);
  }
});

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

test('gzip is detected by magic bytes, not by the extension', () => {
  const raw = tar(member('a.xml', '<testsuite/>'));
  const gz = gzipSync(raw);

  assert.equal(isGzipped('reports.tgz', gz), true);
  assert.equal(isGzipped('reports.tgz', raw), false, 'a .tgz that is not gzipped must be seen as raw');
  // A plain .tar is never treated as gzipped even if the bytes were compressed.
  assert.equal(isGzipped('reports.tar', gz), false);
});

test('isTarball matches the names CI actually uses', () => {
  for (const n of ['test-reports.tgz', 'reports.tar.gz', 'x.TAR.GZ', 'surefire.tar']) {
    assert.equal(isTarball(n), true, n);
  }
  for (const n of ['report.zip', 'TEST-a.xml', 'results.json', 'notatar.gz']) {
    assert.equal(isTarball(n), false, n);
  }
});
