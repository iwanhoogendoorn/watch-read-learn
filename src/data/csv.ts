/**
 * CSV in and out (SPEC2-PARITY.md §D-EXTRAS, item 3; report §2.5).
 *
 * Two hard compatibility rules, and everything else follows from them:
 *
 *   1. **The watchlist export is v3's exact 14 columns, in v3's order**
 *      (`CSV_WATCHLIST_COLUMNS`, frozen in `types.ts`). Someone has a
 *      `watchlog-export-2024-11-03.csv` in their downloads folder and a
 *      spreadsheet built on top of it. Changing the header row breaks that for
 *      no gain; the richer v4 fields are what the JSON backup is for.
 *   2. **Import auto-detects columns from v3's synonym table** (v3 `un`,
 *      pretty:24346) — `runtime`/`minutes`/`duration` all mean
 *      `episodeDuration`, `score` means `rating`, and so on. Trakt, Letterboxd
 *      and IMDb exports all land somewhere in that table, which is why it
 *      exists.
 *
 * Reading and Games get their own column sets and synonym tables, following the
 * same shape. They are v4's invention — v3 had no CSV path for them at all — so
 * they are designed rather than transcribed, but the field names are the frozen
 * `Book`/`Manga`/`Game` ones so a round trip is lossless for everything a
 * spreadsheet can hold.
 *
 * The whole module is pure. Modals, files and progress bars live in
 * `domains/csv/`.
 */
import {
  CSV_WATCHLIST_COLUMNS,
  type Book,
  type CsvImportPlan,
  type CsvImportRow,
  type Game,
  type Manga,
  type TitleV4,
  type WidgetDomain,
} from "../types";

/** v3 joined multi-valued cells with this and split on `[;,]` coming back. */
const MULTI_SEPARATOR = "; ";

// ---------------------------------------------------------------------------
// Low-level CSV
// ---------------------------------------------------------------------------

