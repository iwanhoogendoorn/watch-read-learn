/**
 * A minimal ZIP *writer*, so the ZIP reader can be tested against bytes rather
 * than against a checked-in binary blob.
 *
 * Committing a `.zip` fixture would test the reader against one archive that
 * nobody can read the source of. Building one here means the test can say
 * "stored" or "deflated" and the diff shows what it means. The deflate side uses
 * `CompressionStream`, the exact mirror of the `DecompressionStream` the reader
 * uses — so a passing test proves the pair round-trips on this runtime.
 *
 * Correctness only where the reader looks: it reads sizes, methods, names and
 * offsets from the central directory, and ignores CRCs, so the CRCs here are
 * zero and deliberately so.
 */

export interface ZipInput {
  name: string;
  text: string;
  /** `false` stores the entry uncompressed. Default `true`. */
  deflate?: boolean;
}

function u16(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff];
}

function u32(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >>> 24) & 0xff];
}

async function deflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function buildZip(inputs: readonly ZipInput[]): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const local: number[] = [];
  const central: number[] = [];

  for (const input of inputs) {
    const name = encoder.encode(input.name);
    const raw = encoder.encode(input.text);
    const compress = input.deflate !== false;
    const payload = compress ? await deflateRaw(raw) : raw;
    const method = compress ? 8 : 0;
    const offset = local.length;

    local.push(
      ...u32(0x04034b50),
      ...u16(20), // version needed
      ...u16(0), // flags
      ...u16(method),
      ...u16(0), // mod time
      ...u16(0), // mod date
      ...u32(0), // crc32 — unread by the reader under test
      ...u32(payload.length),
      ...u32(raw.length),
      ...u16(name.length),
      ...u16(0), // extra length
      ...name,
      ...payload,
    );

    central.push(
      ...u32(0x02014b50),
      ...u16(20), // version made by
      ...u16(20), // version needed
      ...u16(0),
      ...u16(method),
      ...u16(0),
      ...u16(0),
      ...u32(0),
      ...u32(payload.length),
      ...u32(raw.length),
      ...u16(name.length),
      ...u16(0), // extra
      ...u16(0), // comment
      ...u16(0), // disk number start
      ...u16(0), // internal attributes
      ...u32(0), // external attributes
      ...u32(offset),
      ...name,
    );
  }

  const eocd = [
    ...u32(0x06054b50),
    ...u16(0),
    ...u16(0),
    ...u16(inputs.length),
    ...u16(inputs.length),
    ...u32(central.length),
    ...u32(local.length),
    ...u16(0),
  ];

  return new Uint8Array([...local, ...central, ...eocd]);
}
