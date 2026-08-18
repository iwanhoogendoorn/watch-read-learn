/**
 * Just enough ZIP to read a Trakt export, and no dependency.
 *
 * Trakt is the only source that ships an archive, and it ships an ordinary one:
 * a handful of JSON files, stored or deflated, no encryption, no spanning. That
 * is roughly two hundred bytes of format — an end-of-central-directory record,
 * a central directory, and a local header per entry — plus one call to
 * `DecompressionStream("deflate-raw")` for the actual inflate.
 *
 * `DecompressionStream` is why this needs no library. It is a platform API:
 * Chromium 103+, Safari 16.4+, Node 18+, which covers Obsidian desktop
 * (Electron), Obsidian mobile (system webview) and vitest. Pulling in `fflate`
 * or `jszip` to ship a second, slower copy of something the runtime already has
 * would be a dependency bought with nothing.
 *
 * It is feature-detected rather than assumed, because a runtime that lacks it
 * should say so (`readZip` throws a sentence a user can act on) instead of
 * failing somewhere deep in a parser with a JSON syntax error.
 */

const EOCD_SIGNATURE = 0x06054b50;
const EOCD_MIN_SIZE = 22;
const CENTRAL_SIGNATURE = 0x02014b50;
const CENTRAL_HEADER_SIZE = 46;
const LOCAL_SIGNATURE = 0x04034b50;
const LOCAL_HEADER_SIZE = 30;

/** ZIP64 marker: a 32-bit field holding this means "read the real value from the extra field". */
const U32_MAX = 0xffffffff;
const ZIP64_EXTRA_ID = 0x0001;

const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;

/** One entry, decoded. Directory entries are dropped before this point. */
export interface ZipEntry {
  /** The full path inside the archive, e.g. `trakt-exports/watched-movies.json`. */
  path: string;
  bytes: Uint8Array;
}

export class ZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZipError";
  }
}

function decompressionAvailable(): boolean {
  return typeof DecompressionStream === "function";
}

/**
 * Inflate a raw DEFLATE stream.
 *
 * `deflate-raw` and not `deflate`: a ZIP entry's payload has no zlib header, and
 * feeding it to the wrapped decoder fails on the first two bytes.
 */
async function inflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  const buffer = await new Response(stream).arrayBuffer();
  return new Uint8Array(buffer);
}

/**
 * The extra field is a sequence of `{id, size, payload}` blocks. Only ZIP64's is
 * read, and only for the fields that were flagged as overflowed — the order of
 * the values inside it is defined by *which* fields overflowed, not by the spec
 * listing them all.
 */
function readZip64Extra(
  view: DataView,
  start: number,
  length: number,
  wants: { size: boolean; compressed: boolean; offset: boolean },
): { size?: number; compressed?: number; offset?: number } {
  let cursor = start;
  const end = start + length;
  while (cursor + 4 <= end) {
    const id = view.getUint16(cursor, true);
    const size = view.getUint16(cursor + 2, true);
    const payload = cursor + 4;
    if (id !== ZIP64_EXTRA_ID) {
      cursor = payload + size;
      continue;
    }
    const out: { size?: number; compressed?: number; offset?: number } = {};
    let at = payload;
    const take = (): number => {
      // `getBigUint64` because the field is 64-bit; a ZIP entry larger than
      // `Number.MAX_SAFE_INTEGER` is not a case this plugin has to survive.
      const value = Number(view.getBigUint64(at, true));
      at += 8;
      return value;
    };
    if (wants.size && at + 8 <= payload + size) out.size = take();
    if (wants.compressed && at + 8 <= payload + size) out.compressed = take();
    if (wants.offset && at + 8 <= payload + size) out.offset = take();
    return out;
  }
  return {};
}

/** Scan backwards for the end-of-central-directory record. */
function findEocd(view: DataView): number {
  const max = Math.min(view.byteLength, EOCD_MIN_SIZE + 0xffff);
  for (let back = EOCD_MIN_SIZE; back <= max; back += 1) {
    const at = view.byteLength - back;
    if (at < 0) break;
    if (view.getUint32(at, true) === EOCD_SIGNATURE) return at;
  }
  return -1;
}

/**
 * Read every file in a ZIP archive.
 *
 * Entries are read through the **central directory**, not by walking local
 * headers: a local header may carry zeroed sizes with the real ones in a data
 * descriptor after the payload, and the central directory always has them.
 */