/** Quote only when the cell would otherwise break the row. v3's `pc`. */
export function escapeCsvCell(value: unknown): string {
  const text = value === undefined || value === null ? "" : String(value);
  if (!/[",\n]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

export function serializeCsv(headers: readonly string[], rows: readonly unknown[][]): string {
  return [
    headers.map(escapeCsvCell).join(","),
    ...rows.map((row) => row.map(escapeCsvCell).join(",")),
  ].join("\n");
}

/**
 * RFC-4180-ish reader: doubled quotes escape a quote, newlines inside quotes are
 * data, and trailing blank rows are dropped. A character loop rather than a
 * regex because a quoted newline is exactly the case regexes get wrong.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const source = text.replace(/\r\n?/g, "\n");

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (quoted) {
      if (ch !== '"') {
        cell += ch;
      } else if (source[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else {
        quoted = false;
      }
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n") {
      row.push(cell);
      cell = "";
      rows.push(row);
      row = [];
    } else cell += ch;
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  while (rows.length > 0 && (rows[rows.length - 1] ?? []).every((value) => value === "")) rows.pop();
  return rows;
}

// ---------------------------------------------------------------------------
// Lenient dates
// ---------------------------------------------------------------------------

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

function iso(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * Parse whatever a spreadsheet emitted into `YYYY-MM-DD`, or `null`.
 *
 * v3's `dn`, kept including its ambiguity rule: for `x/y/z`, a component over 12
 * disambiguates day from month, and when neither does it is read as
 * **day/month/year**. That is wrong for a US-formatted file and right for
 * everywhere else; the mapping step is where a user who knows better fixes it.
 */
export function parseLooseDate(input: string): string | null {
  const text = input.trim();
  if (text === "") return null;
  try {
    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;

    const slash = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);
    if (slash) {
      const a = Number(slash[1]);
      const b = Number(slash[2]);
      const year = Number(slash[3]);
      let day = a;
      let month = b;
      if (a > 12) {
        day = a;
        month = b;
      } else if (b > 12) {
        day = b;
        month = a;
      }
      if (month < 1 || month > 12 || day < 1 || day > 31) return null;
      return iso(year, month, day);
    }

    const dmy = /^(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{4})$/.exec(text);
    if (dmy) {
      const month = MONTHS[(dmy[2] ?? "").toLowerCase().slice(0, 3)];
      if (month) return iso(Number(dmy[3]), month, Number(dmy[1]));
    }

    const mdy = /^([A-Za-z]{3,})\s+(\d{1,2}),?\s+(\d{4})$/.exec(text);
    if (mdy) {
      const month = MONTHS[(mdy[1] ?? "").toLowerCase().slice(0, 3)];
      if (month) return iso(Number(mdy[3]), month, Number(mdy[2]));
    }

    const dotted = /^(\d{1,2})[.-](\d{1,2})[.-](\d{4})$/.exec(text);
    if (dotted) {
      const day = Number(dotted[1]);
      const month = Number(dotted[2]);
      if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
        return iso(Number(dotted[3]), month, day);
      }
    }

    const parsed = new Date(text);
    if (!Number.isNaN(parsed.getTime())) {
      return iso(parsed.getFullYear(), parsed.getMonth() + 1, parsed.getDate());
    }
  } catch {
    return null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Column definitions and the synonym table
// ---------------------------------------------------------------------------

export interface CsvField {
  /** The entity field this column writes. */
  key: string;
  label: string;
  /** Lower-cased header spellings that auto-map to this field. */
  synonyms: string[];
  kind: "text" | "number" | "date" | "list" | "boolean";
}

/** v3's `un`, verbatim — the reason a Trakt or IMDb export maps itself. */
export const WATCHLIST_FIELDS: CsvField[] = [
  { key: "title", label: "Name", synonyms: ["title", "name"], kind: "text" },
  { key: "type", label: "Type", synonyms: ["type"], kind: "text" },
  { key: "status", label: "Status", synonyms: ["status"], kind: "text" },
  { key: "priority", label: "Priority", synonyms: ["priority"], kind: "text" },
  { key: "rating", label: "Rating", synonyms: ["rating", "score"], kind: "number" },
  {
    key: "totalEpisodes",
    label: "Episodes",
    synonyms: ["episodes", "totalepisodes", "total episodes", "episode count", "ep count"],
    kind: "number",
  },
  {
    key: "episodeDuration",
    label: "Duration (min)",
    synonyms: ["duration", "episodeduration", "episode duration", "minutes", "runtime"],
    kind: "number",
  },
  {
    key: "dateStarted",
    label: "Date started",
    synonyms: ["started", "datestarted", "date started", "date_started", "start date"],
    kind: "date",
  },
  {
    key: "dateFinished",
    label: "Date finished",
    synonyms: [
      "finished",
      "datefinished",
      "date finished",
      "date_finished",
      "end date",
      "finish date",
      "completed date",
    ],
    kind: "date",
  },
  {
    key: "releaseDate",
    label: "Release date",
    synonyms: ["releasedate", "release date", "release_date", "air date", "airdate"],
    kind: "date",
  },
  { key: "dateAdded", label: "Date added", synonyms: ["dateadded", "date added", "added"], kind: "date" },
  {
    key: "externalLink",
    label: "Link",
    synonyms: ["link", "externallink", "external link", "external_link", "url"],
    kind: "text",
  },
  { key: "notes", label: "Notes", synonyms: ["notes", "note", "comment", "comments"], kind: "text" },
  {
    key: "studio",
    label: "Studio",
    synonyms: ["studio", "studios", "network", "production", "production company"],
    kind: "list",
  },
];

export const READING_FIELDS: CsvField[] = [
  { key: "title", label: "Title", synonyms: ["title", "name", "book"], kind: "text" },
  { key: "author", label: "Author", synonyms: ["author", "authors", "writer", "by"], kind: "text" },
  { key: "status", label: "Status", synonyms: ["status", "shelf", "exclusive shelf"], kind: "text" },
  { key: "rating", label: "Rating", synonyms: ["rating", "score", "my rating"], kind: "number" },
  { key: "pagesRead", label: "Pages read", synonyms: ["pagesread", "pages read"], kind: "number" },
  {
    key: "totalPages",
    label: "Total pages",
    synonyms: ["pages", "totalpages", "total pages", "number of pages", "page count"],
    kind: "number",
  },
  {
    key: "chaptersRead",
    label: "Chapters read",
    synonyms: ["chaptersread", "chapters read"],
    kind: "number",
  },
  {
    key: "totalChapters",
    label: "Total chapters",
    synonyms: ["chapters", "totalchapters", "total chapters"],
    kind: "number",
  },
  {
    key: "volumesRead",
    label: "Volumes read",
    synonyms: ["volumesread", "volumes read"],
    kind: "number",
  },
  {
    key: "totalVolumes",
    label: "Total volumes",
    synonyms: ["volumes", "totalvolumes", "total volumes"],
    kind: "number",
  },
  {
    key: "dateStarted",
    label: "Date started",
    synonyms: ["started", "datestarted", "date started", "date read", "start date"],
    kind: "date",
  },
  {
    key: "dateFinished",
    label: "Date finished",
    synonyms: ["finished", "datefinished", "date finished", "end date", "finish date"],
    kind: "date",
  },
  {
    key: "releaseDate",
    label: "Release date",
    synonyms: ["releasedate", "release date", "published", "year published"],
    kind: "date",
  },
  {
    key: "externalLink",
    label: "Link",
    synonyms: ["link", "externallink", "external link", "url"],
    kind: "text",
  },
  // Everything below exists because the export has to survive a round trip
  // (P1-2). A word-tracked favourite that comes back as a page-tracked
  // non-favourite has not been exported, it has been damaged.
  {
    key: "progressUnit",
    label: "Progress unit",
    synonyms: ["progressunit", "progress unit", "unit"],
    kind: "text",
  },
  { key: "wordsRead", label: "Words read", synonyms: ["wordsread", "words read"], kind: "number" },
  {
    key: "totalWords",
    label: "Total words",
    synonyms: ["words", "totalwords", "total words", "word count"],
    kind: "number",
  },
  { key: "favorite", label: "Favourite", synonyms: ["favorite", "favourite", "starred"], kind: "boolean" },
  {
    key: "coverUrl",
    label: "Cover",
    synonyms: ["cover", "coverurl", "cover url", "image"],
    kind: "text",
  },
  {
    key: "googleBooksId",
    label: "Google Books id",
    synonyms: ["googlebooksid", "google books id", "volumeid"],
    kind: "text",
  },
  { key: "malId", label: "MAL id", synonyms: ["malid", "mal id", "myanimelist id"], kind: "text" },
  {
    key: "vaultPage",
    label: "Note",
    synonyms: ["note", "vaultpage", "vault page"],
    kind: "text",
  },
];

export const GAMES_FIELDS: CsvField[] = [
  { key: "title", label: "Title", synonyms: ["title", "name", "game"], kind: "text" },
  {
    key: "developer",
    label: "Developer",
    synonyms: ["developer", "developers", "studio"],
    kind: "text",
  },
  { key: "publisher", label: "Publisher", synonyms: ["publisher", "publishers"], kind: "text" },
  { key: "type", label: "Genre", synonyms: ["genre", "genres", "type"], kind: "text" },
  { key: "status", label: "Status", synonyms: ["status"], kind: "text" },
  { key: "priority", label: "Priority", synonyms: ["priority"], kind: "text" },
  { key: "rating", label: "Rating", synonyms: ["rating", "score"], kind: "number" },
  {
    key: "playtimeMinutes",
    label: "Playtime (min)",
    synonyms: ["playtime", "playtimeminutes", "playtime minutes", "minutes", "hours played"],
    kind: "number",
  },
  {
    key: "achievementsEarned",
    label: "Achievements earned",
    synonyms: ["achievementsearned", "achievements earned", "achievements"],
    kind: "number",
  },
  {
    key: "achievementsTotal",
    label: "Achievements total",
    synonyms: ["achievementstotal", "achievements total", "total achievements"],
    kind: "number",
  },
  {
    key: "platforms",
    label: "Platforms",
    synonyms: ["platform", "platforms", "system", "console"],
    kind: "list",
  },
  {
    key: "releaseDate",
    label: "Release date",
    synonyms: ["releasedate", "release date", "released"],
    kind: "date",
  },
  {
    key: "dateStarted",
    label: "Date started",
    synonyms: ["started", "datestarted", "date started"],
    kind: "date",
  },
  {
    key: "dateFinished",
    label: "Date finished",
    synonyms: ["finished", "datefinished", "date finished", "beaten"],
    kind: "date",
  },
  {
    key: "storeUrl",
    label: "Store link",
    synonyms: ["store", "storeurl", "store url", "link", "url"],
    kind: "text",
  },
  // Identity and state a game is not a game without (P1-2).
  { key: "progress", label: "Progress %", synonyms: ["progress", "percent", "completion"], kind: "number" },
  { key: "wishlist", label: "Wishlist", synonyms: ["wishlist", "wanted"], kind: "boolean" },
  { key: "favorite", label: "Favourite", synonyms: ["favorite", "favourite", "starred"], kind: "boolean" },
  { key: "singleplayer", label: "Singleplayer", synonyms: ["singleplayer", "single player", "sp"], kind: "boolean" },
  { key: "coop", label: "Co-op", synonyms: ["coop", "co-op", "cooperative"], kind: "boolean" },
  { key: "multiplayer", label: "Multiplayer", synonyms: ["multiplayer", "mp"], kind: "boolean" },
  {
    key: "steamAppId",
    label: "Steam app id",
    synonyms: ["steamappid", "steam app id", "appid", "steam id"],
    kind: "text",
  },
  { key: "apiSource", label: "API source", synonyms: ["apisource", "api source"], kind: "text" },
  { key: "apiId", label: "API id", synonyms: ["apiid", "api id", "igdbid", "igdb id"], kind: "text" },
  {
    key: "lastPlayed",
    label: "Last played",
    synonyms: ["lastplayed", "last played"],
    kind: "date",
  },
  { key: "coverUrl", label: "Cover", synonyms: ["cover", "coverurl", "cover url"], kind: "text" },
  { key: "vaultPage", label: "Note", synonyms: ["note", "vaultpage", "vault page"], kind: "text" },
];

export function fieldsFor(domain: WidgetDomain): CsvField[] {
  if (domain === "reading") return READING_FIELDS;
  if (domain === "games") return GAMES_FIELDS;
  return WATCHLIST_FIELDS;
}

/**
 * Header row → target field, using the synonym table.
 *
 * The frozen `CsvImportPlan.mapping` is keyed by *source column*, which is the
 * direction the mapping UI edits it in: one row per column in the file, each
 * with a dropdown. A header that matches nothing is simply absent, and turns up
 * in `unmapped`.
 */
export function autoDetectMapping(
  headers: readonly string[],
  domain: WidgetDomain,
): Record<string, string> {
  const fields = fieldsFor(domain);
  const mapping: Record<string, string> = {};
  const claimed = new Set<string>();
  for (const header of headers) {
    const needle = header.trim().toLowerCase();
    if (needle === "") continue;
    const field = fields.find(
      (candidate) => !claimed.has(candidate.key) && candidate.synonyms.includes(needle),
    );
    if (!field) continue;
    mapping[header] = field.key;
    claimed.add(field.key);
  }
  return mapping;
}

// ---------------------------------------------------------------------------
// Import plan
// ---------------------------------------------------------------------------

/** Titles already in the library, for the duplicate flag. */
export interface ExistingIndex {
  /** Lower-cased title → id. */
  byTitle: Map<string, string>;
}

export function indexExisting(entries: readonly { id: string; title: string }[]): ExistingIndex {
  const byTitle = new Map<string, string>();
  for (const entry of entries) {
    const key = entry.title.trim().toLowerCase();
    if (key !== "" && !byTitle.has(key)) byTitle.set(key, entry.id);
  }
  return { byTitle };
}

/**
 * Turn a parsed file plus a mapping into the plan the preview renders and the
 * importer walks.
 *
 * Rows that map to nothing at all are dropped rather than imported as blanks —
 * a trailing separator line in a hand-edited file is not an entry.
 */
export function buildImportPlan(
  domain: WidgetDomain,
  rows: readonly string[][],
  mapping: Record<string, string>,
  existing: ExistingIndex,
): CsvImportPlan {
  const headers = (rows[0] ?? []).map((header) => header.trim());
  const unmapped = headers.filter((header) => header !== "" && mapping[header] === undefined);

  const out: CsvImportRow[] = [];
  // Seeded from the library, then grown as the plan is built: a duplicate is a
  // duplicate whether the earlier copy is already tracked or three rows up.
  const seen = new Map<string, { id: string; source: "library" | "file" }>();
  for (const [title, id] of existing.byTitle) seen.set(title, { id, source: "library" });
  for (const raw of rows.slice(1)) {
    if (!raw.some((cell) => cell.trim() !== "")) continue;
    const values: Record<string, string> = {};
    headers.forEach((header, index) => {
      const field = mapping[header];
      if (field === undefined) return;
      const value = (raw[index] ?? "").trim();
      if (value !== "") values[field] = value;
    });
    if (Object.keys(values).length === 0) continue;

    const row: CsvImportRow = { values };
    const title = (values.title ?? "").trim().toLowerCase();
    if (title !== "") {
      const duplicate = seen.get(title);
      if (duplicate !== undefined) {
        row.duplicateOf = duplicate.id;
        // Which kind of duplicate it is changes what the user should do about
        // it — skip an import they already have, or fix a file that lists the
        // same thing twice — so the preview is told which.
        row.duplicateSource = duplicate.source;
      } else {
        // Every accepted row joins the index, so the *second* "Dune" in a file
        // is a duplicate of the first even in an empty library (P1-1).
        seen.set(title, { id: `csv-row-${out.length + 1}`, source: "file" });
      }
    }
    out.push(row);
  }

  return { domain, mapping, rows: out, unmapped };
}

/**
 * Coerce one planned row into the field values an entity factory takes.
 *
 * Numbers that will not parse and dates that will not parse are dropped rather
 * than written as `0`/`""` — an unparseable cell is missing information, and a
 * silent zero is worse than a gap.
 */
export function coerceRow(domain: WidgetDomain, values: Record<string, string>): Record<string, unknown> {
  const fields = fieldsFor(domain);
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    const raw = values[field.key];
    if (raw === undefined || raw === "") continue;
    if (field.kind === "number") {
      const parsed = Number(raw);
      if (Number.isFinite(parsed)) {
        out[field.key] = field.key === "rating" ? Math.max(0, Math.min(5, parsed)) : parsed;
      }
      continue;
    }
    if (field.kind === "date") {
      const parsed = parseLooseDate(raw);
      if (parsed !== null) out[field.key] = parsed;
      continue;
    }
    if (field.kind === "boolean") {
      // Accept what a spreadsheet actually emits, including a bare `1`. Anything
      // unrecognised is left unset rather than guessed as false — the row simply
      // did not say (P1-2).
      const normalized = raw.trim().toLowerCase();
      if (["true", "yes", "y", "1", "x"].includes(normalized)) out[field.key] = true;
      else if (["false", "no", "n", "0", ""].includes(normalized)) out[field.key] = false;
      continue;
    }
    if (field.kind === "list") {
      const list = raw
        .split(/[;,]/)
        .map((part) => part.trim())
        .filter((part) => part !== "");
      if (list.length > 0) out[field.key] = list;
      continue;
    }
    out[field.key] = raw;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

function joinList(values: readonly string[] | undefined): string {
  return (values ?? []).filter((value) => value.trim() !== "").join(MULTI_SEPARATOR);
}

/**
 * The watchlist export — v3's 14 columns, in order, no additions.
 *
 * `studio` merges the API list with the user's manual additions, because from
 * the outside they are one fact about the title; the split only matters to the
 * refresh logic.
 */
export function exportWatchlistCsv(titles: readonly TitleV4[]): string {
  const rows = titles.map((title) =>
    CSV_WATCHLIST_COLUMNS.map((column) => {
      if (column === "studio") {
        const merged = [...title.studio];
        for (const extra of title.manualStudio) if (!merged.includes(extra)) merged.push(extra);
        return joinList(merged);
      }
      const value = (title as unknown as Record<string, unknown>)[column];
      return value === null || value === undefined ? "" : value;
    }),
  );
  return serializeCsv(CSV_WATCHLIST_COLUMNS, rows);
}

function exportWith(fields: readonly CsvField[], entries: readonly Record<string, unknown>[]): string {
  const headers = fields.map((field) => field.key);
  const rows = entries.map((entry) =>
    fields.map((field) => {
      const value = entry[field.key];
      if (value === null || value === undefined) return "";
      if (Array.isArray(value)) return joinList(value.map(String));
      // `false` must survive as "false", not as an empty cell that re-imports
      // as "the row did not say" (P1-2).
      if (typeof value === "boolean") return value ? "true" : "false";
      return value;
    }),
  );
  return serializeCsv(headers, rows);
}

export function exportReadingCsv(entries: readonly (Book | Manga)[]): string {
  return exportWith(READING_FIELDS, entries as unknown as Record<string, unknown>[]);
}

export function exportGamesCsv(games: readonly Game[]): string {
  return exportWith(GAMES_FIELDS, games as unknown as Record<string, unknown>[]);
}

/** `watchlog-export-YYYY-MM-DD.csv`, v3's naming. */
export function exportFileName(domain: WidgetDomain, today = new Date()): string {
  const stamp = iso(today.getFullYear(), today.getMonth() + 1, today.getDate());
  const suffix = domain === "watchlist" ? "" : `-${domain}`;
  return `watchlog-export${suffix}-${stamp}.csv`;
}
