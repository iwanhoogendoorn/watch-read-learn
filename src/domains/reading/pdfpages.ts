/**
 * How many pages is this book? Ask the book.
 *
 * Neither metadata provider reliably knows. Open Library holds plenty of
 * editions with no `number_of_pages` at all, and Google Books answers nothing
 * without an API key. But when the PDF itself is sitting in the vault, the
 * count is not a lookup — it is a fact in the file, and an exact one.
 *
 * Two ways to read it, in order of trust:
 *
 *   1. **pdf.js**, which Obsidian bundles for its own PDF viewer and exposes as
 *      `window.pdfjsLib`. Unofficial, so it is feature-detected every time, but
 *      it is the only option that understands a modern PDF — the ones that pack
 *      their page objects into compressed object streams, where the raw bytes
 *      contain no readable `/Type /Page` at all.
 *   2. **A byte scan**, for when that global is not there. The page tree's root
 *      node carries `/Count N` for the whole document, and it is the largest
 *      such number in the file — every other `/Count` belongs to a subtree.
 *      Counting `/Type /Page` markers instead would overcount: a PDF routinely
 *      carries more page objects than pages.
 *
 * Both can fail, and failing is fine — the caller falls back to asking the user,
 * which is still better than a table full of dashes.
 */

/** Just enough of pdf.js to ask one question, without importing it. */
interface PdfJsLike {
  getDocument(src: { data: ArrayBuffer } | Uint8Array): {
    promise: Promise<{ numPages: number; destroy?: () => Promise<void> | void }>;
  };
}

function pdfjs(): PdfJsLike | null {
  const global = globalThis as { pdfjsLib?: unknown; window?: { pdfjsLib?: unknown } };
  const lib = global.pdfjsLib ?? global.window?.pdfjsLib;
  if (lib && typeof (lib as PdfJsLike).getDocument === "function") return lib as PdfJsLike;
  return null;
}

/** The last `startxref`-sized slice worth scanning; PDFs can be enormous. */
const SCAN_LIMIT = 4_000_000;

/**
 * How long pdf.js gets before we stop waiting.
 *
 * Not a performance knob — a liveness one. `getDocument` returns a promise that
 * never settles when its worker is missing, and "never" is not an error anyone
 * can catch.
 */
const PDFJS_TIMEOUT_MS = 10_000;

/** Resolves to `null` if `work` has not settled in time. Never rejects late. */
async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Page count from raw bytes, or null when the file does not say plainly.
 *
 * Exported for tests: this is the fallback path, so it is the one most likely
 * to be exercised on a machine that is not a real Obsidian.
 */
export function pdfPageCountFromBytes(bytes: Uint8Array): number | null {
  if (bytes.length === 0) return null;
  // Latin-1 keeps every byte a character, so binary sections cannot swallow a
  // match the way a UTF-8 decode's replacement characters would.
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, SCAN_LIMIT));
  const tail =
    bytes.length > SCAN_LIMIT
      ? new TextDecoder("latin1").decode(bytes.subarray(bytes.length - SCAN_LIMIT))
      : "";
  const text = tail === "" ? head : `${head}\n${tail}`;

  let best = 0;
  for (const match of text.matchAll(/\/Count\s+(\d+)/g)) {
    const value = Number(match[1]);
    if (Number.isFinite(value) && value > best) best = value;
  }
  if (best > 0) return best;

  // No page tree in the readable bytes: either an object-stream PDF (pdf.js
  // territory) or not a PDF at all. Say so rather than guess.
  return null;
}

export interface PdfPageCountDeps {
  /** Usually `app.vault.adapter.readBinary`. */
  readBinary(path: string): Promise<ArrayBuffer>;
}

/**
 * Read a vault PDF's page count. Null means "could not tell" — never a guess,
 * because a wrong total silently rewrites someone's reading progress.
 */
export async function readPdfPageCount(
  deps: PdfPageCountDeps,
  path: string,
): Promise<number | null> {
  if (!path.toLowerCase().endsWith(".pdf")) return null;

  let buffer: ArrayBuffer;
  try {
    buffer = await deps.readBinary(path);
  } catch {
    return null;
  }

  const lib = pdfjs();
  if (lib) {
    try {
      // pdf.js takes ownership of the buffer it is handed, so it gets a copy —
      // otherwise the fallback below would be scanning a detached array.
      //
      // Raced against a timer because this can *hang* rather than fail: pdf.js
      // with no worker configured leaves a promise that never settles, and an
      // await on it would stall the whole sweep behind one file.
      const pages = await withTimeout(
        lib.getDocument({ data: buffer.slice(0) }).promise.then((doc) => {
          const count = doc.numPages;
          void doc.destroy?.();
          return count;
        }),
        PDFJS_TIMEOUT_MS,
      );
      if (typeof pages === "number" && Number.isInteger(pages) && pages > 0) return pages;
    } catch {
      // Fall through: a PDF pdf.js will not open may still name its own count.
    }
  }

  return pdfPageCountFromBytes(new Uint8Array(buffer));
}

/** The slice of an entry this sweep needs. Structural, so tests need no store. */
export interface PageCountCandidate {
  id: string;
  title: string;
  filePath?: string;
}

export interface FillPageCountsDeps {
  adapter: PdfPageCountDeps;
  /** Entries to consider — the caller decides which shelf and what is missing. */
  candidates: readonly PageCountCandidate[];
  /** Persist one answer. */
  apply(id: string, pages: number): void;
  /** Checked between files so a torn-down tab stops the work. */
  cancelled?: () => boolean;
}

export interface FillPageCountsResult {
  filled: number;
  /** Files that could not answer — reported, never guessed at. */
  unknown: string[];
}

/**
 * Fill in page counts from linked PDFs, one file at a time.
 *
 * Sequential because these are tens-of-megabytes reads and a shelf of them at
 * once is a stutter the user feels. Every file is isolated: one that throws,
 * hangs past its timeout, or simply will not say leaves the others alone.
 */
export async function fillPageCountsFromFiles(
  deps: FillPageCountsDeps,
): Promise<FillPageCountsResult> {
  const result: FillPageCountsResult = { filled: 0, unknown: [] };
  for (const candidate of deps.candidates) {
    if (deps.cancelled?.()) return result;
    const path = (candidate.filePath ?? "").trim();
    if (!path.toLowerCase().endsWith(".pdf")) continue;
    let pages: number | null = null;
    try {
      pages = await readPdfPageCount(deps.adapter, path);
    } catch (err) {
      console.warn("[wrl] could not read a page count from", path, err);
    }
    if (pages === null) {
      result.unknown.push(candidate.title);
      continue;
    }
    deps.apply(candidate.id, pages);
    result.filled += 1;
  }
  return result;
}
