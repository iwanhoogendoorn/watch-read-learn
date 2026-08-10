/**
 * Following the vault when it moves underneath us.
 *
 * The live failure: a user renamed their `WatchLog` folder to `WRL` in the
 * file explorer. Obsidian moved the files and rewrote the `[[links]]` inside
 * notes, but every path stored in `data.json` still pointed at the old folder,
 * so "open the book" opened nothing.
 */
import { describe, expect, it } from "vitest";
import { repathAfterRename, repathOne } from "../src/data/paths";

describe("matching a renamed path", () => {
  it("follows an exact hit", () => {
    expect(repathOne("Books/Dune.pdf", "Books/Dune.pdf", "Books/Dune 2021.pdf")).toBe(
      "Books/Dune 2021.pdf",
    );
  });

  it("follows everything beneath a renamed folder", () => {
    expect(repathOne("WatchLog/Reading/Dune.pdf", "WatchLog", "WRL")).toBe("WRL/Reading/Dune.pdf");
  });

  it("does not touch a folder that merely starts the same way", () => {
    // The trailing slash is the whole point: `Books` must not match
    // `Books Archive/…`.
    expect(repathOne("Books Archive/Dune.pdf", "Books", "Shelf")).toBeNull();
  });

  it("ignores an unrelated path", () => {
    expect(repathOne("Elsewhere/Dune.pdf", "Books", "Shelf")).toBeNull();
  });

  it("ignores an empty stored path", () => {
    expect(repathOne("", "Books", "Shelf")).toBeNull();
  });
});

describe("rewriting a whole library after a folder rename", () => {
  const library = () => ({
    reading: {
      books: [
        {
          vaultPage: "WatchLog/Reading/Dune.md",
          filePath: "WatchLog/Reading/Dune.pdf",
        },
        { vaultPage: "", filePath: "Elsewhere/Other.pdf" },
      ],
      manga: [{ vaultPage: "WatchLog/Reading/Berserk.md", filePath: "" }],
      settings: { defaultFolder: "WatchLog/Reading" },
    },
    games: {
      games: [{ vaultPage: "WatchLog/Games/Hades.md" }],
      settings: { defaultFolder: "WatchLog/Games" },
    },
    settings: { rootFolder: "WatchLog", customListsFolder: "WatchLog/CustomLists" },
  });

  it("moves every stored path and folder setting", () => {
    const data = library();
    const result = repathAfterRename(data, "WatchLog", "WRL");

    expect(data.reading.books[0]?.filePath).toBe("WRL/Reading/Dune.pdf");
    expect(data.reading.books[0]?.vaultPage).toBe("WRL/Reading/Dune.md");
    expect(data.reading.manga[0]?.vaultPage).toBe("WRL/Reading/Berserk.md");
    expect(data.games.games[0]?.vaultPage).toBe("WRL/Games/Hades.md");
    // The folder settings move too — someone who renamed the folder their
    // notes live in has renamed where their notes live.
    expect(data.settings.rootFolder).toBe("WRL");
    expect(data.settings.customListsFolder).toBe("WRL/CustomLists");
    expect(data.reading.settings.defaultFolder).toBe("WRL/Reading");
    expect(data.games.settings.defaultFolder).toBe("WRL/Games");
    expect(result.changed).toBe(8);
  });

  it("leaves paths outside the renamed folder alone", () => {
    const data = library();
    repathAfterRename(data, "WatchLog", "WRL");
    expect(data.reading.books[1]?.filePath).toBe("Elsewhere/Other.pdf");
    expect(data.reading.books[1]?.vaultPage).toBe("");
  });

  it("reports nothing when the rename is unrelated", () => {
    const data = library();
    expect(repathAfterRename(data, "Somewhere Else", "Renamed").changed).toBe(0);
  });

  it("refuses a no-op rename", () => {
    const data = library();
    expect(repathAfterRename(data, "WatchLog", "WatchLog").changed).toBe(0);
  });

  it("survives a library with none of the optional blocks", () => {
    expect(repathAfterRename({}, "WatchLog", "WRL").changed).toBe(0);
  });
});
