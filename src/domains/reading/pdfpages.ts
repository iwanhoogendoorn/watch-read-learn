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
      const doc = await lib.getDocument({ data: buffer.slice(0) }).promise;
      const pages = doc.numPages;
      await doc.destroy?.();
      if (Number.isInteger(pages) && pages > 0) return pages;
    } catch {
      // Fall through: a PDF pdf.js will not open may still name its own count.
    }
  }

  return pdfPageCountFromBytes(new Uint8Array(buffer));
}
