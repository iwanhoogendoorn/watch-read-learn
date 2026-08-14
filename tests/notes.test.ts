/**
 * Per-title markdown notes (review finding P1-4).
 *
 * The vault side is exercised through the pure composers: what matters is that
 * frontmatter is regenerated, that nothing the user wrote outside `## Notes`
 * is ever lost, and that `## Notes` round-trips.
 */
import { describe, expect, it } from "vitest";
import { TFile, TFolder } from "obsidian";
import {
  NoteWriter,
  buildFrontmatter,
  composeNote,
  notePathFor,
  readNotesSection,
  sanitizeFileName,
  splitFrontmatter,
  upsertNotesSection,
} from "../src/data/notes";
import { createDefaultSettings, createTitle } from "../src/data/schema";
import type { Settings, TitleV4 } from "../src/types";

function title(overrides: Partial<TitleV4> = {}): TitleV4 {
  return createTitle({
    id: "dexter",
    title: "Dexter: Resurrection",
    type: "TV Show",
    status: "Watching",
    rating: 4,
    notes: "Best season since the original run.",
    totalEpisodes: 10,
    episodeDuration: 50,
    watchedEpisodes: [1, 2, 3, 4],
    seasons: [{ name: "Season 1", episodes: 10, offset: 0, skippedEpisodes: [], seasonNumber: 1 }],
    director: ["Marcos Siega"],
    cast: ["Michael C. Hall"],
    ...overrides,
  });
}

function settings(overrides: Partial<Settings> = {}): Settings {
  return { ...createDefaultSettings(), rootFolder: "Watchlist", ...overrides };
}

describe("note paths", () => {
  it("replaces every character Obsidian rejects", () => {
    expect(sanitizeFileName('Fahrenheit 9/11: "Special" <cut>')).toBe(
      "Fahrenheit 9-11- -Special- -cut-",
    );
  });

  it("nests the note under rootFolder/type", () => {
    expect(notePathFor(settings(), title())).toBe("Watchlist/TV Show/Dexter- Resurrection.md");
  });

  it("drops the folder segment when there is no root folder", () => {
    expect(notePathFor(settings({ rootFolder: "" }), title())).toBe(
      "TV Show/Dexter- Resurrection.md",
    );
  });
});

describe("frontmatter", () => {
  it("writes the v3 key set, with progress as a percentage", () => {
    const yaml = buildFrontmatter(title());
    expect(yaml.startsWith("---\n")).toBe(true);
    expect(yaml.trimEnd().endsWith("---")).toBe(true);
    expect(yaml).toContain('title: "Dexter: Resurrection"');
    expect(yaml).toContain('type: "TV Show"');
    expect(yaml).toContain('status: "Watching"');
    expect(yaml).toContain("rating: 4");
    expect(yaml).toContain('progress: "40%"');
    expect(yaml).toContain("totalEpisodes: 10");
    expect(yaml).toContain('  - "Michael C. Hall"');
  });

  it("omits optional keys rather than writing them empty", () => {
    const yaml = buildFrontmatter(title({ notes: "", director: [], cast: [] }));
    expect(yaml).not.toContain("review:");
    expect(yaml).not.toContain("trailer:");
    expect(yaml).not.toContain("director:");
    expect(yaml).not.toContain("favorite:");
  });

  it("escapes quotes and backslashes", () => {
    const yaml = buildFrontmatter(title({ title: 'The "Real" C:\\Path' }));
    expect(yaml).toContain('title: "The \\"Real\\" C:\\\\Path"');
  });

  it("prefers a manual override over the fetched value", () => {
    const yaml = buildFrontmatter(
      title({ posterUrl: "auto.jpg", manualPosterUrl: "mine.jpg" }),
    );
    expect(yaml).toContain('poster: "mine.jpg"');
    expect(yaml).not.toContain("auto.jpg");
  });
});

describe("the Notes section", () => {
  it("reads back only the Notes section", () => {
    const file = [
      "---",
      'title: "X"',
      "---",
      "",
      "## My own section",
      "",
      "Keep me.",
      "",
      "## Notes",
      "",
      "Watched this on a plane.",
      "",
      "## Afterwards",
      "",
      "Something else.",
      "",
    ].join("\n");

    expect(readNotesSection(file)).toBe("Watched this on a plane.");
  });

  it("keeps sub-headings inside the notes", () => {
    const file = "## Notes\n\nTop\n\n### Episode 4\n\nDetail\n";
    expect(readNotesSection(file)).toBe("Top\n\n### Episode 4\n\nDetail");
  });

  it("returns undefined when the note has no Notes section", () => {
    expect(readNotesSection("---\ntitle: \"X\"\n---\n\nJust prose.\n")).toBeUndefined();
  });

  it("appends the section when it is missing", () => {
    expect(upsertNotesSection("Existing prose.", "New thought")).toBe(
      "Existing prose.\n\n## Notes\n\nNew thought\n",
    );
  });
});

