/**
 * The Remove button asks first, and what it asks has changed.
 *
 * HISTORY, BECAUSE THE PIN MOVED
 * ------------------------------
 * This file was written when a real book's chapter index went to `[]` during
 * live testing. It pinned three things: nothing is written until the dialog
 * says yes; a yes writes a FORGET (so the self-healing disk scan cannot
 * resurrect the chapter); and the dialog tells the truth about the files.
 *
 * The first two still hold. The third has been *replaced by the reader's own
 * decision*: "When I do remove the chapter, it only removes the chapter
 * markdown and does not remove the diagram. Fix this." Removal now means the
 * files too — both of them, symmetrically, and by default.
 *
 * So this file now pins the new contract, which is strictly more dangerous and
 * therefore worth more pinning:
 *
 *   - **no** → nothing written, nothing trashed;
 *   - **yes + box ticked** → the index forgets AND every file the chapter owns
 *     goes to `fileManager.trashFile` — the trash, so it is undoable;
 *   - **yes + box unticked** → the old behaviour survives verbatim: forget the
 *     index, touch no file;
 *   - **both files or neither.** A note without a drawing, a drawing without a
 *     note, both — the removal takes what is there. The reported bug was the
 *     asymmetry, and it is the asymmetry these assertions are aimed at;
 *   - **never a hard delete.** `vault.delete` and `adapter.remove` are wired to
 *     throw here. If either is ever called, this suite fails loudly rather than
 *     the user losing a file irrecoverably;
 *   - **open panes are closed first**, in the main window and in a popout, by
 *     comparing paths rather than by any `instanceof` — a popout is a separate
 *     realm and this codebase has been bitten by that before.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const confirmMock = vi.fn();
vi.mock("../src/ui/modals/confirm", () => ({
  confirmAction: (...args: unknown[]) => confirmMock(...args),
}));

import { TFile, TFolder } from "obsidian";
import { removeChapter } from "../src/domains/reading/detail/study";
import {
  chaptersOnDisk,
  detachLeavesShowing,
  readChapters,
  readForgottenChapters,
  STUDY_CHAPTERS_KEY,
} from "../src/domains/reading/study";
import { WatchLogStore } from "../src/data/store";
import { createReadingStore } from "../src/domains/reading/store";
import { createBook } from "../src/data/schema";
import type { ReadingPatch } from "../src/types";

beforeEach(() => confirmMock.mockReset());

// The reading folder is set explicitly in `harness()` so these paths are the
// whole truth — the default derives from `settings.rootFolder` and would make
// every assertion below a quiz about that instead.
const FOLDER = "Reading/Dune";
const NOTE = `${FOLDER}/Chapter 01.md`;
const DIAGRAM = `${FOLDER}/Chapter 01 — diagram.excalidraw.md`;

interface FakeLeaf {
  id: string;
  detached: boolean;
  view: { file?: { path: string } };
  detach: () => void;
}

/**
 * A vault, a file manager and a workspace — enough to remove a chapter.
 *
 * `paths` is what exists on disk. `vault.delete` and `adapter.remove` are
 * present and throw: the point of having them is to prove they are never
 * reached, which a missing method could not.
 */
function harnessApp(paths: readonly string[]) {
  const files = new Set(paths);
  const trashed: string[] = [];
  const leaves: FakeLeaf[] = [];

  const fileAt = (path: string): TFile => Object.assign(new TFile(), { path });

  const app = {
    vault: {
      getAbstractFileByPath: (path: string) => {
        if (files.has(path)) return fileAt(path);
        if (path === FOLDER) {
          return Object.assign(new TFolder(), {
            path,
            children: [...files].map(fileAt),
          });
        }
        return null;
      },
      delete: () => {
        throw new Error("vault.delete must never be called — removal goes through the trash");
      },
      adapter: {
        remove: () => {
          throw new Error("adapter.remove must never be called");
        },
      },
    },
    fileManager: {
      trashFile: async (file: { path: string }) => {
        if (!files.has(file.path)) throw new Error(`not on disk: ${file.path}`);
        files.delete(file.path);
        trashed.push(file.path);
      },
    },
    workspace: {
      iterateAllLeaves: (cb: (leaf: FakeLeaf) => void) => [...leaves].forEach(cb),
    },
  };

  return {
    app,
    files,
    trashed,
    leaves,
    /**
     * Put a pane on screen showing `path`.
     *
     * `realm: "popout"` builds the view with a null prototype — a stand-in for
     * an object from another window, which no `instanceof` this code could
     * perform would ever match. Duck-typing on `view.file.path` does.
     */
    open: (path: string, realm: "main" | "popout" = "main") => {
      const view =
        realm === "popout"
          ? Object.assign(Object.create(null) as object, { file: { path } })
          : { file: { path } };
      const leaf: FakeLeaf = {
        id: `leaf-${leaves.length + 1}-${realm}`,
        detached: false,
        view: view as { file?: { path: string } },
        detach: () => {
          leaf.detached = true;
        },
      };
      leaves.push(leaf);
      return leaf;
    },
  };
}

