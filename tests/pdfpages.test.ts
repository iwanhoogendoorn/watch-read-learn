/**
 * Page counts read out of the book file itself.
 *
 * The byte scanner is the path that runs when `window.pdfjsLib` is missing, so
 * it is the one a test can actually reach — and the one whose failure mode
 * matters, because a wrong total silently rewrites someone's progress.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { pdfPageCountFromBytes, readPdfPageCount } from "../src/domains/reading/pdfpages";

const bytes = (text: string): Uint8Array =>
  Uint8Array.from(text, (c) => c.charCodeAt(0) & 0xff);

describe("reading a page count out of PDF bytes", () => {
  it("takes the page tree's root count", () => {
    // Subtrees carry their own smaller counts; the root is the largest.
    const pdf = "%PDF-1.7\n/Type /Pages /Count 53\n/Type /Pages /Count 46\n/Type /Pages /Count 370\n";
    expect(pdfPageCountFromBytes(bytes(pdf))).toBe(370);
  });

  it("does not count /Type /Page markers, which outnumber the pages", () => {
    // 4 page objects but the document says 3 — the document wins.
    const pdf = "/Count 3\n" + "/Type /Page\n".repeat(4);
    expect(pdfPageCountFromBytes(bytes(pdf))).toBe(3);
  });

  it("answers null rather than guessing when the count is not in the bytes", () => {
    // What an object-stream PDF looks like to a scanner: nothing readable.
    expect(pdfPageCountFromBytes(bytes("%PDF-1.7\n/ObjStm binary-soup\n"))).toBeNull();
  });

  it("answers null for an empty file", () => {
    expect(pdfPageCountFromBytes(new Uint8Array())).toBeNull();
  });

  it("survives bytes that are not valid UTF-8", () => {
    const raw = new Uint8Array([0xff, 0xfe, 0x00, ...bytes("/Count 12"), 0x80, 0x81]);
    expect(pdfPageCountFromBytes(raw)).toBe(12);
  });
});

describe("reading a page count out of the vault", () => {
  afterEach(() => {
    delete (globalThis as { pdfjsLib?: unknown }).pdfjsLib;
  });

  const deps = (text: string) => ({
    readBinary: async () => bytes(text).buffer as ArrayBuffer,
  });

  it("ignores anything that is not a pdf", async () => {
    const readBinary = vi.fn();
    expect(await readPdfPageCount({ readBinary }, "book.epub")).toBeNull();
    expect(readBinary).not.toHaveBeenCalled();
  });

  it("prefers pdf.js when Obsidian exposes it", async () => {
    (globalThis as { pdfjsLib?: unknown }).pdfjsLib = {
      getDocument: () => ({ promise: Promise.resolve({ numPages: 356 }) }),
    };
    // The bytes say something different; the parser is the better witness.
    expect(await readPdfPageCount(deps("/Count 9"), "book.pdf")).toBe(356);
  });

  it("falls back to the bytes when pdf.js throws", async () => {
    (globalThis as { pdfjsLib?: unknown }).pdfjsLib = {
      getDocument: () => ({ promise: Promise.reject(new Error("encrypted")) }),
    };
    expect(await readPdfPageCount(deps("/Count 42"), "book.pdf")).toBe(42);
  });

  it("falls back to the bytes when pdf.js reports nothing sensible", async () => {
    (globalThis as { pdfjsLib?: unknown }).pdfjsLib = {
      getDocument: () => ({ promise: Promise.resolve({ numPages: 0 }) }),
    };
    expect(await readPdfPageCount(deps("/Count 42"), "book.pdf")).toBe(42);
  });

  it("answers null when the file cannot be read at all", async () => {
    const readBinary = async () => {
      throw new Error("gone");
    };
    expect(await readPdfPageCount({ readBinary }, "book.pdf")).toBeNull();
  });
});
