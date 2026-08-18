/**
 * Turning "the file the user picked" into records.
 *
 * Every source parser takes a **basename → text** map rather than a file,
 * because that is the one shape all five fit: Trakt is a zip of six files,
 * Letterboxd is a zip of five, and IMDb, Simkl and Ryot are one file each. A zip
 * is unpacked into the map; anything else becomes a one-entry map. Nothing below
 * this line knows what a `File` is.
 *
 * Detection is by content, not by what the user clicked, and it is offered as a
 * suggestion rather than applied silently — `detectSource` returns its guess and
 * the modal preselects it, so a Simkl backup renamed `export.csv` is still one
 * click from importing and a wrong guess is still one click from being fixed.
 */
import { entriesByName, readZip } from "../zip";
import { parseImdb } from "./imdb";
import { parseLetterboxd } from "./letterboxd";
import { parseRyot } from "./ryot";
import { parseSimkl } from "./simkl";
import { isTraktFile, parseTrakt } from "./trakt";
import type { ParsedExport, TrackerSource } from "../types";

export { parseImdb, parseLetterboxd, parseRyot, parseSimkl, parseTrakt };

/** ZIP's local-file-header signature: `PK\x03\x04`. */
function looksZipped(bytes: Uint8Array): boolean {
  return bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

/**
 * Read a picked file into basename → text, unzipping it if it is an archive.
 *
 * Zipped-ness is decided by the first four bytes rather than by the extension:
 * a browser download that arrived as `trakt-export.zip.download` is still a zip,
 * and a `.csv` never accidentally starts with `PK\x03\x04`.
 */
export async function readExportFile(
  name: string,
  bytes: ArrayBuffer,
): Promise<Map<string, string>> {
  const view = new Uint8Array(bytes);
  if (looksZipped(view)) return entriesByName(await readZip(view));
  const base = name.split("/").pop() ?? name;
  return new Map([[base === "" ? "export" : base, new TextDecoder().decode(view)]]);
}

/**
 * Which tracker these files came from, or `null` when nothing is recognisable.
 *
 * Filenames are checked before contents because they are the stronger signal —
 * `watched-shows.json` is Trakt's and nothing else's — and the header sniffing
 * that follows only has to separate the three flat CSV/JSON sources from each
 * other.
 */
export function detectSource(files: ReadonlyMap<string, string>): TrackerSource | null {
  const names = [...files.keys()].map((name) => name.toLowerCase());

  if (names.some(isTraktFile)) return "trakt";
  if (names.some((name) => ["diary.csv", "watched.csv", "ratings.csv", "watchlist.csv"].includes(name))) {
    return "letterboxd";
  }

  for (const text of files.values()) {
    const head = text.slice(0, 2048);
    const firstLine = (head.split(/\r?\n/)[0] ?? "").toLowerCase();
    if (firstLine.includes("simkl_id")) return "simkl";
    // `Const` is IMDb's, and pairing it with a second IMDb-only column keeps a
    // spreadsheet that happens to have a "const" column out of it.
    if (firstLine.includes("const") && (firstLine.includes("title type") || firstLine.includes("num votes"))) {
      return "imdb";
    }
    if (/"metadata"\s*:\s*\[/.test(head) && /"lot"\s*:/.test(head)) return "ryot";
    if (firstLine.includes("letterboxd uri")) return "letterboxd";
  }
  return null;
}

/** Parse for a chosen source. The source is the user's decision, never inferred here. */
export function parseExport(source: TrackerSource, files: ReadonlyMap<string, string>): ParsedExport {
  if (source === "trakt") return parseTrakt(files);
  if (source === "letterboxd") return parseLetterboxd(files);

  // The three single-file sources: a zip is allowed, and the first member that
  // parses into anything wins.
  const texts = [...files.values()];
  const parse = source === "simkl" ? parseSimkl : source === "imdb" ? parseImdb : parseRyot;
  let best: ParsedExport = { source, records: [], warnings: [] };
  for (const text of texts) {
    const parsed = parse(text);
    if (parsed.records.length > best.records.length) best = parsed;
  }
  if (best.records.length === 0 && texts.length > 0) {
    // Nothing parsed: report the *first* file's complaint rather than an empty
    // result, because its warning says what was actually wrong with the file.
    return parse(texts[0] as string);
  }
  return best;
}
