/**
 * Setting a book's cover by hand, when no catalogue has one.
 *
 * THE CASE THIS EXISTS FOR
 * ------------------------
 * "Traditional vs Generative AI Pentesting: A Hands-On Approach to Hacking" is
 * a real book on a real shelf with no cover anywhere. Open Library has the
 * record and no image; Google's keyless CDN answers its grey "image not
 * available" placeholder, which `covers.ts` correctly refuses on magic bytes (a
 * miss is a 200 PNG where every real cover is a JPEG). Every automatic route
 * has been tried and every one of them is right to give up. So the shelf drew a
 * blank tile, and there was no way to fix it.
 *
 * Two ways in, and they end in the same place — `MANUAL_COVER_KEY` on the book:
 *
 *   - **a URL**, typed into the Cover URL field on either detail surface. It
 *     goes through the ordinary cover pipeline, so Open Library stays behind
 *     its limiter and everything else is assigned directly.
 *   - **a file**, picked off disk. It is copied into the artwork cache folder
 *     under the cache's own naming and the book points at that path.
 *
 * WHAT IS CHECKED, AND WHY IT IS CHECKED HERE
 * -------------------------------------------
 * A file picker hands over whatever the user clicked. Two things are refused
 * before a single byte reaches the vault:
 *
 *   - **anything that is not a raster image**, by magic bytes rather than by
 *     file extension — the same discriminator `looksLikeJpeg` already uses, for
 *     the same reason: the name of a file is a claim and its first four bytes
 *     are a fact. A renamed `.jpg` that is really a PDF, an SVG (which is a
 *     document with script in it, not a picture), a zip: all refused.
 *   - **anything over `MANUAL_COVER_MAX_BYTES`**, checked against the reported
 *     size *before* the file is read, so a 200MB pick costs nothing rather than
 *     being loaded into memory and then rejected.
 *
 * Everything above the picker itself is pure and takes its clock as an
 * argument, so all of it is tested without a DOM, a vault or a network.
 */
import { Notice } from "obsidian";
import { IMAGE_SCOPE } from "../../services/imagecache";
import { COVER_CACHE_SCOPE, looksLikeJpeg, type CoverCache } from "./covers";

/**
 * The biggest picture we will write into someone's vault for one book cover.
 *
 * 8 MB, which is `services/imagecache.ts`'s own `DEFAULT_MAX_BYTES` — a cover
 * is a cover whichever door it came in through, and `ImageCache.adopt` enforces
 * that limit again on its own account. This one exists so an oversized pick is
 * refused with a sentence about *why*, before it is read.
 */
export const MANUAL_COVER_MAX_BYTES = 8 * 1024 * 1024;

/** The raster formats a cover may be. Anything else is not a picture to us. */
export type CoverImageKind = "jpg" | "png" | "gif" | "webp";

/** `IMAGE_SCOPE.book`, and the compile-time proof that it still is. */
const BOOK_SCOPE: typeof IMAGE_SCOPE.book = COVER_CACHE_SCOPE;

function bytesAt(view: Uint8Array, offset: number, ...expected: number[]): boolean {
  return expected.every((byte, i) => view[offset + i] === byte);
}

/**
 * What these bytes actually are, from their header — `""` when they are not a
 * picture at all.
 *
 * JPEG is delegated to `looksLikeJpeg` rather than re-sniffed: that function is
 * what decides whether a Google cover is real, and two answers to "is this a
 * JPEG" is one answer too many.
 */
