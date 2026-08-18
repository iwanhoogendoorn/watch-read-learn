/**
 * The ZIP reader.
 *
 * The reason this file exists rather than a dependency: Trakt's export is a zip,
 * and inflating it needs a DEFLATE decoder. `DecompressionStream` is one, it is
 * already in every runtime this plugin ships to, and the format around it is
 * about two hundred bytes of header parsing. The test that matters is therefore
 * not "does it read a zip" but **does the decoder actually work here** — so the
 * fixture is compressed with `CompressionStream` at test time and the pair has
 * to round-trip.
 */
import { describe, expect, it } from "vitest";
import { entriesByName, readZip, ZipError } from "../src/domains/import/zip";
import { readExportFile } from "../src/domains/import/sources";
import { parseTrakt } from "../src/domains/import/sources/trakt";
import { buildZip } from "./fixtures/zipbuild";
import { traktFiles } from "./fixtures/trackers";

describe("readZip", () => {
  it("reads a stored entry", async () => {
    const zip = await buildZip([{ name: "plain.txt", text: "hello", deflate: false }]);
    const entries = await readZip(zip);
    expect(entries).toHaveLength(1);
    expect(new TextDecoder().decode((entries[0] as { bytes: Uint8Array }).bytes)).toBe("hello");
  });

  it("inflates a deflated entry", async () => {
    // Repetitive on purpose, so the deflated payload is genuinely smaller than
    // the input and a passthrough bug cannot pass this test by accident.
    const text = "the same sentence, over and over. ".repeat(64);
    const zip = await buildZip([{ name: "big.json", text }]);
    const entries = await readZip(zip);
    expect(new TextDecoder().decode((entries[0] as { bytes: Uint8Array }).bytes)).toBe(text);
  });

  it("reads several entries and drops directory records", async () => {
    const zip = await buildZip([
      { name: "export/", text: "" },
      { name: "export/a.json", text: "[1]" },
      { name: "export/b.json", text: "[2]" },
    ]);
    const entries = await readZip(zip);
    expect(entries.map((entry) => entry.path)).toEqual(["export/a.json", "export/b.json"]);
  });

  it("refuses a file that is not an archive, with a sentence rather than a stack", async () => {
    await expect(readZip(new TextEncoder().encode("Const,Title\n"))).rejects.toBeInstanceOf(ZipError);
  });
});

describe("entriesByName", () => {
  it("keys on the basename, so Trakt's folder layout does not matter", async () => {
    const zip = await buildZip([
      { name: "trakt-export-2024/watched-movies.json", text: "[]" },
      { name: "trakt-export-2024/ratings-shows.json", text: "[]" },
    ]);
    const names = [...entriesByName(await readZip(zip)).keys()];
    expect(names).toEqual(["watched-movies.json", "ratings-shows.json"]);
  });
});

describe("readExportFile", () => {
  it("unzips an archive and passes anything else through as one file", async () => {
    const zip = await buildZip([{ name: "watched-movies.json", text: "[]" }]);
    const unpacked = await readExportFile("trakt.zip", zip.buffer as ArrayBuffer);
    expect([...unpacked.keys()]).toEqual(["watched-movies.json"]);

    const plain = new TextEncoder().encode("Const,Title\ntt1,X\n");
    const single = await readExportFile("ratings.csv", plain.buffer as ArrayBuffer);
    expect([...single.keys()]).toEqual(["ratings.csv"]);
  });

  it("decides by the file's first bytes, not its name", async () => {
    // A download that arrived as `export.zip.part` is still a zip.
    const zip = await buildZip([{ name: "watched-shows.json", text: "[]" }]);
    const unpacked = await readExportFile("export.zip.part", zip.buffer as ArrayBuffer);
    expect([...unpacked.keys()]).toEqual(["watched-shows.json"]);
  });

  it("carries a whole Trakt export from zipped bytes through to records", async () => {
    const zip = await buildZip(
      [...traktFiles()].map(([name, text]) => ({ name: `trakt-export/${name}`, text })),
    );
    const files = await readExportFile("trakt-export.zip", zip.buffer as ArrayBuffer);
    const parsed = parseTrakt(files);
    expect(parsed.records.map((record) => record.title).sort()).toEqual([
      "Fixture Orphan",
      "Fixture Rain",
      "Fixture Signal",
      "Unseen Fixture",
    ]);
  });
});
