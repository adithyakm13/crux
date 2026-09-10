/**
 * Minimal tar reader, for gzipped tarballs nested inside artifact zips.
 *
 * Why this exists: Maven and Gradle CI frequently tar their surefire reports
 * before uploading, so the artifact zip contains one `test-reports.tgz` rather
 * than the XML itself. The harvester unwrapped nested `.zip` and nothing else,
 * so `pickAdapter` saw a `.tgz`, matched no adapter, and the whole artifact was
 * discarded. quarkusio/quarkus was verified by hand to carry 1126 JUnit XML
 * files and 248 failures in a single such artifact, and the harvester returned
 * zero from it.
 *
 * Only what is needed to read a reports tarball is implemented: regular files
 * and the GNU/POSIX long-name extensions. Symlinks, devices and hard links are
 * skipped rather than followed — the input is attacker-controlled, and nothing
 * here should ever touch the filesystem.
 */

const BLOCK = 512;

export interface UntarLimits {
  /** Skip any single member larger than this. */
  maxEntryBytes: number;
  /** Stop once this much has been extracted in total. */
  maxTotalBytes: number;
  /** Refuse a tarball with more members than this. */
  maxEntries: number;
}

export const DEFAULT_UNTAR_LIMITS: UntarLimits = {
  maxEntryBytes: 32 * 1024 * 1024,
  maxTotalBytes: 256 * 1024 * 1024,
  maxEntries: 20_000,
};

function readString(buf: Uint8Array, offset: number, length: number): string {
  let end = offset;
  const limit = offset + length;
  while (end < limit && buf[end] !== 0) end++;
  return new TextDecoder('utf-8', { fatal: false }).decode(buf.subarray(offset, end));
}

/** Tar sizes are octal, space- or NUL-padded. Base-256 is used for huge files. */
function readSize(buf: Uint8Array, offset: number): number {
  const first = buf[offset] ?? 0;
  if ((first & 0x80) !== 0) {
    // base-256: rare, and only for members far past any cap we apply
    let n = first & 0x7f;
    for (let i = 1; i < 12; i++) n = n * 256 + (buf[offset + i] ?? 0);
    return n;
  }
  const raw = readString(buf, offset, 12).trim();
  if (raw === '') return 0;
  const n = Number.parseInt(raw, 8);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/**
 * Extract regular files from an uncompressed tar image.
 *
 * Returns member paths exactly as recorded, for reporting only. Nothing here
 * resolves a path against the filesystem, so a member named `../../etc/passwd`
 * is inert — it becomes a map key and nothing more.
 */
export function untar(
  data: Uint8Array,
  limits: UntarLimits = DEFAULT_UNTAR_LIMITS,
): Record<string, Uint8Array> {
  const out: Record<string, Uint8Array> = {};
  let offset = 0;
  let total = 0;
  let count = 0;
  /** Set by a preceding GNU long-name (type 'L') or POSIX PAX path header. */
  let pendingName: string | null = null;

  while (offset + BLOCK <= data.length) {
    const header = data.subarray(offset, offset + BLOCK);

    // Two consecutive zero blocks terminate the archive; one is enough for us.
    let allZero = true;
    for (let i = 0; i < BLOCK; i++) {
      if (header[i] !== 0) {
        allZero = false;
        break;
      }
    }
    if (allZero) break;

    const name = pendingName ?? readString(header, 0, 100);
    pendingName = null;
    const size = readSize(header, 124);
    const typeFlag = String.fromCharCode(header[156] ?? 0);
    const prefix = readString(header, 345, 155);
    const full = prefix !== '' ? `${prefix}/${name}` : name;

    const dataStart = offset + BLOCK;
    const padded = Math.ceil(size / BLOCK) * BLOCK;
    if (dataStart + size > data.length) break; // truncated archive

    if (typeFlag === 'L' || typeFlag === 'K') {
      // GNU long name / long link: the member body IS the next member's name.
      pendingName = readString(data.subarray(dataStart, dataStart + size), 0, size).replace(
        /\0+$/,
        '',
      );
      offset = dataStart + padded;
      continue;
    }

    // '0' and '\0' are regular files; everything else (dir, symlink, device,
    // pax header) is skipped rather than interpreted.
    const isFile = typeFlag === '0' || typeFlag === '\0' || typeFlag === '7';
    if (isFile && size > 0 && size <= limits.maxEntryBytes && total + size <= limits.maxTotalBytes) {
      if (++count > limits.maxEntries) break;
      out[full] = data.subarray(dataStart, dataStart + size);
      total += size;
    }

    offset = dataStart + padded;
  }

  return out;
}

/** True for names crux should try to un-tar. */
export function isTarball(name: string): boolean {
  const n = name.toLowerCase();
  return n.endsWith('.tgz') || n.endsWith('.tar.gz') || n.endsWith('.tar');
}

export function isGzipped(name: string, bytes: Uint8Array): boolean {
  const n = name.toLowerCase();
  if (n.endsWith('.tar')) return false;
  // gzip magic, checked rather than trusted from the extension
  return bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}