export function imageKindOf(bytes: ArrayBuffer): CoverImageKind | "" {
  if (looksLikeJpeg(bytes)) return "jpg";
  if (bytes.byteLength < 12) return "";
  const view = new Uint8Array(bytes, 0, 12);
  // \x89 P N G \r \n \x1a \n
  if (bytesAt(view, 0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "png";
  // G I F 8
  if (bytesAt(view, 0, 0x47, 0x49, 0x46, 0x38)) return "gif";
  // R I F F … W E B P
  if (bytesAt(view, 0, 0x52, 0x49, 0x46, 0x46) && bytesAt(view, 8, 0x57, 0x45, 0x42, 0x50)) {
    return "webp";
  }
  return "";
}

export type CoverCheck = { ok: true; ext: CoverImageKind } | { ok: false; error: string };

/**
 * Is this a cover we are willing to keep? The size test first, because it is
 * the one that can be answered without looking at the bytes.
 */
export function checkCoverBytes(bytes: ArrayBuffer): CoverCheck {
  if (bytes.byteLength === 0) return { ok: false, error: "That file is empty." };
  if (bytes.byteLength > MANUAL_COVER_MAX_BYTES) return { ok: false, error: tooBig(bytes.byteLength) };
  const ext = imageKindOf(bytes);
  return ext === ""
    ? { ok: false, error: "That is not an image — covers must be a JPEG, PNG, GIF or WebP." }
    : { ok: true, ext };
}

/**
 * The same size rule, against a size the picker reported before reading it —
 * the refusal when there is one, `null` when the file is worth reading.
 */
export function checkCoverSize(size: number): { ok: false; error: string } | null {
  return size > MANUAL_COVER_MAX_BYTES ? { ok: false, error: tooBig(size) } : null;
}

function megabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function tooBig(size: number): string {
  return `That image is ${megabytes(size)} — covers are capped at ${megabytes(MANUAL_COVER_MAX_BYTES)}.`;
}

/**
 * The string a hand-set cover's filename is derived from.
 *
 * Not a URL and never fetched — `cacheFileName` only ever hashes it and reads
 * an extension off the end, and this shape gives it both. The stamp is in
 * there so picking a *second* file for the same book writes a new file rather
 * than colliding with the first, which then stops being referenced and shows up
 * as an ordinary orphan the user can clear.
 *
 * The extension comes from the bytes, never from the name the file arrived
 * with: `cover.jpg` that is really a PNG is written as `.png`.
 */
export function manualCoverSeed(id: string, ext: CoverImageKind, stamp: number): string {
  return `wl-manual://book/${encodeURIComponent(id.trim())}/${stamp.toString(36)}.${ext}`;
}

export type ManualCoverResult = { path: string } | { error: string };

/**
 * Validate, write, and answer the vault path to put on the book.
 *
 * The whole operation, minus the picking — so the caller is three lines and
 * this is what the tests drive. A cache that cannot adopt (an old stand-in, a
 * read-only vault, a full disk) is a refusal with a sentence, never a throw and
 * never a half-set cover.
 */
export async function saveManualCover(
  cache: CoverCache | undefined,
  id: string,
  bytes: ArrayBuffer,
  now: () => number = Date.now,
): Promise<ManualCoverResult> {
  const key = id.trim();
  if (key === "") return { error: "That book has no id to file a cover under." };
  const check = checkCoverBytes(bytes);
  if (!check.ok) return { error: check.error };
  if (!cache?.adopt) return { error: "The artwork folder is not available right now." };

  const seed = manualCoverSeed(key, check.ext, now());
  try {
    const path = await cache.adopt({ scope: BOOK_SCOPE, id: key }, seed, bytes);
    return path === "" ? { error: "The cover could not be written to the vault." } : { path };
  } catch (err) {
    return { error: `The cover could not be written — ${message(err)}` };
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * "Choose image…" — a hidden file input, exactly as `bookfile.ts` imports a
 * book. No Electron dialog, so the same code works on a phone, and no Node
 * `fs`: the bytes come from the `File`, and the only thing that writes is the
 * vault adapter behind `ImageCache`.
 *
 * The size test happens here, on `file.size`, so an oversized pick is refused
 * without being read.
 */
export function pickCoverFile(onPicked: (bytes: ArrayBuffer) => void): void {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/jpeg,image/png,image/gif,image/webp,.jpg,.jpeg,.png,.gif,.webp";
  input.addEventListener("change", () => {
    const file = input.files?.[0];
    if (!file) return;
    const oversized = checkCoverSize(file.size);
    if (oversized) {
      new Notice(oversized.error);
      return;
    }
    void file
      .arrayBuffer()
      .then((bytes) => onPicked(bytes))
      .catch((err: unknown) => {
        new Notice(`That file could not be read — ${message(err)}`);
      });
  });
  input.click();
}