// ---------------------------------------------------------------------------
// The vault side, against a fake vault
// ---------------------------------------------------------------------------

function fakeVault() {
  const files = new Map<string, string>();
  const folders = new Set<string>();
  const app = {
    vault: {
      getAbstractFileByPath: (path: string) => {
        if (files.has(path)) return Object.assign(new TFile(), { path });
        if (folders.has(path)) return Object.assign(new TFolder(), { path });
        return null;
      },
      read: async (file: { path: string }) => files.get(file.path) ?? "",
      modify: async (file: { path: string }, contents: string) => {
        files.set(file.path, contents);
      },
      create: async (path: string, contents: string) => {
        files.set(path, contents);
      },
      createFolder: async (path: string) => {
        folders.add(path);
      },
    },
    fileManager: {
      renameFile: async (file: { path: string }, to: string) => {
        const contents = files.get(file.path) ?? "";
        files.delete(file.path);
        files.set(to, contents);
      },
    },
  };
  return { app, files, folders };
}

describe("NoteWriter", () => {
  it("creates the note, its folders, and its Notes section", async () => {
    const { app, files, folders } = fakeVault();
    const writer = new NoteWriter(app as never);

    await writer.sync(title(), settings());

    const path = "Watchlist/TV Show/Dexter- Resurrection.md";
    expect(files.has(path)).toBe(true);
    expect(folders.has("Watchlist/TV Show")).toBe(true);
    expect(readNotesSection(files.get(path) ?? "")).toBe("Best season since the original run.");
  });

  it("writes nothing while generateNotes is off", async () => {
    const { app, files } = fakeVault();
    const writer = new NoteWriter(app as never);

    await writer.sync(title(), settings({ generateNotes: false }));

    expect(files.size).toBe(0);
  });

  it("moves the note on rename and keeps the user's other sections", async () => {
    const { app, files } = fakeVault();
    const writer = new NoteWriter(app as never);
    const before = title();
    await writer.sync(before, settings());

    const path = "Watchlist/TV Show/Dexter- Resurrection.md";
    files.set(path, `${files.get(path) ?? ""}\n## Rewatch log\n\n- with Sam\n`);

    const renamed = { ...before, title: "Dexter Resurrected" };
    await writer.sync(renamed, settings());

    expect(files.has(path)).toBe(false);
    const moved = files.get("Watchlist/TV Show/Dexter Resurrected.md") ?? "";
    expect(moved).toContain('title: "Dexter Resurrected"');
    expect(moved).toContain("## Rewatch log");
    expect(moved).toContain("- with Sam");
  });

  it("reads a hand-edited Notes section back", async () => {
    const { app, files } = fakeVault();
    const writer = new NoteWriter(app as never);
    const record = title();
    await writer.sync(record, settings());

    const path = "Watchlist/TV Show/Dexter- Resurrection.md";
    files.set(path, (files.get(path) ?? "").replace("Best season", "Actually the best season"));

    expect(await writer.readNotes(record, settings())).toBe(
      "Actually the best season since the original run.",
    );
  });

  it("survives a vault that refuses to write", async () => {
    const { app } = fakeVault();
    app.vault.create = async () => {
      throw new Error("read-only vault");
    };
    const writer = new NoteWriter(app as never);

    await expect(writer.sync(title(), settings())).resolves.toBeUndefined();
  });
});

describe("composeNote", () => {
  it("regenerates frontmatter and preserves every other section", () => {
    const existing = [
      "---",
      'title: "Old name"',
      'status: "Plan to watch"',
      "---",
      "",
      "## Notes",
      "",
      "Old note.",
      "",
      "## Rewatch log",
      "",
      "- 2024: with Sam",
      "",
    ].join("\n");

    const next = composeNote(existing, title({ notes: "New note." }));

    expect(next).toContain('status: "Watching"');
    expect(next).not.toContain("Plan to watch");
    expect(next).toContain("## Rewatch log");
    expect(next).toContain("- 2024: with Sam");
    expect(readNotesSection(next)).toBe("New note.");
  });

  it("round-trips a note it wrote itself", () => {
    // One title, used for both passes. `createTitle` stamps dateAdded and
    // dateModified with the wall clock, so calling it twice produced two
    // titles a millisecond apart — which is not a round-trip, and which
    // passed locally and failed on a slower CI runner.
    const entry = title();
    const first = composeNote(undefined, entry);
    const second = composeNote(first, entry);
    expect(second).toBe(first);
    expect(readNotesSection(second)).toBe("Best season since the original run.");
  });

  it("produces a parseable frontmatter block for a brand-new note", () => {
    const note = composeNote(undefined, title());
    const { frontmatter, body } = splitFrontmatter(note);
    expect(frontmatter).toContain('title: "Dexter: Resurrection"');
    expect(body.trimStart().startsWith("## Notes")).toBe(true);
  });
});