export async function readZip(source: ArrayBuffer | Uint8Array): Promise<ZipEntry[]> {
  const bytes = source instanceof Uint8Array ? source : new Uint8Array(source);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const eocd = findEocd(view);
  if (eocd < 0) {
    throw new ZipError("That file is not a zip archive — no end-of-central-directory record.");
  }

  const count = view.getUint16(eocd + 10, true);
  let directoryAt = view.getUint32(eocd + 16, true);
  if (directoryAt === U32_MAX) {
    throw new ZipError("This zip uses ZIP64 for its central directory, which is not supported.");
  }

  const entries: ZipEntry[] = [];
  const decoder = new TextDecoder();
  for (let i = 0; i < count; i += 1) {
    if (directoryAt + CENTRAL_HEADER_SIZE > bytes.byteLength) break;
    if (view.getUint32(directoryAt, true) !== CENTRAL_SIGNATURE) break;

    const method = view.getUint16(directoryAt + 10, true);
    let compressedSize = view.getUint32(directoryAt + 20, true);
    let uncompressedSize = view.getUint32(directoryAt + 24, true);
    const nameLength = view.getUint16(directoryAt + 28, true);
    const extraLength = view.getUint16(directoryAt + 30, true);
    const commentLength = view.getUint16(directoryAt + 32, true);
    let localAt = view.getUint32(directoryAt + 42, true);

    const nameAt = directoryAt + CENTRAL_HEADER_SIZE;
    const path = decoder.decode(bytes.subarray(nameAt, nameAt + nameLength));
    const wants = {
      size: uncompressedSize === U32_MAX,
      compressed: compressedSize === U32_MAX,
      offset: localAt === U32_MAX,
    };
    if (wants.size || wants.compressed || wants.offset) {
      const extra = readZip64Extra(view, nameAt + nameLength, extraLength, wants);
      if (extra.size !== undefined) uncompressedSize = extra.size;
      if (extra.compressed !== undefined) compressedSize = extra.compressed;
      if (extra.offset !== undefined) localAt = extra.offset;
    }
    directoryAt = nameAt + nameLength + extraLength + commentLength;

    // A directory is an entry whose name ends in `/`; it has no payload.
    if (path.endsWith("/")) continue;

    if (localAt + LOCAL_HEADER_SIZE > bytes.byteLength) {
      throw new ZipError(`The zip entry "${path}" points outside the file.`);
    }
    if (view.getUint32(localAt, true) !== LOCAL_SIGNATURE) {
      throw new ZipError(`The zip entry "${path}" has no local header.`);
    }
    const localName = view.getUint16(localAt + 26, true);
    const localExtra = view.getUint16(localAt + 28, true);
    const dataAt = localAt + LOCAL_HEADER_SIZE + localName + localExtra;
    const payload = bytes.subarray(dataAt, dataAt + compressedSize);

    if (method === METHOD_STORED) {
      entries.push({ path, bytes: payload });
      continue;
    }
    if (method !== METHOD_DEFLATE) {
      throw new ZipError(
        `The zip entry "${path}" uses compression method ${method}, which is not supported — only stored and deflate are.`,
      );
    }
    if (!decompressionAvailable()) {
      throw new ZipError(
        "This device cannot unzip compressed archives (no DecompressionStream). Unzip the export yourself and import the JSON files individually.",
      );
    }
    const inflated = await inflateRaw(payload);
    if (uncompressedSize > 0 && inflated.byteLength !== uncompressedSize) {
      throw new ZipError(`The zip entry "${path}" did not decompress to its stated size.`);
    }
    entries.push({ path, bytes: inflated });
  }

  if (entries.length === 0) throw new ZipError("That zip archive contains no files.");
  return entries;
}

/** Entries as text, keyed by **basename** — Trakt's folder layout is not load-bearing. */
export function entriesByName(entries: readonly ZipEntry[]): Map<string, string> {
  const decoder = new TextDecoder();
  const out = new Map<string, string>();
  for (const entry of entries) {
    const name = entry.path.split("/").pop() ?? entry.path;
    if (name === "") continue;
    // First wins: a nested duplicate of `watched-movies.json` must not silently
    // replace the top-level one.
    if (!out.has(name)) out.set(name, decoder.decode(entry.bytes));
  }
  return out;
}
