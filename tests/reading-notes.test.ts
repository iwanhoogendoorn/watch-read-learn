/**
 * Reading notes — frontmatter regenerated, prose never touched.
 *
 * A `Book` has no notes field, so unlike a title note there is no read-back and
 * therefore no path by which a regeneration can lose a word the user wrote. The
 * tests below say that out loud: compose a note, edit it the way a person would,
 * compose it again, and check that every edit is still there.
 */
import { describe, expect, it } from "vitest";
import { createBook, createManga, createReadingData, createDefaultSettings } from "../src/data/schema";
import {
  NOTES_HEADING,
  QUOTES_HEADING,
  buildReadingFrontmatter,
  composeReadingNote,
  ensureHeading,
  readingFolderFor,
  readingNotePath,
} from "../src/domains/reading/notes";
import type { Book, Manga, ReadingData, Settings } from "../src/types";

const NOW = new Date(2026, 7, 3, 12, 0);

function data(): ReadingData {
  return createReadingData();
}

function settings(): Settings {
  return createDefaultSettings();
}

const DUNE: Book = createBook({
  id: "dune",
  title: "Dune",
  author: "Frank Herbert",
  status: "Completed",
  rating: 5,
  favorite: true,
  pagesRead: 528,
  totalPages: 528,
  releaseDate: "1965-08-01",
  dateStarted: "2024-01-01",
  dateFinished: "2024-02-01",
  coverUrl: "https://covers.openlibrary.org/b/isbn/9780441013593-M.jpg?default=false",
});

const BERSERK: Manga = createManga({
  id: "berserk",
  title: "Berserk",
  author: "Kentaro Miura",
  status: "Reading",
  chaptersRead: 300,
  totalChapters: 374,
  volumesRead: 34,
  totalVolumes: 42,
  malId: "2",
});

describe("where a note lives", () => {
  it("uses the reading library's own folder", () => {
    const reading = data();
    expect(readingNotePath(DUNE, settings(), reading)).toBe("Watch Read Learn/Reading/Dune.md");
  });

  it("falls back to rootFolder/Reading when the folder is blank", () => {
    const reading = data();
    reading.settings.defaultFolder = "";
    expect(readingFolderFor(settings(), reading)).toBe("Watch Read Learn/Reading");
  });

  it("honours a v3 folder the user set, so old notes are found", () => {
    const reading = data();
    reading.settings.defaultFolder = "Books";
    expect(readingNotePath(DUNE, settings(), reading)).toBe("Books/Dune.md");
  });

  it("replaces the characters Obsidian will not take in a file name", () => {
    const entry = createBook({ id: "x", title: 'A: "Great" Book/Thing?' });
    const path = readingNotePath(entry, settings(), data());
    // The folder separators are ours; only the file name is sanitised.
    expect(path.slice(path.lastIndexOf("/") + 1)).toBe("A- -Great- Book-Thing-.md");
  });
});

describe("frontmatter", () => {
  it("writes the fields a book note needs, and omits the ones it has not got", () => {
    const yaml = buildReadingFrontmatter(DUNE, "book", data(), NOW);
    expect(yaml).toContain('title: "Dune"');
    expect(yaml).toContain('type: "Book"');
    expect(yaml).toContain('author: "Frank Herbert"');
    expect(yaml).toContain('status: "Completed"');
    expect(yaml).toContain("rating: 5");
    expect(yaml).toContain('progress: "100%"');
    expect(yaml).toContain("totalPages: 528");
    expect(yaml).toContain("favorite: true");
    // Nothing was written for a counter the book does not use.
    expect(yaml).not.toContain("totalWords");
    expect(yaml).not.toContain("malId");
  });

  it("writes the derived status, not the stored one", () => {
    const entry = createBook({ id: "soon", title: "Soon", status: "Plan to Read", releaseDate: "2026-12-01" });
    expect(buildReadingFrontmatter(entry, "book", data(), NOW)).toContain('status: "To be released"');
  });

  it("writes a manga's volumes and MAL id", () => {
    const yaml = buildReadingFrontmatter(BERSERK, "manga", data(), NOW);
    expect(yaml).toContain('type: "Manga"');
    expect(yaml).toContain("totalVolumes: 42");
    expect(yaml).toContain('malId: "2"');
  });

  it("writes custom columns under their name, never their id", () => {
    const reading = data();
    reading.bookColumns = [{ id: "col-1", name: "Genre", type: "select", options: [], color: "#fff" }];
    const entry = createBook({ id: "g", title: "G", customFields: { "col-1": "Sci-Fi" } });
    const yaml = buildReadingFrontmatter(entry, "book", reading, NOW);
    expect(yaml).toContain('Genre: "Sci-Fi"');
    expect(yaml).not.toContain("col-1");
  });

  it("escapes a title that would break the YAML", () => {
    const entry = createBook({ id: "q", title: 'The "Quoted" One' });
    expect(buildReadingFrontmatter(entry, "book", data(), NOW)).toContain(
      'title: "The \\"Quoted\\" One"',
    );
  });
});

describe("composing a note", () => {
  it("gives a book both sections", () => {
    const note = composeReadingNote(undefined, DUNE, "book", data(), NOW);
    expect(note).toContain(NOTES_HEADING);
    expect(note).toContain(QUOTES_HEADING);
  });

  it("gives a manga notes but no quotes section", () => {
    const note = composeReadingNote(undefined, BERSERK, "manga", data(), NOW);
    expect(note).toContain(NOTES_HEADING);
    expect(note).not.toContain(QUOTES_HEADING);
  });

  it("never touches a word the user wrote", () => {
    const first = composeReadingNote(undefined, DUNE, "book", data(), NOW);
    const edited = first
      .replace("## Notes\n", "## Notes\n\nThe spice must flow.\n")
      .replace("## Quotes\n", "## Quotes\n\n> Fear is the mind-killer.\n")
      .concat("\n## My own heading\n\nSomething else entirely.\n");

    const changed = { ...DUNE, rating: 4 } as Book;
    const second = composeReadingNote(edited, changed, "book", data(), NOW);

    expect(second).toContain("The spice must flow.");
    expect(second).toContain("> Fear is the mind-killer.");
    expect(second).toContain("## My own heading");
    expect(second).toContain("Something else entirely.");
    // …and the frontmatter is the only thing that moved.
    expect(second).toContain("rating: 4");
  });

  it("does not grow a blank line on every regeneration", () => {
    const reading = data();
    let note = composeReadingNote(undefined, DUNE, "book", reading, NOW);
    for (let i = 0; i < 5; i += 1) note = composeReadingNote(note, DUNE, "book", reading, NOW);
    expect(note).toBe(composeReadingNote(note, DUNE, "book", reading, NOW));
  });

  it("does not add a second heading when the user renamed nothing", () => {
    const note = composeReadingNote(undefined, DUNE, "book", data(), NOW);
    const again = composeReadingNote(note, DUNE, "book", data(), NOW);
    expect(again.match(/^## Notes$/gm)).toHaveLength(1);
    expect(again.match(/^## Quotes$/gm)).toHaveLength(1);
  });

  it("accepts a heading the user demoted to level 1", () => {
    expect(ensureHeading("# Notes\n\nmine\n", NOTES_HEADING)).toBe("# Notes\n\nmine\n");
  });
});