async function harness(onDisk: readonly string[] = [NOTE, DIAGRAM]) {
  const store = new WatchLogStore({
    loadData: async () => null,
    saveData: async () => undefined,
  } as never);
  await store.load();
  const reading = createReadingStore(store);
  reading.reading.settings.defaultFolder = "Reading";
  const book = createBook({ id: "b", title: "Dune", author: "Frank Herbert" });
  Object.assign(book, { [STUDY_CHAPTERS_KEY]: [{ number: 1 }] });
  reading.reading.books.push(book);

  const vault = harnessApp(onDisk);
  const patches: ReadingPatch[] = [];
  const refreshes: number[] = [];
  const surface = {
    patch: (patch: ReadingPatch) => {
      Object.assign(book, patch);
      patches.push(patch);
    },
    refresh: () => refreshes.push(1),
  };
  const context = {
    app: vault.app as never,
    entry: book,
    settings: store.settings,
    reading: reading.reading,
  };
  return { book, patches, refreshes, surface, context, vault, store, reading };
}

function remove(h: Awaited<ReturnType<typeof harness>>): Promise<void> {
  return removeChapter({ number: 1 }, h.book as never, h.surface as never, h.context as never);
}

describe("removing a chapter", () => {
  it("writes nothing and trashes nothing when the dialog says no", async () => {
    confirmMock.mockResolvedValue({ confirmed: false, checked: true });
    const h = await harness();

    await remove(h);

    expect(confirmMock).toHaveBeenCalledOnce();
    expect(h.patches).toHaveLength(0);
    expect(readChapters(h.book as never)).toEqual([{ number: 1 }]);
    expect(h.vault.trashed).toEqual([]);
    expect([...h.vault.files]).toEqual([NOTE, DIAGRAM]);
  });

  it("forgets the index and trashes BOTH files on yes with the box ticked", async () => {
    confirmMock.mockResolvedValue({ confirmed: true, checked: true });
    const h = await harness();

    await remove(h);

    // The index forgets, and records that it forgot, so the disk scan cannot
    // put the chapter back on the next repaint.
    expect(readChapters(h.book as never)).toEqual([]);
    expect(readForgottenChapters(h.book as never)).toEqual([1]);

    // The note AND the drawing — the asymmetry that was reported.
    expect(h.vault.trashed.sort()).toEqual([DIAGRAM, NOTE].sort());
    expect([...h.vault.files]).toEqual([]);
  });

  it("forgets the index and touches no file when the box is unticked", async () => {
    confirmMock.mockResolvedValue({ confirmed: true, checked: false });
    const h = await harness();

    await remove(h);

    expect(readChapters(h.book as never)).toEqual([]);
    expect(readForgottenChapters(h.book as never)).toEqual([1]);
    expect(h.vault.trashed).toEqual([]);
    expect([...h.vault.files]).toEqual([NOTE, DIAGRAM]);
  });

  it("offers the box ticked, and says what unticking it means", async () => {
    confirmMock.mockResolvedValue({ confirmed: false, checked: false });
    const h = await harness();

    await remove(h);

    const options = confirmMock.mock.calls[0]?.[1] as {
      message: string;
      details?: string[];
      checkbox?: { label: string; default?: boolean };
      danger?: boolean;
    };
    expect(options.danger).toBe(true);
    expect(options.message).toBe("Chapter 1, its note and its drawing go to the trash.");
    expect(options.checkbox).toEqual({
      label: "Also move its note and its drawing to the trash.",
      default: true,
    });
    expect(options.details?.[0]).toContain("Untick the box");
    expect(options.details?.[0]).toContain(FOLDER);
    expect(options.details?.[1]).toContain("undoable");
  });

  it("takes just the drawing when that is all the chapter has", async () => {
    // The exact orphan the reader hit: the note gone by hand, the drawing left.
    confirmMock.mockResolvedValue({ confirmed: true, checked: true });
    const h = await harness([DIAGRAM]);

    // It is still a chapter as far as the folder is concerned…
    expect(chaptersOnDisk(h.vault.app as never, h.book as never, h.store.settings, h.reading.reading)).toEqual([1]);

    await remove(h);

    const options = confirmMock.mock.calls[0]?.[1] as {
      message: string;
      checkbox?: { label: string };
    };
    expect(options.message).toBe("Chapter 1, its drawing goes to the trash.");
    expect(options.checkbox?.label).toBe("Also move its drawing to the trash.");
    expect(h.vault.trashed).toEqual([DIAGRAM]);
  });

  it("takes just the note when that is all the chapter has", async () => {
    confirmMock.mockResolvedValue({ confirmed: true, checked: true });
    const h = await harness([NOTE]);

    await remove(h);

    const options = confirmMock.mock.calls[0]?.[1] as { message: string };
    expect(options.message).toBe("Chapter 1, its note goes to the trash.");
    expect(h.vault.trashed).toEqual([NOTE]);
  });

  it("offers no checkbox at all when the chapter has no files", async () => {
    confirmMock.mockResolvedValue({ confirmed: true, checked: true });
    const h = await harness([]);

    await remove(h);

    const options = confirmMock.mock.calls[0]?.[1] as {
      message: string;
      checkbox?: unknown;
    };
    expect(options.checkbox).toBeUndefined();
    expect(options.message).toContain("no files for it");
    expect(readChapters(h.book as never)).toEqual([]);
    expect(h.vault.trashed).toEqual([]);
  });

  it("closes the panes showing those files first — popouts included", async () => {
    confirmMock.mockResolvedValue({ confirmed: true, checked: true });
    const h = await harness();
    const notePane = h.vault.open(NOTE);
    const drawingPane = h.vault.open(DIAGRAM, "popout");
    const other = h.vault.open("Somewhere/Else.md");

    await remove(h);

    // A dead pane over a trashed path is what this prevents. The popout one is
    // matched by path, which is the only thing that works across realms.
    expect(notePane.detached).toBe(true);
    expect(drawingPane.detached).toBe(true);
    expect(other.detached).toBe(false);
    expect(h.vault.trashed.sort()).toEqual([DIAGRAM, NOTE].sort());
  });

  it("never reaches for a hard delete", async () => {
    // `vault.delete` and `adapter.remove` throw in this harness. Reaching the
    // end of a ticked removal with both files trashed is the proof.
    confirmMock.mockResolvedValue({ confirmed: true, checked: true });
    const h = await harness();

    await expect(remove(h)).resolves.toBeUndefined();
    expect(h.vault.trashed).toHaveLength(2);
    expect(h.refreshes).toHaveLength(1);
  });

  it("reports a file that would not go, and still forgets the chapter", async () => {
    confirmMock.mockResolvedValue({ confirmed: true, checked: true });
    const h = await harness();
    h.vault.app.fileManager.trashFile = async (file: { path: string }) => {
      if (file.path === DIAGRAM) throw new Error("locked by another process");
      h.vault.files.delete(file.path);
      h.vault.trashed.push(file.path);
    };

    await remove(h);

    expect(h.vault.trashed).toEqual([NOTE]);
    expect([...h.vault.files]).toEqual([DIAGRAM]);
    // The index still forgot — a file that will not move must not strand the
    // chapter in a half-removed state.
    expect(readChapters(h.book as never)).toEqual([]);
  });
});

describe("closing panes across windows", () => {
  it("matches on the path and leaves everything else alone", () => {
    const vault = harnessApp([NOTE]);
    const main = vault.open(NOTE);
    const popout = vault.open(NOTE, "popout");
    const unrelated = vault.open("Inbox/Random.md");

    expect(detachLeavesShowing(vault.app as never, [NOTE])).toBe(2);
    expect(main.detached).toBe(true);
    expect(popout.detached).toBe(true);
    expect(unrelated.detached).toBe(false);
  });

  it("does nothing when asked to close nothing", () => {
    const vault = harnessApp([NOTE]);
    vault.open(NOTE);
    expect(detachLeavesShowing(vault.app as never, [])).toBe(0);
  });
});
