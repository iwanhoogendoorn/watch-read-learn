/**
 * The study workspace: chapters, their files, and the two motions the feature
 * exists for — book beside notes, and the page you are on embedded as a live
 * reference.
 *
 * What these tests are actually guarding, in order of how much it would hurt to
 * get wrong:
 *
 *   1. **Nothing here destroys a user's file.** A chapter note is created once
 *      and thereafter *opened*: the second click must find the paragraph typed
 *      after the first one still there. Removing a chapter edits an index and
 *      leaves the vault alone. Embedding a page appends and does not rewrite the
 *      note around the insertion.
 *   2. **A rename does not orphan a note.** The chapter's name rides in the
 *      filename, so renaming changes the path it *would* be created at — and the
 *      file that already exists has to keep being found.
 *   3. **The Excalidraw skeleton is the plugin's own.** A nearly-valid drawing
 *      opens as junk, and the user's response to junk is to delete it. The
 *      shape is asserted piece by piece against what the installed plugin
 *      writes for a blank drawing.
 *   4. **Every refusal says which one it is.** No linked file, no open PDF, and
 *      no Excalidraw are three different sentences, never a silent no-op.
 *
 * No network and no Node `fs`: the vault is a Map behind the same stubbed
 * `TFile`/`TFolder` the rest of the suite uses, and the workspace is a handful
 * of leaves.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Platform, TFile, TFolder } from "obsidian";
// The mock module by path, not through the `obsidian` alias: vitest resolves
// both to the same file, and only this one is typed with the recording the
// menu assertions read (`Menu.opened`).
import { Menu } from "./mocks/obsidian";
import { WatchLogStore } from "../src/data/store";
import { createBook } from "../src/data/schema";
import { createReadingStore, type ReadingStore } from "../src/domains/reading/store";
import type { ReadingEntry } from "../src/domains/reading/progress";
import { mountBookDetail, type BookDetailController } from "../src/ui/views/book-detail";
import { createHost, installDomGlobals, type StubEl } from "./helpers/dom";
import { mountReadingTab } from "../src/domains/reading";
import { buildBookCard } from "../src/domains/reading/card";
import {
  readExtra,
  writeExtra,
  type Book,
  type ReadingData,
  type ReadingPatch,
  type Settings,
} from "../src/types";
import {
  appendedBody,
  chapterDiagramPath,
  chapterFileClaim,
  chapterNotePath,
  chapterNoteTemplate,
  chapterOfFile,
  chapterStem,
  chaptersPatch,
  currentChapter,
  currentPageOf,
  excalidrawSkeleton,
  insertCurrentPage,
  insertCurrentPageIntoActiveNote,
  layoutFor,
  nextChapterNumber,
  openChapterMaterial,
  openReadMenu,
  openStudyShortcut,
  openStudySplit,
  popOutActiveChapterMaterial,
  popoutBox,
  popoutRequested,
  readRequestFor,
  openStudyPopout,
  type ReadRequest,
  pageEmbedBlock,
  readChapters,
  renamedChapter,
  resolveChapterFile,
  studyFolderFor,
  withChapter,
  withoutChapter,
  adoptChapterPatch,
  chapterFilesFor,
  chaptersOnDisk,
  describeChapterFiles,
  forgetChapterPatch,
  readForgottenChapters,
  reconciledChapters,
  READ_BUTTONS,
  READ_HINT,
  READ_LAYOUTS,
  STUDY_CHAPTERS_KEY,
  STUDY_FORGOTTEN_KEY,
  type StudyChapter,
  type StudyContext,
} from "../src/domains/reading/study";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BOOK_PDF = "Books/Dune.pdf";

/**
 * The store dispatches its change event on `document`, so even the tests that
 * never paint need the DOM stand-in — a chapter written through the store is a
 * store write like any other.
 */
let restoreDom: () => void;

beforeEach(() => {
  restoreDom = installDomGlobals(1200);
});

afterEach(() => {
  restoreDom();
});

async function shelf(over: Partial<Book> & Record<string, unknown> = {}) {
  const store = new WatchLogStore({
    loadData: async () => null,
    saveData: async () => undefined,
  } as never);
  await store.load();
  const reading: ReadingStore = createReadingStore(store);
  reading.reading.settings.defaultFolder = "Reading";

  const book = createBook({ id: "b", title: "Dune", author: "Frank Herbert" });
  Object.assign(book, over);
  reading.reading.books.push(book);
  return { store, reading, book };
}

/** A popout window: what the leaves inside it answer `getContainer()` with. */
interface FakeContainer {
  id: string;
  win: { focus: () => void };
}

interface FakeLeaf {
  id: string;
  mode: string;
  /** `"<anchor id>:<direction>"` when the leaf was split off a named pane. */
  splitFrom: string;
  /** The main window's container, or the popout the leaf now lives in. */
  container: FakeContainer;
  getContainer: () => FakeContainer;
  view: { file?: { path: string }; getState?: () => unknown };
  openFile: (file: { path: string }) => Promise<void>;
}

/**
 * A vault that is a Map, and a workspace that is a list of leaves.
 *
 * `create` returns a `TFile` because the real one does; `getAbstractFileByPath`
 * answers a `TFolder` carrying its children for any prefix that has files under
 * it, which is what `resolveChapterFile`'s fallback scan walks.
 */
function fakeApp(options: { pdfPage?: number; pdfPath?: string } = {}) {
  const files = new Map<string, string>();
  /* The book itself. Kept out of `files` so a test can still count the notes
     this feature created without the PDF muddling the total. */
  const shelved = new Set<string>([BOOK_PDF, options.pdfPath ?? BOOK_PDF]);
  const folders = new Set<string>();
  const leaves: FakeLeaf[] = [];
  const revealed: string[] = [];
  /* `workspace.rootSplit` — the one container that means "the main window". */
  const rootSplit: FakeContainer = { id: "root", win: { focus: () => focused.push("root") } };
  const windows: FakeContainer[] = [];
  const focused: string[] = [];
  const popoutBoxes: unknown[] = [];
  const moved: string[] = [];
  let nextWindow = 0;
  let active: { path: string } | null = null;
  let nextLeaf = 0;

  const fileAt = (path: string): TFile =>
    Object.assign(new TFile(), {
      path,
      basename: path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/, ""),
      extension: path.slice(path.lastIndexOf(".") + 1),
    });

  const folderAt = (path: string): TFolder => {
    const prefix = `${path}/`;
    const children = [...files.keys()]
      .filter((p) => p.startsWith(prefix) && !p.slice(prefix.length).includes("/"))
      .map(fileAt);
    return Object.assign(new TFolder(), { path, children });
  };

  const makeLeaf = (mode: string, splitFrom = ""): FakeLeaf => {
    const leaf: FakeLeaf = {
      id: `leaf-${(nextLeaf += 1)}`,
      mode,
      splitFrom,
      container: rootSplit,
      getContainer: () => leaf.container,
      view: {},
      openFile: async (file) => {
        leaf.view.file = { path: file.path };
        // A leaf's type follows its file, as it does in Obsidian: opening the
        // book into a plain tab makes that tab a PDF viewer.
        leaf.mode = file.path.toLowerCase().endsWith(".pdf") ? "pdf" : "markdown";
      },
    };
    leaves.push(leaf);
    return leaf;
  };

  if (options.pdfPage !== undefined) {
    const pdf = makeLeaf("pdf");
    pdf.view.file = { path: options.pdfPath ?? BOOK_PDF };
    pdf.view.getState = () => ({ page: options.pdfPage });
  }

  const app = {
    vault: {
      getAbstractFileByPath: (path: string) => {
        if (files.has(path) || shelved.has(path)) return fileAt(path);
        if (folders.has(path)) return folderAt(path);
        return null;
      },
      read: async (file: { path: string }) => files.get(file.path) ?? "",
      modify: async (file: { path: string }, contents: string) => {
        files.set(file.path, contents);
      },
      create: async (path: string, contents: string) => {
        files.set(path, contents);
        return fileAt(path);
      },
      createFolder: async (path: string) => {
        folders.add(path);
      },
    },
    workspace: {
      getLeavesOfType: (type: string) => leaves.filter((leaf) => leaf.mode === type),
      iterateAllLeaves: (cb: (leaf: FakeLeaf) => void) => leaves.forEach(cb),
      getLeaf: (mode: string) => makeLeaf(mode === "split" ? "markdown" : "markdown"),
      rootSplit,
      revealLeaf: (leaf: FakeLeaf) => revealed.push(leaf.id),
      openPopoutLeaf: (box: unknown) => {
        popoutBoxes.push(box);
        const container: FakeContainer = {
          id: `window-${(nextWindow += 1)}`,
          win: { focus: () => focused.push(container.id) },
        };
        windows.push(container);
        const leaf = makeLeaf("markdown");
        leaf.container = container;
        return leaf;
      },
      moveLeafToPopout: (leaf: FakeLeaf, box: unknown) => {
        popoutBoxes.push(box);
        moved.push(leaf.id);
        const container: FakeContainer = {
          id: `window-${(nextWindow += 1)}`,
          win: { focus: () => focused.push(container.id) },
        };
        windows.push(container);
        leaf.container = container;
        return container;
      },
      createLeafBySplit: (anchor: FakeLeaf, direction: string) =>
        makeLeaf("markdown", `${anchor.id}:${direction}`),
      openLinkText: async (link: string) => {
        const opened = makeLeaf("pdf");
        opened.view.file = { path: link.split("#")[0] ?? link };
        opened.view.getState = () => ({ page: options.pdfPage ?? 1 });
      },
      getActiveFile: () => active,
    },
  };

  return {
    app,
    files,
    folders,
    leaves,
    revealed,
    windows,
    focused,
    popoutBoxes,
    moved,
    /** Leaves that ended up in a window of their own. */
    popouts: () => leaves.filter((leaf) => leaf.container !== rootSplit),
    setActive: (path: string | null) => {
      active = path === null ? null : { path };
    },
    /** Leaves opened by `getLeaf(mode)`, i.e. everything that is not the PDF. */
    splits: () => leaves.filter((leaf) => leaf.mode === "markdown"),
  };
}

function contextFor(
  app: unknown,
  entry: ReadingEntry,
  reading: ReadingStore,
  settings: Settings,
): StudyContext {
  return {
    app: app as never,
    entry,
    settings,
    reading: reading.reading as ReadingData,
  };
}

const CH3: StudyChapter = { number: 3, name: "Arrakis" };

/**
 * Let a fire-and-forget click handler's promises settle before asserting.
 *
 * Microtasks only — nothing in these paths waits on a timer — so draining the
 * queue generously is both enough and instant. The deepest chain is the
 * three-pane layout: create the note, open it, create the drawing, split it.
 */
async function flush(): Promise<void> {
  for (let i = 0; i < 64; i += 1) await Promise.resolve();
}

// ---------------------------------------------------------------------------
// The chapter index
// ---------------------------------------------------------------------------

describe("chapter index", () => {
  it("reads nothing off a book that has never been given chapters", async () => {
    const { book } = await shelf();
    expect(readChapters(book)).toEqual([]);
  });

  it("sorts, floors, deduplicates and drops the unusable", async () => {
    const { book } = await shelf({
      [STUDY_CHAPTERS_KEY]: [
        { number: 3, name: " Arrakis " },
        { number: 1 },
        { number: 3, name: "duplicate" },
        { number: 0 },
        { number: "two" },
        null,
        { name: "no number" },
        { number: 2.7 },
      ],
    });
    expect(readChapters(book)).toEqual([
      { number: 1 },
      { number: 2 },
      { number: 3, name: "Arrakis" },
    ]);
  });

  it("proposes the next number, adds, renames and forgets", () => {
    let list: StudyChapter[] = [];
    expect(nextChapterNumber(list)).toBe(1);

    list = withChapter(list, nextChapterNumber(list), "Dune");
    list = withChapter(list, nextChapterNumber(list));
    expect(list).toEqual([{ number: 1, name: "Dune" }, { number: 2 }]);
    expect(nextChapterNumber(list)).toBe(3);

    list = renamedChapter(list, 2, "  Muad'Dib  ");
    expect(list[1]).toEqual({ number: 2, name: "Muad'Dib" });

    // A blank rename clears the name rather than storing an empty string.
    list = renamedChapter(list, 1, "   ");
    expect(list[0]).toEqual({ number: 1 });

    // Adding a number that is already there keeps one entry, not two.
    list = withChapter(list, 2, "Arrakis");
    expect(list.filter((c) => c.number === 2)).toHaveLength(1);

    expect(withoutChapter(list, 2)).toEqual([{ number: 1 }]);
  });

  it("patches through the store as a preserved key, without a literal rebuild", async () => {
    const { reading, book } = await shelf();
    reading.update("book", "b", chaptersPatch([CH3]), "study-chapter-added");

    expect(readExtra(book, STUDY_CHAPTERS_KEY)).toEqual([{ number: 3, name: "Arrakis" }]);
    // The rest of the row is untouched — this is a field, not a replacement.
    expect(book.title).toBe("Dune");
    expect(book.author).toBe("Frank Herbert");
  });
});

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

describe("chapter paths", () => {
  it("zero-pads so a folder listing sorts the way the book reads", () => {
    expect(chapterStem({ number: 3 })).toBe("Chapter 03");
    expect(chapterStem({ number: 10 })).toBe("Chapter 10");
    expect(chapterStem({ number: 103 })).toBe("Chapter 103");
  });

  it("makes a legal filename out of a chapter name full of illegal characters", () => {
    // The case in the brief: `C++: The Basics?` must not produce a path Obsidian
    // (or Windows) refuses.
    const stem = chapterStem({ number: 7, name: "C++: The Basics?" });
    expect(stem).toBe("Chapter 07 — C++- The Basics-");
    expect(stem).not.toMatch(/[*"\\/<>:|?]/);
  });

  it("puts a book's chapters in their own folder under the reading folder", async () => {
    const { store, reading, book } = await shelf();
    const settings = store.settings;

    expect(studyFolderFor(book, settings, reading.reading)).toBe("Reading/Dune");
    expect(chapterNotePath(book, CH3, settings, reading.reading)).toBe(
      "Reading/Dune/Chapter 03 — Arrakis.md",
    );
    expect(chapterDiagramPath(book, CH3, settings, reading.reading)).toBe(
      "Reading/Dune/Chapter 03 — Arrakis — diagram.excalidraw.md",
    );
  });

  it("reads a chapter number and its kind back off a file name", () => {
    expect(chapterFileClaim("Chapter 03.md")).toEqual({ number: 3, kind: "note" });
    expect(chapterFileClaim("Chapter 03 — Arrakis.md")).toEqual({ number: 3, kind: "note" });
    expect(chapterFileClaim("Chapter 03 — diagram.excalidraw.md")).toEqual({
      number: 3,
      kind: "diagram",
    });
    expect(chapterFileClaim("Chapter 3.md")).toEqual({ number: 3, kind: "note" });
    expect(chapterFileClaim("Notes.md")).toBeNull();
    expect(chapterFileClaim("Chapter 03.pdf")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

describe("templates", () => {
  it("links a new chapter note back to the book and to the page it starts on", async () => {
    const { book } = await shelf({ filePath: BOOK_PDF });
    const note = chapterNoteTemplate(book, CH3, 41);

    expect(note).toContain('book: "Dune"');
    expect(note).toContain("chapter: 3");
    expect(note).toContain('chapterTitle: "Arrakis"');
    expect(note).toContain("# Dune — Chapter 3: Arrakis");
    expect(note).toContain(`[[${BOOK_PDF}#page=41]]`);
    expect(note).toContain("## Notes");
  });

  it("says nothing about a page for a book with no file", async () => {
    const { book } = await shelf();
    const note = chapterNoteTemplate(book, { number: 1 }, 41);
    expect(note).not.toContain("#page=");
    expect(note).not.toContain("[[");
    expect(note).toContain("# Dune — Chapter 1");
  });

  it("writes the blank drawing the Excalidraw plugin itself writes", () => {
    const skeleton = excalidrawSkeleton();
    const lines = skeleton.split("\n");

    // Frontmatter, exactly as the plugin's own FRONTMATTER constant.
    expect(lines[0]).toBe("---");
    expect(lines[1]).toBe("");
    expect(lines[2]).toBe("excalidraw-plugin: parsed");
    expect(lines[3]).toBe("tags: [excalidraw]");
    expect(lines[4]).toBe("");
    expect(lines[5]).toBe("---");
    expect(lines[6]).toContain("Switch to EXCALIDRAW VIEW");

    // The drawing block, in the parsed (json) form the plugin reads.
    expect(skeleton).toContain("## Drawing\n```json\n");
    expect(skeleton.endsWith("\n```\n%%")).toBe(true);

    const json = /```json\n([\s\S]*?)\n```/.exec(skeleton)?.[1] ?? "";
    const drawing = JSON.parse(json) as Record<string, unknown>;
    expect(drawing.type).toBe("excalidraw");
    expect(drawing.version).toBe(2);
    expect(drawing.elements).toEqual([]);
    expect(drawing.appState).toEqual({ gridSize: null, viewBackgroundColor: "#ffffff" });
  });
});

// ---------------------------------------------------------------------------
// Creating and reopening
// ---------------------------------------------------------------------------

describe("chapter material", () => {
  it("creates a note once and opens the same one — with your words still in it", async () => {
    const { store, reading, book } = await shelf({ filePath: BOOK_PDF, filePage: 41 });
    const vault = fakeApp();
    const context = contextFor(vault.app, book, reading, store.settings);

    const first = await openChapterMaterial(context, CH3, "note");
    const path = "Reading/Dune/Chapter 03 — Arrakis.md";
    expect(first?.path).toBe(path);
    expect(vault.files.has(path)).toBe(true);
    expect(vault.folders.has("Reading/Dune")).toBe(true);

    // The user writes something. The second click must not touch it.
    vault.files.set(path, `${vault.files.get(path) ?? ""}\nSpice is the worm's doing.\n`);
    const second = await openChapterMaterial(context, CH3, "note");

    expect(second?.path).toBe(path);
    expect(vault.files.size).toBe(1);
    expect(vault.files.get(path)).toContain("Spice is the worm's doing.");
  });

  it("keeps writing to the note that exists after the chapter is renamed", async () => {
    const { store, reading, book } = await shelf();
    const vault = fakeApp();
    const context = contextFor(vault.app, book, reading, store.settings);

    await openChapterMaterial(context, { number: 3 }, "note");
    const original = "Reading/Dune/Chapter 03.md";
    vault.files.set(original, "notes I already took");

    // Renaming the chapter changes the path a *new* note would take…
    const renamed: StudyChapter = { number: 3, name: "Arrakis" };
    expect(chapterNotePath(book, renamed, store.settings, reading.reading)).not.toBe(original);

    // …and the existing file is still the one that is found and opened.
    const found = resolveChapterFile(
      vault.app as never,
      book,
      renamed,
      "note",
      store.settings,
      reading.reading,
    );
    expect(found?.path).toBe(original);

    const opened = await openChapterMaterial(context, renamed, "note");
    expect(opened?.path).toBe(original);
    expect(vault.files.size).toBe(1);
    expect(vault.files.get(original)).toBe("notes I already took");
  });

  it("leaves every file on disk when a chapter is removed from the index", async () => {
    const { store, reading, book } = await shelf();
    const vault = fakeApp();
    const context = contextFor(vault.app, book, reading, store.settings);
    reading.update("book", "b", chaptersPatch([CH3]), "study-chapter-added");

    await openChapterMaterial(context, CH3, "note");
    const path = "Reading/Dune/Chapter 03 — Arrakis.md";
    expect(vault.files.has(path)).toBe(true);

    reading.update(
      "book",
      "b",
      chaptersPatch(withoutChapter(readChapters(book), 3)),
      "study-chapter-removed",
    );

    expect(readChapters(book)).toEqual([]);
    expect(vault.files.has(path)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Excalidraw
// ---------------------------------------------------------------------------

describe("chapter diagrams", () => {
  afterEach(() => {
    delete (globalThis as { ExcalidrawAutomate?: unknown }).ExcalidrawAutomate;
  });

  it("refuses to write a drawing into a vault that cannot open one", async () => {
    const { store, reading, book } = await shelf();
    const vault = fakeApp();
    const context = contextFor(vault.app, book, reading, store.settings);

    const file = await openChapterMaterial(context, CH3, "diagram");

    expect(file).toBeNull();
    expect(vault.files.size).toBe(0);
  });

  it("lets the plugin's own automation API create the file when it is there", async () => {
    const { store, reading, book } = await shelf();
    const vault = fakeApp();
    const calls: { filename?: string; foldername?: string }[] = [];
    (globalThis as { ExcalidrawAutomate?: unknown }).ExcalidrawAutomate = {
      reset: () => undefined,
      create: async (params: { filename?: string; foldername?: string }) => {
        calls.push(params);
        const path = `${params.foldername}/${params.filename}`;
        vault.files.set(path, "written by the plugin");
        return path;
      },
    };

    const context = contextFor(vault.app, book, reading, store.settings);
    const file = await openChapterMaterial(context, CH3, "diagram");

    expect(calls).toEqual([
      {
        filename: "Chapter 03 — Arrakis — diagram.excalidraw.md",
        foldername: "Reading/Dune",
        onNewPane: false,
        silent: true,
      },
    ]);
    expect(file?.path).toBe("Reading/Dune/Chapter 03 — Arrakis — diagram.excalidraw.md");
    expect(vault.files.get(file?.path ?? "")).toBe("written by the plugin");
  });

  it("falls back to the skeleton when the plugin is installed but the API is not", async () => {
    const { store, reading, book } = await shelf();
    const vault = fakeApp();
    // The plugin is enabled; its automation object is not on `window` (an older
    // build, or a load order we do not control).
    Object.assign(vault.app, {
      plugins: { enabledPlugins: new Set(["obsidian-excalidraw-plugin"]) },
    });

    const context = contextFor(vault.app, book, reading, store.settings);
    const file = await openChapterMaterial(context, CH3, "diagram");
    const path = "Reading/Dune/Chapter 03 — Arrakis — diagram.excalidraw.md";

    expect(file?.path).toBe(path);
    expect(vault.files.get(path)).toBe(excalidrawSkeleton());

    // And a second click opens it rather than overwriting the drawing.
    vault.files.set(path, "a drawing with things in it");
    await openChapterMaterial(context, CH3, "diagram");
    expect(vault.files.get(path)).toBe("a drawing with things in it");
  });
});

// ---------------------------------------------------------------------------
// Side by side
// ---------------------------------------------------------------------------

describe("read side by side", () => {
  it("opens the book at its page and the chapter note in a split beside it", async () => {
    const { store, reading, book } = await shelf({ filePath: BOOK_PDF, filePage: 41 });
    const vault = fakeApp();
    const context = contextFor(vault.app, book, reading, store.settings);

    await openStudySplit(context, CH3, "note");

    const pdfs = vault.leaves.filter((leaf) => leaf.mode === "pdf");
    expect(pdfs).toHaveLength(1);
    expect(pdfs[0]?.view.file?.path).toBe(BOOK_PDF);

    const notes = vault.splits();
    expect(notes).toHaveLength(1);
    expect(notes[0]?.view.file?.path).toBe("Reading/Dune/Chapter 03 — Arrakis.md");
  });

  it("reveals the pane it already opened rather than splitting again", async () => {
    const { store, reading, book } = await shelf({ filePath: BOOK_PDF, filePage: 41 });
    const vault = fakeApp();
    const context = contextFor(vault.app, book, reading, store.settings);

    await openStudySplit(context, CH3, "note");
    await openStudySplit(context, CH3, "note");
    await openStudySplit(context, CH3, "note");

    // One pane each, however many times it is clicked — and the later clicks
    // reveal those two panes rather than opening more.
    expect(vault.splits()).toHaveLength(1);
    expect(vault.leaves.filter((leaf) => leaf.mode === "pdf")).toHaveLength(1);
    expect(vault.revealed).toEqual(["leaf-1", "leaf-2", "leaf-1", "leaf-2"]);
  });

  it("still opens the chapter note for a book with no file linked", async () => {
    const { store, reading, book } = await shelf();
    const vault = fakeApp();
    const context = contextFor(vault.app, book, reading, store.settings);

    const file = await openStudySplit(context, CH3, "note");

    expect(file?.path).toBe("Reading/Dune/Chapter 03 — Arrakis.md");
    expect(vault.leaves.filter((leaf) => leaf.mode === "pdf")).toHaveLength(0);
    expect(vault.splits()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The page reference
// ---------------------------------------------------------------------------

describe("insert current page", () => {
  it("builds an embed that is also a link, with no timestamp in the caption", () => {
    const block = pageEmbedBlock(BOOK_PDF, 41, "Dune");
    expect(block).toContain(`![[${BOOK_PDF}#page=41]]`);
    expect(block).toContain("*Dune, page 41*");
    expect(block).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it("appends without rewriting a byte of what was already there", () => {
    expect(appendedBody("first line\n", "BLOCK")).toBe("first line\nBLOCK");
    // A file that does not end in a newline gains one rather than losing a line.
    expect(appendedBody("no trailing newline", "BLOCK")).toBe("no trailing newline\nBLOCK");
    expect(appendedBody("", "BLOCK")).toBe("BLOCK");
  });

  it("takes the page out of whichever viewer has this book open", () => {
    const open = [
      { path: "Books/Other.pdf", page: 9 },
      { path: BOOK_PDF, page: 41 },
    ];
    expect(currentPageOf(open, BOOK_PDF)).toBe(41);
    expect(currentPageOf(open, "Books/Missing.pdf")).toBeNull();
    expect(currentPageOf(open, "")).toBeNull();
  });

  it("embeds the open page into the chapter note, creating the note if it has none", async () => {
    const { store, reading, book } = await shelf({ filePath: BOOK_PDF, filePage: 12 });
    const vault = fakeApp({ pdfPage: 41 });
    const context = contextFor(vault.app, book, reading, store.settings);

    const outcome = await insertCurrentPage(context, CH3);
    const path = "Reading/Dune/Chapter 03 — Arrakis.md";

    expect(outcome.ok).toBe(true);
    expect(outcome.page).toBe(41);
    expect(outcome.path).toBe(path);
    // The notice names both the page and the note it landed in.
    expect(outcome.message).toBe("Page 41 embedded in Chapter 3: Arrakis.");

    const contents = vault.files.get(path) ?? "";
    expect(contents).toContain("# Dune — Chapter 3: Arrakis");
    expect(contents).toContain(`![[${BOOK_PDF}#page=41]]`);
  });

  it("appends a second page below the first and keeps everything between", async () => {
    const { store, reading, book } = await shelf({ filePath: BOOK_PDF });
    const vault = fakeApp({ pdfPage: 41 });
    const context = contextFor(vault.app, book, reading, store.settings);
    const path = "Reading/Dune/Chapter 03 — Arrakis.md";

    await insertCurrentPage(context, CH3);
    vault.files.set(`${path}`, `${vault.files.get(path) ?? ""}\nMy own paragraph.\n`);
    await insertCurrentPage(context, CH3);

    const contents = vault.files.get(path) ?? "";
    expect(contents).toContain("My own paragraph.");
    expect(contents.match(/!\[\[Books\/Dune\.pdf#page=41\]\]/g)).toHaveLength(2);
    // The header the note was created with is still the first thing in it.
    expect(contents.startsWith("---\n")).toBe(true);
  });

  it("says the book has no file rather than writing anything", async () => {
    const { store, reading, book } = await shelf();
    const vault = fakeApp({ pdfPage: 41 });
    const context = contextFor(vault.app, book, reading, store.settings);

    const outcome = await insertCurrentPage(context, CH3);

    expect(outcome.ok).toBe(false);
    expect(outcome.message).toContain("no linked file");
    expect(vault.files.size).toBe(0);
  });

  it("says the PDF is not open rather than writing anything", async () => {
    const { store, reading, book } = await shelf({ filePath: BOOK_PDF });
    const vault = fakeApp(); // nothing open
    const context = contextFor(vault.app, book, reading, store.settings);

    const outcome = await insertCurrentPage(context, CH3);

    expect(outcome.ok).toBe(false);
    expect(outcome.message).toContain(BOOK_PDF);
    expect(vault.files.size).toBe(0);
  });

  it("ignores a different book's open PDF", async () => {
    const { store, reading, book } = await shelf({ filePath: BOOK_PDF });
    const vault = fakeApp({ pdfPage: 88, pdfPath: "Books/Neuromancer.pdf" });
    const context = contextFor(vault.app, book, reading, store.settings);

    const outcome = await insertCurrentPage(context, CH3);
    expect(outcome.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The palette command's half
// ---------------------------------------------------------------------------

describe("the active chapter note", () => {
  it("works out which book and chapter a path belongs to", async () => {
    const { store, reading, book } = await shelf();
    reading.update("book", "b", chaptersPatch([CH3]), "study-chapter-added");
    const books = reading.reading.books;

    const hit = chapterOfFile(
      "Reading/Dune/Chapter 03 — Arrakis.md",
      books,
      store.settings,
      reading.reading,
    );
    expect(hit?.entry.id).toBe("b");
    expect(hit?.chapter).toEqual(CH3);

    // A chapter file for a number nobody indexed still resolves — the file is
    // the fact, the list is only the index.
    expect(
      chapterOfFile("Reading/Dune/Chapter 09.md", books, store.settings, reading.reading)?.chapter,
    ).toEqual({ number: 9 });

    expect(
      chapterOfFile("Reading/Dune.md", books, store.settings, reading.reading),
    ).toBeNull();
    expect(
      chapterOfFile("Somewhere/Else/Chapter 03.md", books, store.settings, reading.reading),
    ).toBeNull();
  });

  it("embeds into the note that is actually open", async () => {
    const { store, reading, book } = await shelf({ filePath: BOOK_PDF });
    const vault = fakeApp({ pdfPage: 41 });
    reading.update("book", "b", chaptersPatch([CH3]), "study-chapter-added");
    const path = "Reading/Dune/Chapter 03 — Arrakis.md";
    vault.files.set(path, "# my chapter\n");
    vault.setActive(path);

    const outcome = await insertCurrentPageIntoActiveNote(
      vault.app as never,
      reading.reading.books,
      store.settings,
      reading.reading,
    );

    expect(outcome.ok).toBe(true);
    expect(outcome.path).toBe(path);
    expect(vault.files.get(path)).toBe(
      `# my chapter\n${pageEmbedBlock(BOOK_PDF, 41, "Dune")}`,
    );
    expect(book.title).toBe("Dune");
  });

  it("refuses a file that is not a chapter note of a tracked book", async () => {
    const { store, reading } = await shelf({ filePath: BOOK_PDF });
    const vault = fakeApp({ pdfPage: 41 });
    vault.setActive("Inbox/Random.md");

    const outcome = await insertCurrentPageIntoActiveNote(
      vault.app as never,
      reading.reading.books,
      store.settings,
      reading.reading,
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.message).toContain("Inbox/Random.md");
    expect(vault.files.size).toBe(0);
  });

  it("asks for a chapter note when nothing is open at all", async () => {
    const { store, reading } = await shelf();
    const vault = fakeApp();
    vault.setActive(null);

    const outcome = await insertCurrentPageIntoActiveNote(
      vault.app as never,
      reading.reading.books,
      store.settings,
      reading.reading,
    );
    expect(outcome).toEqual({ ok: false, message: "Open a chapter note first." });
  });
});

// ---------------------------------------------------------------------------
// The section on the book screen
// ---------------------------------------------------------------------------

describe("the Study section", () => {
  async function mount(over: Partial<Book> & Record<string, unknown> = {}) {
    const { store, reading, book } = await shelf(over);
    const vault = fakeApp();
    const host = createHost(1200);
    const pane: BookDetailController = mountBookDetail(
      host as unknown as HTMLElement,
      { kind: "book", id: "b" },
      { app: vault.app as never, store: store as never, reading },
    );
    return { store, reading, book, pane, vault, el: host as unknown as StubEl };
  }

  /** Only ever inside the Study section — every other screen has buttons too. */
  function study(el: StubEl): StubEl {
    const section = el.querySelector(".wl-study");
    if (!section) throw new Error("no Study section");
    return section;
  }

  function button(el: StubEl, label: string): StubEl {
    const found = study(el)
      .querySelectorAll("button")
      .find((b) => b.getAttribute("aria-label") === label || b.textContent.includes(label));
    if (!found) throw new Error(`no button labelled ${label}`);
    return found;
  }

  function repaint(pane: BookDetailController): void {
    (pane as unknown as { refresh(): void }).refresh();
  }

  it("invites a book with no chapters to have one, and adds it", async () => {
    const { el, book } = await mount();

    expect(study(el).textContent).toContain("Study");
    expect(el.textContent).toContain("No chapters yet");

    button(el, "Add chapter 1").fire("click");

    expect(readChapters(book)).toEqual([{ number: 1 }]);
    expect(el.textContent).toContain("Chapter 1");
    expect(el.textContent).toContain("Add chapter 2");
  });

  it("carries a typed name onto the chapter it adds", async () => {
    const { el, book } = await mount();
    const input = study(el)
      .querySelectorAll("input")
      .find((i) => i.getAttribute("aria-label") === "Name for chapter 1");
    if (!input) throw new Error("no name input");
    input.value = "Arrakis";

    button(el, "Add chapter 1").fire("click");

    expect(readChapters(book)).toEqual([{ number: 1, name: "Arrakis" }]);
    expect(el.textContent).toContain("Chapter 1: Arrakis");
  });

  it("offers every chapter verb, and marks the two that need a linked file", async () => {
    const { el } = await mount({ [STUDY_CHAPTERS_KEY]: [{ number: 3, name: "Arrakis" }] });

    for (const label of ["Note", "Diagram", "Read & take notes", "Insert page", "Rename", "Remove"]) {
      expect(button(el, label)).toBeDefined();
    }
    expect(button(el, "Read & take notes").classes.has("is-unavailable")).toBe(true);
    expect(button(el, "Insert page").classes.has("is-unavailable")).toBe(true);
    expect(el.textContent).toContain("Link the book's file above");
  });

  it("stops marking them once the book has a file", async () => {
    const { el } = await mount({
      filePath: BOOK_PDF,
      [STUDY_CHAPTERS_KEY]: [{ number: 3, name: "Arrakis" }],
    });

    expect(button(el, "Read & take notes").classes.has("is-unavailable")).toBe(false);
    expect(button(el, "Insert page").classes.has("is-unavailable")).toBe(false);
    expect(el.textContent).toContain("leaves its files alone");
  });

  it("says which chapters already have material", async () => {
    const { el, vault, pane } = await mount({
      [STUDY_CHAPTERS_KEY]: [{ number: 3, name: "Arrakis" }],
    });
    expect(button(el, "Note").classes.has("is-present")).toBe(false);

    vault.files.set("Reading/Dune/Chapter 03 — Arrakis.md", "already written");
    vault.folders.add("Reading/Dune");
    repaint(pane);

    expect(button(el, "Note").classes.has("is-present")).toBe(true);
    expect(button(el, "Diagram").classes.has("is-present")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Three panes
// ---------------------------------------------------------------------------

describe("read layouts", () => {
  afterEach(() => {
    delete (globalThis as { ExcalidrawAutomate?: unknown }).ExcalidrawAutomate;
    Menu.opened.length = 0;
  });

  /** Excalidraw present, so the diagram half of a layout can actually happen. */
  function withExcalidraw(): void {
    Object.assign(globalThis as Record<string, unknown>, {
      ExcalidrawAutomate: undefined,
    });
    delete (globalThis as { ExcalidrawAutomate?: unknown }).ExcalidrawAutomate;
  }

  function enablePlugin(app: object): void {
    Object.assign(app, {
      plugins: { enabledPlugins: new Set(["obsidian-excalidraw-plugin"]) },
    });
  }

  it("escalates on modifiers, with Shift beating Alt", () => {
    expect(layoutFor({})).toBe("note");
    expect(layoutFor({ altKey: true })).toBe("diagram");
    expect(layoutFor({ shiftKey: true })).toBe("both");
    // Both held: "both" is the more specific request, so it wins.
    expect(layoutFor({ altKey: true, shiftKey: true })).toBe("both");
  });

  it("opens the book beside the drawing for Read & draw", async () => {
    withExcalidraw();
    const { store, reading, book } = await shelf({ filePath: BOOK_PDF, filePage: 41 });
    const vault = fakeApp();
    enablePlugin(vault.app);
    const context = contextFor(vault.app, book, reading, store.settings);

    await openStudySplit(context, CH3, "diagram");

    expect(vault.leaves.filter((leaf) => leaf.mode === "pdf")).toHaveLength(1);
    const panes = vault.splits();
    expect(panes).toHaveLength(1);
    expect(panes[0]?.view.file?.path).toBe(
      "Reading/Dune/Chapter 03 — Arrakis — diagram.excalidraw.md",
    );
    // The note was never touched — asking to draw is not asking to write.
    expect(vault.files.has("Reading/Dune/Chapter 03 — Arrakis.md")).toBe(false);
  });

  it("puts the drawing under the note, not beside the book", async () => {
    withExcalidraw();
    const { store, reading, book } = await shelf({ filePath: BOOK_PDF, filePage: 41 });
    const vault = fakeApp();
    enablePlugin(vault.app);
    const context = contextFor(vault.app, book, reading, store.settings);

    await openStudySplit(context, CH3, "both");

    expect(vault.leaves.filter((leaf) => leaf.mode === "pdf")).toHaveLength(1);
    const panes = vault.splits();
    expect(panes).toHaveLength(2);

    const note = panes.find((p) => p.view.file?.path?.endsWith("Chapter 03 — Arrakis.md"));
    const drawing = panes.find((p) => p.view.file?.path?.endsWith(".excalidraw.md"));
    expect(note).toBeDefined();
    expect(drawing).toBeDefined();
    // Anchored on the note's pane and split horizontally — i.e. below it, which
    // is what leaves the book its full width.
    expect(drawing?.splitFrom).toBe(`${note?.id}:horizontal`);
  });

  it("adds the drawing to the arrangement that is already open", async () => {
    withExcalidraw();
    const { store, reading, book } = await shelf({ filePath: BOOK_PDF, filePage: 41 });
    const vault = fakeApp();
    enablePlugin(vault.app);
    const context = contextFor(vault.app, book, reading, store.settings);

    // The reader is already reading, book beside note.
    await openStudySplit(context, CH3, "note");
    const note = vault.splits()[0];
    expect(vault.splits()).toHaveLength(1);

    // Now they ask for all three. No second book pane, no second note pane.
    await openStudySplit(context, CH3, "both");

    expect(vault.leaves.filter((leaf) => leaf.mode === "pdf")).toHaveLength(1);
    const panes = vault.splits();
    expect(panes).toHaveLength(2);
    expect(panes[0]?.id).toBe(note?.id);
    expect(panes[1]?.splitFrom).toBe(`${note?.id}:horizontal`);
  });

  it("does not keep re-splitting when all three are asked for again", async () => {
    withExcalidraw();
    const { store, reading, book } = await shelf({ filePath: BOOK_PDF, filePage: 41 });
    const vault = fakeApp();
    enablePlugin(vault.app);
    const context = contextFor(vault.app, book, reading, store.settings);

    await openStudySplit(context, CH3, "both");
    await openStudySplit(context, CH3, "both");
    await openStudySplit(context, CH3, "both");

    expect(vault.leaves.filter((leaf) => leaf.mode === "pdf")).toHaveLength(1);
    expect(vault.splits()).toHaveLength(2);
  });

  it("still opens the note when the drawing cannot be made", async () => {
    // No Excalidraw at all: the note half of "both" must survive the refusal.
    const { store, reading, book } = await shelf({ filePath: BOOK_PDF });
    const vault = fakeApp();
    const context = contextFor(vault.app, book, reading, store.settings);

    const file = await openStudySplit(context, CH3, "both");

    expect(file?.path).toBe("Reading/Dune/Chapter 03 — Arrakis.md");
    expect(vault.splits()).toHaveLength(1);
    expect([...vault.files.keys()].some((p) => p.endsWith(".excalidraw.md"))).toBe(false);
  });

  it("offers all six by name in the right-click menu", async () => {
    withExcalidraw();
    const { store, reading, book } = await shelf({ filePath: BOOK_PDF });
    const vault = fakeApp();
    enablePlugin(vault.app);
    const context = contextFor(vault.app, book, reading, store.settings);

    const picked: ReadRequest[] = [];
    let prevented = 0;
    openReadMenu(
      { preventDefault: () => (prevented += 1) } as unknown as MouseEvent,
      (request) => picked.push(request),
    );

    expect(prevented).toBe(1);
    const menu = Menu.opened[0];
    expect(menu?.items.map((item) => item.title)).toEqual([
      "Read & take notes",
      "Read & draw",
      "Read with both",
      "Note in a separate window",
      "Drawing in a separate window",
      "Both, in two windows",
    ]);

    menu?.items[2]?.click();
    menu?.items[5]?.click();
    expect(picked).toEqual([
      { layout: "both", popout: false },
      { layout: "both", popout: true },
    ]);
    expect(READ_LAYOUTS.map((entry) => `${entry.layout}${entry.popout ? "-window" : ""}`)).toEqual([
      "note",
      "diagram",
      "both",
      "note-window",
      "diagram-window",
      "both-window",
    ]);
    // The tooltip has to teach every route or none of them is findable.
    expect(READ_HINT).toContain("Alt-click");
    expect(READ_HINT).toContain("Shift-click");
    expect(READ_HINT).toContain("Cmd-click");
    expect(READ_HINT).toContain("Right-click");
    expect(context.entry.title).toBe("Dune");
  });
});

// ---------------------------------------------------------------------------
// The row shortcut
// ---------------------------------------------------------------------------

describe("the current chapter", () => {
  it("is the furthest one indexed", async () => {
    const { book } = await shelf({
      [STUDY_CHAPTERS_KEY]: [{ number: 1 }, { number: 5, name: "Arrakis" }, { number: 2 }],
    });
    expect(currentChapter(book)).toEqual({ number: 5, name: "Arrakis" });
  });

  it("is chapter 1 for a book that has never had one", async () => {
    const { book } = await shelf();
    expect(currentChapter(book)).toEqual({ number: 1 });
  });

  it("creates chapter 1 on first use and opens the book beside it", async () => {
    const { store, reading, book } = await shelf({ filePath: BOOK_PDF, filePage: 6 });
    const vault = fakeApp();
    const context = contextFor(vault.app, book, reading, store.settings);
    const commits: unknown[] = [];

    const file = await openStudyShortcut(
      context,
      (patch) => {
        commits.push(patch);
        reading.update("book", "b", patch, "study-chapter-added");
      },
      "note",
    );

    expect(commits).toHaveLength(1);
    expect(readChapters(book)).toEqual([{ number: 1 }]);
    expect(file?.path).toBe("Reading/Dune/Chapter 01.md");
    expect(vault.leaves.filter((leaf) => leaf.mode === "pdf")).toHaveLength(1);
    expect(vault.splits()).toHaveLength(1);
  });

  it("writes the index once, not on every click", async () => {
    const { store, reading, book } = await shelf({ filePath: BOOK_PDF });
    const vault = fakeApp();
    const context = contextFor(vault.app, book, reading, store.settings);
    const commit = (patch: ReadingPatch): void => {
      reading.update("book", "b", patch, "study-chapter-added");
    };

    let writes = 0;
    const counted = (patch: ReadingPatch): void => {
      writes += 1;
      commit(patch);
    };
    await openStudyShortcut(context, counted, "note");
    await openStudyShortcut(context, counted, "note");

    expect(writes).toBe(1);
    expect(readChapters(book)).toEqual([{ number: 1 }]);
  });

  it("opens the chapter note alone, with no book beside it", async () => {
    const { store, reading, book } = await shelf({
      filePath: BOOK_PDF,
      [STUDY_CHAPTERS_KEY]: [{ number: 3, name: "Arrakis" }],
    });
    const vault = fakeApp();
    const context = contextFor(vault.app, book, reading, store.settings);

    const file = await openStudyShortcut(context, () => undefined, "alone");

    expect(file?.path).toBe("Reading/Dune/Chapter 03 — Arrakis.md");
    expect(vault.leaves.filter((leaf) => leaf.mode === "pdf")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The shortcuts on a table row
// ---------------------------------------------------------------------------

describe("study shortcuts on the Reading table", () => {
  let restore: () => void;

  beforeEach(() => {
    restore = installDomGlobals(1200);
  });

  afterEach(() => {
    restore();
    Menu.opened.length = 0;
  });

  async function table(over: Partial<Book> & Record<string, unknown> = {}) {
    const { store, reading, book } = await shelf(over);
    // The tab opens as a poster grid; the marker plus the stored mode is where
    // every reader is from their second launch, and the table is what is under
    // test here.
    writeExtra(reading.reading.settings, "viewModeGridDefault", true);
    writeExtra(reading.reading.settings, "viewMode", "table");
    const vault = fakeApp();
    const host = createHost(1200);
    const controller = mountReadingTab(host as unknown as HTMLElement, {
      app: vault.app as never,
      store: store as never,
      reading,
    });
    return { store, reading, book, vault, controller, el: controller.el as unknown as StubEl };
  }

  function row(el: StubEl): StubEl {
    const found = el.querySelectorAll(".wl-reading-row")[0];
    if (!found) throw new Error("no reading row");
    return found;
  }

  function rowButton(el: StubEl, label: string): StubEl {
    const found = row(el)
      .querySelectorAll("button")
      .find((b) => b.getAttribute("aria-label") === label);
    if (!found) throw new Error(`no row button labelled ${label}`);
    return found;
  }

  it("carries both study verbs without adding a column or a second line", async () => {
    const { el, controller } = await table({ filePath: BOOK_PDF });

    // Every action shares the row's LAST cell — the header writes one `<th>`
    // per cell, and a row with more cells than the header has columns is the
    // shear this table has been burned by before.
    const headCells = el.querySelectorAll("th").length;
    const bodyCells = row(el).children.filter((child) => child.tag === "td").length;
    expect(bodyCells).toBe(headCells);

    // …and inside that cell they are siblings on one line, never stacked.
    const actions = row(el).querySelectorAll(".wl-reading-rowactions");
    expect(actions).toHaveLength(1);
    const buttons = actions[0]?.children.filter((child) => child.tag === "button") ?? [];
    expect(buttons.map((b) => b.getAttribute("aria-label"))).toEqual([
      "Read & take notes",
      "Read & draw",
      "Open the chapter note",
      "One more page",
    ]);

    controller.destroy();
  });

  it("teaches the variants in the row's own tooltip", async () => {
    const { el, controller } = await table({ filePath: BOOK_PDF });
    const title = rowButton(el, "Read & take notes").getAttribute("title") ?? "";
    expect(title).toContain("Chapter 1");
    expect(title).toContain("Alt-click");
    expect(title).toContain("Shift-click");
    expect(title).toContain("Cmd-click");
    expect(rowButton(el, "Open the chapter note").getAttribute("title") ?? "").toContain(
      "separate window",
    );
    controller.destroy();
  });

  it("creates chapter 1 and opens the book beside it, from the row", async () => {
    const { el, book, vault, controller } = await table({ filePath: BOOK_PDF, filePage: 6 });
    expect(readChapters(book)).toEqual([]);

    rowButton(el, "Read & take notes").fire("click", {
      stopPropagation: () => undefined,
    });
    await flush();

    expect(readChapters(book)).toEqual([{ number: 1 }]);
    expect(vault.files.has("Reading/Dune/Chapter 01.md")).toBe(true);
    expect(vault.leaves.filter((leaf) => leaf.mode === "pdf")).toHaveLength(1);
    expect(vault.splits()).toHaveLength(1);
    controller.destroy();
  });

  it("opens the chapter note on its own from the second shortcut", async () => {
    const { el, vault, controller } = await table({
      filePath: BOOK_PDF,
      [STUDY_CHAPTERS_KEY]: [{ number: 2, name: "Arrakis" }],
    });

    rowButton(el, "Open the chapter note").fire("click", {
      stopPropagation: () => undefined,
    });
    await flush();

    expect(vault.files.has("Reading/Dune/Chapter 02 — Arrakis.md")).toBe(true);
    expect(vault.leaves.filter((leaf) => leaf.mode === "pdf")).toHaveLength(0);
    controller.destroy();
  });

  it("offers every layout on right-click, from the row too", async () => {
    const { el, controller } = await table({ filePath: BOOK_PDF });

    rowButton(el, "Read & take notes").fire("contextmenu", {
      stopPropagation: () => undefined,
      preventDefault: () => undefined,
    });

    expect(Menu.opened[0]?.items.map((item) => item.title)).toEqual([
      "Read & take notes",
      "Read & draw",
      "Read with both",
      "Note in a separate window",
      "Drawing in a separate window",
      "Both, in two windows",
    ]);
    controller.destroy();
  });

  it("does not open the detail screen when a shortcut is clicked", async () => {
    const { el, controller } = await table({ filePath: BOOK_PDF });
    let stopped = 0;
    rowButton(el, "Read & take notes").fire("click", {
      stopPropagation: () => (stopped += 1),
    });
    await flush();
    expect(stopped).toBe(1);
    controller.destroy();
  });

  it("still opens a chapter note for a book with no file linked", async () => {
    const { el, vault, controller } = await table();

    rowButton(el, "Read & take notes").fire("click", {
      stopPropagation: () => undefined,
    });
    await flush();

    // Half the job is impossible; the half that is possible still happens, and
    // `openStudySplit` says why in a Notice.
    expect(vault.files.has("Reading/Dune/Chapter 01.md")).toBe(true);
    expect(vault.leaves.filter((leaf) => leaf.mode === "pdf")).toHaveLength(0);
    controller.destroy();
  });
});

// ---------------------------------------------------------------------------
// The Read button on the book screen
// ---------------------------------------------------------------------------

describe("the Study section's Read button", () => {
  let restore: () => void;

  beforeEach(() => {
    restore = installDomGlobals(1200);
  });

  afterEach(() => {
    restore();
    Menu.opened.length = 0;
  });

  async function mount(over: Partial<Book> & Record<string, unknown> = {}) {
    const { store, reading, book } = await shelf(over);
    const vault = fakeApp();
    Object.assign(vault.app, {
      plugins: { enabledPlugins: new Set(["obsidian-excalidraw-plugin"]) },
    });
    const host = createHost(1200);
    const pane: BookDetailController = mountBookDetail(
      host as unknown as HTMLElement,
      { kind: "book", id: "b" },
      { app: vault.app as never, store: store as never, reading },
    );
    return { store, reading, book, pane, vault, el: host as unknown as StubEl };
  }

  function readButton(el: StubEl): StubEl {
    const section = el.querySelector(".wl-study");
    if (!section) throw new Error("no Study section");
    const found = section
      .querySelectorAll("button")
      .find((b) => b.getAttribute("aria-label") === "Read & take notes");
    if (!found) throw new Error("no Read button");
    return found;
  }

  const CHAPTERED = {
    filePath: BOOK_PDF,
    filePage: 41,
    [STUDY_CHAPTERS_KEY]: [{ number: 3, name: "Arrakis" }],
  };

  it("says what each Read button does, and how to go faster", async () => {
    const { el, pane } = await mount(CHAPTERED);
    expect(readButton(el).getAttribute("title")).toBe(
      "Open the book beside this chapter's note — Cmd-click for a separate window",
    );
    // The accelerators get a line of the section's own, because a tooltip is
    // only found by someone who already suspects there is something to find.
    expect(el.querySelector(".wl-study")?.textContent).toContain("Alt-click");
    expect(el.querySelector(".wl-study")?.textContent).toContain(READ_HINT);
    pane.destroy();
  });

  it("opens the drawing beside the book on Alt-click", async () => {
    const { el, vault, pane } = await mount(CHAPTERED);

    readButton(el).fire("click", { altKey: true });
    await flush();

    expect(vault.splits()).toHaveLength(1);
    expect(vault.splits()[0]?.view.file?.path).toBe(
      "Reading/Dune/Chapter 03 — Arrakis — diagram.excalidraw.md",
    );
    pane.destroy();
  });

  it("opens all three on Shift-click, drawing under the note", async () => {
    const { el, vault, pane } = await mount(CHAPTERED);

    readButton(el).fire("click", { shiftKey: true });
    await flush();

    const panes = vault.splits();
    expect(panes).toHaveLength(2);
    expect(panes[1]?.splitFrom).toBe(`${panes[0]?.id}:horizontal`);
    expect(vault.leaves.filter((leaf) => leaf.mode === "pdf")).toHaveLength(1);
    pane.destroy();
  });

  it("names every layout on right-click", async () => {
    const { el, pane } = await mount(CHAPTERED);

    readButton(el).fire("contextmenu", { preventDefault: () => undefined });

    expect(Menu.opened[0]?.items.map((item) => item.title)).toEqual([
      "Read & take notes",
      "Read & draw",
      "Read with both",
      "Note in a separate window",
      "Drawing in a separate window",
      "Both, in two windows",
    ]);
    pane.destroy();
  });

  it("keeps the plain click on the note alone", async () => {
    const { el, vault, pane } = await mount(CHAPTERED);

    readButton(el).fire("click", {});
    await flush();

    expect(vault.splits()).toHaveLength(1);
    expect(vault.splits()[0]?.view.file?.path).toBe("Reading/Dune/Chapter 03 — Arrakis.md");
    pane.destroy();
  });
});

// ---------------------------------------------------------------------------
// Separate OS windows
// ---------------------------------------------------------------------------

describe("popping a chapter out", () => {
  afterEach(() => {
    delete (globalThis as { ExcalidrawAutomate?: unknown }).ExcalidrawAutomate;
    Menu.opened.length = 0;
  });

  function enablePlugin(app: object): void {
    Object.assign(app, {
      plugins: { enabledPlugins: new Set(["obsidian-excalidraw-plugin"]) },
    });
  }

  it("asks for the whole work area, and never for nothing", () => {
    expect(popoutBox({ availWidth: 3440, availHeight: 1400, availLeft: 0, availTop: 25 })).toEqual({
      x: 0,
      y: 25,
      size: { width: 3440, height: 1400 },
    });
    // No metrics (headless, or an old Electron): a generous window, never 0×0.
    expect(popoutBox()).toEqual({ x: 0, y: 0, size: { width: 1440, height: 900 } });
    expect(popoutBox({ availWidth: 320, availHeight: 200 }).size).toEqual({
      width: 900,
      height: 600,
    });
  });

  it("opens the note in a window of its own and brings that window forward", async () => {
    const { store, reading, book } = await shelf({ filePath: BOOK_PDF, filePage: 41 });
    const vault = fakeApp();
    const context = contextFor(vault.app, book, reading, store.settings);

    const file = await openStudyPopout(context, CH3, "note");

    expect(file?.path).toBe("Reading/Dune/Chapter 03 — Arrakis.md");
    expect(vault.windows).toHaveLength(1);
    expect(vault.popouts()).toHaveLength(1);
    expect(vault.popouts()[0]?.view.file?.path).toBe(file?.path);
    // Revealing the leaf is not enough — the OS window has to be focused, or
    // the button reads as having done nothing.
    expect(vault.focused).toEqual(["window-1"]);
    // The book is left where it is: the point is a window to switch *to*.
    expect(vault.leaves.filter((leaf) => leaf.mode === "pdf")).toHaveLength(0);
  });

  it("gives the note and the drawing a window each", async () => {
    const { store, reading, book } = await shelf({ filePath: BOOK_PDF });
    const vault = fakeApp();
    enablePlugin(vault.app);
    const context = contextFor(vault.app, book, reading, store.settings);

    await openStudyPopout(context, CH3, "both");

    expect(vault.windows).toHaveLength(2);
    const shown = vault.popouts().map((leaf) => leaf.view.file?.path);
    expect(shown).toEqual([
      "Reading/Dune/Chapter 03 — Arrakis.md",
      "Reading/Dune/Chapter 03 — Arrakis — diagram.excalidraw.md",
    ]);
    expect(vault.focused).toEqual(["window-1", "window-2"]);
  });

  it("focuses the window it already made rather than opening a third", async () => {
    const { store, reading, book } = await shelf({ filePath: BOOK_PDF });
    const vault = fakeApp();
    const context = contextFor(vault.app, book, reading, store.settings);

    await openStudyPopout(context, CH3, "note");
    await openStudyPopout(context, CH3, "note");
    await openStudyPopout(context, CH3, "note");

    expect(vault.windows).toHaveLength(1);
    expect(vault.popouts()).toHaveLength(1);
    expect(vault.focused).toEqual(["window-1", "window-1", "window-1"]);
    expect(vault.revealed).toHaveLength(3);
  });

  it("moves a pane that is already open rather than duplicating it", async () => {
    const { store, reading, book } = await shelf({ filePath: BOOK_PDF });
    const vault = fakeApp();
    const context = contextFor(vault.app, book, reading, store.settings);

    // The note is open in the main window, and the user has typed in it.
    const inWindow = await openChapterMaterial(context, CH3, "note", "tab");
    vault.files.set(inWindow?.path ?? "", "words I am in the middle of writing");
    expect(vault.popouts()).toHaveLength(0);

    await openStudyPopout(context, CH3, "note");

    // That same leaf moved out — never a second view of one file.
    expect(vault.moved).toEqual(["leaf-1"]);
    expect(vault.leaves).toHaveLength(1);
    expect(vault.popouts()).toHaveLength(1);
    expect(vault.focused).toEqual(["window-1"]);
    expect(vault.files.get(inWindow?.path ?? "")).toBe("words I am in the middle of writing");
  });

  it("sizes the window to the work area", async () => {
    const { store, reading, book } = await shelf({ filePath: BOOK_PDF });
    const vault = fakeApp();
    const context = contextFor(vault.app, book, reading, store.settings);

    await openStudyPopout(context, CH3, "note");

    // Headless, so the fallback box — the assertion that matters is that a box
    // is passed at all, since a popout with no size opens as a sliver.
    expect(vault.popoutBoxes).toHaveLength(1);
    expect(vault.popoutBoxes[0]).toEqual(popoutBox());
  });

  it("falls back to a tab on an Obsidian that has no popouts", async () => {
    const { store, reading, book } = await shelf({ filePath: BOOK_PDF });
    const vault = fakeApp();
    // An older workspace: neither window method exists.
    const workspace = vault.app.workspace as unknown as Record<string, unknown>;
    delete workspace.openPopoutLeaf;
    delete workspace.moveLeafToPopout;
    const context = contextFor(vault.app, book, reading, store.settings);

    const file = await openStudyPopout(context, CH3, "note");

    expect(file?.path).toBe("Reading/Dune/Chapter 03 — Arrakis.md");
    expect(vault.windows).toHaveLength(0);
    // The note is still open, in this window — the lesser thing, not nothing.
    expect(vault.splits()[0]?.view.file?.path).toBe(file?.path);
  });

  it("reads the window modifier the way the platform does", () => {
    expect(Platform.isMacOS).toBe(false);
    expect(popoutRequested({})).toBe(false);
    expect(popoutRequested({ ctrlKey: true })).toBe(true);
    expect(popoutRequested({ metaKey: true })).toBe(false);

    // On a Mac it is Cmd — and deliberately NOT Ctrl, which is a right-click
    // there and would fire the popout and the menu from one gesture.
    Platform.isMacOS = true;
    try {
      expect(popoutRequested({ metaKey: true })).toBe(true);
      expect(popoutRequested({ ctrlKey: true })).toBe(false);
    } finally {
      Platform.isMacOS = false;
    }
  });

  it("combines the artefact modifier with the window one", () => {
    expect(readRequestFor({})).toEqual({ layout: "note", popout: false });
    expect(readRequestFor({ altKey: true })).toEqual({ layout: "diagram", popout: false });
    expect(readRequestFor({ shiftKey: true, ctrlKey: true })).toEqual({
      layout: "both",
      popout: true,
    });
  });
});

// ---------------------------------------------------------------------------
// The palette's window command
// ---------------------------------------------------------------------------

describe("popping out the chapter on screen", () => {
  it("pops out whichever chapter note is active", async () => {
    const { store, reading, book } = await shelf({ filePath: BOOK_PDF });
    const vault = fakeApp();
    reading.update("book", "b", chaptersPatch([CH3]), "study-chapter-added");
    const path = "Reading/Dune/Chapter 03 — Arrakis.md";
    vault.files.set(path, "# my chapter\n");
    vault.setActive(path);

    const outcome = await popOutActiveChapterMaterial(
      vault.app as never,
      reading.reading.books,
      store.settings,
      reading.reading,
      "note",
    );

    expect(outcome.ok).toBe(true);
    expect(outcome.path).toBe(path);
    expect(outcome.message).toBe("Chapter 3: Arrakis — note in a window of its own.");
    expect(vault.windows).toHaveLength(1);
    expect(book.title).toBe("Dune");
  });

  it("gives two windows for both, from the drawing as easily as the note", async () => {
    const { store, reading, book } = await shelf({ filePath: BOOK_PDF });
    const vault = fakeApp();
    Object.assign(vault.app, {
      plugins: { enabledPlugins: new Set(["obsidian-excalidraw-plugin"]) },
    });
    reading.update("book", "b", chaptersPatch([CH3]), "study-chapter-added");
    const drawing = "Reading/Dune/Chapter 03 — Arrakis — diagram.excalidraw.md";
    vault.files.set(drawing, excalidrawSkeleton());
    vault.setActive(drawing);

    const outcome = await popOutActiveChapterMaterial(
      vault.app as never,
      reading.reading.books,
      store.settings,
      reading.reading,
      "both",
    );

    expect(outcome.ok).toBe(true);
    expect(outcome.message).toContain("their own windows");
    expect(vault.windows).toHaveLength(2);
    expect(book.title).toBe("Dune");
  });

  it("refuses a file that belongs to no tracked book", async () => {
    const { store, reading } = await shelf({ filePath: BOOK_PDF });
    const vault = fakeApp();
    vault.setActive("Inbox/Random.md");

    const outcome = await popOutActiveChapterMaterial(
      vault.app as never,
      reading.reading.books,
      store.settings,
      reading.reading,
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.message).toContain("Inbox/Random.md");
    expect(vault.windows).toHaveLength(0);
  });

  it("asks for something to be open when nothing is", async () => {
    const { store, reading } = await shelf();
    const vault = fakeApp();
    vault.setActive(null);

    const outcome = await popOutActiveChapterMaterial(
      vault.app as never,
      reading.reading.books,
      store.settings,
      reading.reading,
    );

    expect(outcome).toEqual({
      ok: false,
      message: "Open a chapter note or drawing first.",
    });
  });
});

// ---------------------------------------------------------------------------
// The cross-realm rule, as a test rather than a convention
// ---------------------------------------------------------------------------

describe("the popout code and the realm boundary", () => {
  const SOURCES = [
    "src/domains/reading/study.ts",
    "src/domains/reading/detail/study.ts",
  ];

  /** Code with its comments removed — a rule about code, not about prose. */
  function code(relative: string): string {
    const root = dirname(dirname(fileURLToPath(import.meta.url)));
    return readFileSync(join(root, relative), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
  }

  it("never uses instanceof against a DOM constructor", () => {
    // Each popout window is its own realm with its own `HTMLElement`, so
    // `el instanceof HTMLElement` is FALSE for a perfectly good element that
    // came out of one. This codebase has been bitten by exactly that.
    const offenders: string[] = [];
    for (const file of SOURCES) {
      const hits = code(file).match(
        /instanceof\s+(HTML\w*|SVG\w*|Element|Node|Event|MouseEvent|Document|Window)\b/g,
      );
      if (hits) offenders.push(`${file}: ${hits.join(", ")}`);
    }
    expect(offenders).toEqual([]);
  });

  it("keeps the instanceof checks it does have on Obsidian's own objects", () => {
    // `TFile`/`TFolder` come from the single `obsidian` module every window
    // shares, so those are safe outright. `Error` is the one realm-sensitive
    // check in the file and it is safe by *construction*: it only ever decides
    // between `err.message` and `String(err)` for a Notice, so a foreign-realm
    // Error degrades to a stringified sentence rather than to a crash.
    //
    // Naming all three is what makes the test above a rule rather than a
    // coincidence: a fourth cannot appear without landing here first.
    const kinds = new Set(
      [...code(SOURCES[0] ?? "").matchAll(/instanceof\s+(\w+)/g)].map((m) => m[1]),
    );
    expect([...kinds].sort()).toEqual(["Error", "TFile", "TFolder"]);
  });

  it("never reaches for a global document or window", () => {
    // A popout has its own. Anything realm-sensitive goes through the leaf
    // (`getContainer().win`) or through the element's own `ownerDocument`.
    const offenders: string[] = [];
    for (const file of SOURCES) {
      const hits = code(file).match(/\b(document|window)\.[A-Za-z_$]/g);
      if (hits) offenders.push(`${file}: ${hits.join(", ")}`);
    }
    expect(offenders).toEqual([]);
  });

  it("reads exactly two globals, both of which are realm-independent", () => {
    // `ExcalidrawAutomate` is registered once by the plugin on the main window,
    // and the screen is the screen whichever window asks. Everything else must
    // arrive as an argument.
    const globals = new Set(
      SOURCES.flatMap((file) => [...code(file).matchAll(/globalThis\s*as[^)]*?\}\s*\)\.(\w+)/g)].map((m) => m[1])),
    );
    expect([...globals].sort()).toEqual(["ExcalidrawAutomate", "screen"]);
  });
});

// ---------------------------------------------------------------------------
// The window modifier, on the surfaces that offer it
// ---------------------------------------------------------------------------

describe("the window modifier on screen", () => {
  let restore: () => void;

  beforeEach(() => {
    restore = installDomGlobals(1200);
  });

  afterEach(() => {
    restore();
    Menu.opened.length = 0;
  });

  async function mountBook(over: Partial<Book> & Record<string, unknown> = {}) {
    const { store, reading, book } = await shelf(over);
    const vault = fakeApp();
    Object.assign(vault.app, {
      plugins: { enabledPlugins: new Set(["obsidian-excalidraw-plugin"]) },
    });
    const host = createHost(1200);
    const pane: BookDetailController = mountBookDetail(
      host as unknown as HTMLElement,
      { kind: "book", id: "b" },
      { app: vault.app as never, store: store as never, reading },
    );
    return { store, reading, book, pane, vault, el: host as unknown as StubEl };
  }

  function studyButton(el: StubEl, label: string): StubEl {
    const section = el.querySelector(".wl-study");
    if (!section) throw new Error("no Study section");
    const found = section
      .querySelectorAll("button")
      .find((b) => b.getAttribute("aria-label") === label);
    if (!found) throw new Error(`no ${label} button`);
    return found;
  }

  const CHAPTERED = {
    filePath: BOOK_PDF,
    filePage: 41,
    [STUDY_CHAPTERS_KEY]: [{ number: 3, name: "Arrakis" }],
  };

  it("sends the note to its own window on the window modifier", async () => {
    const { el, vault, pane } = await mountBook(CHAPTERED);

    studyButton(el, "Note").fire("click", { ctrlKey: true });
    await flush();

    expect(vault.windows).toHaveLength(1);
    expect(vault.popouts()[0]?.view.file?.path).toBe("Reading/Dune/Chapter 03 — Arrakis.md");
    pane.destroy();
  });

  it("leaves a plain click on the note in this window", async () => {
    const { el, vault, pane } = await mountBook(CHAPTERED);

    studyButton(el, "Note").fire("click", {});
    await flush();

    expect(vault.windows).toHaveLength(0);
    expect(vault.splits()[0]?.view.file?.path).toBe("Reading/Dune/Chapter 03 — Arrakis.md");
    pane.destroy();
  });

  it("sends Read to two windows on the window modifier plus Shift", async () => {
    const { el, vault, pane } = await mountBook(CHAPTERED);

    studyButton(el, "Read & take notes").fire("click", { ctrlKey: true, shiftKey: true });
    await flush();

    expect(vault.windows).toHaveLength(2);
    // Windows, not panes: there is nothing to Cmd-Tab between otherwise.
    expect(vault.splits().filter((leaf) => leaf.container.id === "root")).toHaveLength(0);
    pane.destroy();
  });

  it("says so on every control that honours it", async () => {
    const { el, pane } = await mountBook(CHAPTERED);
    for (const label of ["Note", "Diagram", "Read & take notes"]) {
      expect(studyButton(el, label).getAttribute("title") ?? "").toContain("separate window");
    }
    pane.destroy();
  });
});

// ---------------------------------------------------------------------------
// The grid card's menu
// ---------------------------------------------------------------------------

describe("the grid card's study actions", () => {
  let restore: () => void;

  beforeEach(() => {
    restore = installDomGlobals(1200);
  });

  afterEach(() => {
    restore();
    Menu.opened.length = 0;
  });

  it("offers the three study verbs a poster has no room to show", async () => {
    const { store, book } = await shelf({ filePath: BOOK_PDF });
    const host = createHost(1200);
    const called: string[] = [];

    buildBookCard(host as unknown as HTMLElement, book, {
      settings: store.settings,
      showActions: true,
      renderPoster: () => undefined,
      onOpen: () => called.push("open"),
      onStudy: () => called.push("study"),
      onOpenChapterNote: () => called.push("note"),
      onPopOutChapter: () => called.push("popout"),
    });

    const menuButton = (host as unknown as StubEl)
      .querySelectorAll("button")
      .find((b) => b.classes.has("wl-card-menu"));
    if (!menuButton) throw new Error("no card menu button");
    menuButton.fire("click", {
      preventDefault: () => undefined,
      stopPropagation: () => undefined,
    });

    const titles = Menu.opened[0]?.items.map((item) => item.title) ?? [];
    expect(titles).toContain("Read & take notes");
    expect(titles).toContain("Open the chapter note");
    expect(titles).toContain("Chapter note in a separate window");

    const study = Menu.opened[0]?.items.find((item) => item.title === "Read & take notes");
    study?.click();
    const popout = Menu.opened[0]?.items.find(
      (item) => item.title === "Chapter note in a separate window",
    );
    popout?.click();
    expect(called).toEqual(["study", "popout"]);
  });
});

// ---------------------------------------------------------------------------
// The Read verbs are buttons, not modifiers
// ---------------------------------------------------------------------------

describe("the Read buttons", () => {
  let restore: () => void;

  beforeEach(() => {
    restore = installDomGlobals(1200);
  });

  afterEach(() => {
    restore();
    Menu.opened.length = 0;
  });

  async function mountBook(over: Partial<Book> & Record<string, unknown> = {}) {
    const { store, reading, book } = await shelf(over);
    const vault = fakeApp();
    Object.assign(vault.app, {
      plugins: { enabledPlugins: new Set(["obsidian-excalidraw-plugin"]) },
    });
    const host = createHost(1200);
    const pane: BookDetailController = mountBookDetail(
      host as unknown as HTMLElement,
      { kind: "book", id: "b" },
      { app: vault.app as never, store: store as never, reading },
    );
    return { store, reading, book, pane, vault, el: host as unknown as StubEl };
  }

  function studyButtons(el: StubEl): StubEl[] {
    const section = el.querySelector(".wl-study");
    if (!section) throw new Error("no Study section");
    return section.querySelectorAll("button");
  }

  function byLabel(el: StubEl, label: string): StubEl {
    const found = studyButtons(el).find((b) => b.getAttribute("aria-label") === label);
    if (!found) throw new Error(`no button labelled ${label}`);
    return found;
  }

  const CHAPTERED = {
    filePath: BOOK_PDF,
    filePage: 41,
    [STUDY_CHAPTERS_KEY]: [{ number: 3, name: "Arrakis" }],
  };

  it("gives every way of reading its own visible button", async () => {
    const { el, pane } = await mountBook(CHAPTERED);

    // Not behind a modifier and not behind a menu: three buttons you can see.
    for (const option of READ_BUTTONS) {
      expect(byLabel(el, option.title)).toBeDefined();
    }
    expect(READ_BUTTONS.map((o) => o.title)).toEqual([
      "Read & take notes",
      "Read & draw",
      "Read with both",
    ]);
    // Each with an icon of its own, or a row of buttons is a row of one button.
    expect(new Set(READ_BUTTONS.map((o) => o.icon)).size).toBe(3);
    pane.destroy();
  });

  it("opens the book beside the drawing straight off the Read & draw button", async () => {
    const { el, vault, pane } = await mountBook(CHAPTERED);

    byLabel(el, "Read & draw").fire("click", {});
    await flush();

    expect(vault.leaves.filter((leaf) => leaf.mode === "pdf")).toHaveLength(1);
    expect(vault.splits()).toHaveLength(1);
    expect(vault.splits()[0]?.view.file?.path).toBe(
      "Reading/Dune/Chapter 03 — Arrakis — diagram.excalidraw.md",
    );
    pane.destroy();
  });

  it("opens all three straight off the Read with both button", async () => {
    const { el, vault, pane } = await mountBook(CHAPTERED);

    byLabel(el, "Read with both").fire("click", {});
    await flush();

    expect(vault.leaves.filter((leaf) => leaf.mode === "pdf")).toHaveLength(1);
    const panes = vault.splits();
    expect(panes).toHaveLength(2);
    expect(panes[1]?.splitFrom).toBe(`${panes[0]?.id}:horizontal`);
    pane.destroy();
  });

  it("keeps the modifiers working on top of the buttons", async () => {
    const { el, vault, pane } = await mountBook(CHAPTERED);

    // Shift on "Read & draw" still means both — one modifier, one meaning,
    // whichever button it is pressed on.
    byLabel(el, "Read & draw").fire("click", { shiftKey: true });
    await flush();
    expect(vault.splits()).toHaveLength(2);

    // And the window modifier still composes with the button's own layout.
    byLabel(el, "Read & draw").fire("click", { ctrlKey: true });
    await flush();
    expect(vault.windows).toHaveLength(1);
    pane.destroy();
  });
});

// ---------------------------------------------------------------------------
// Removing a chapter
// ---------------------------------------------------------------------------

describe("forgetting a chapter", () => {
  it("records the intent, so healing cannot undo it", async () => {
    const { book } = await shelf({
      [STUDY_CHAPTERS_KEY]: [{ number: 1 }, { number: 3, name: "Arrakis" }],
    });

    const patch = forgetChapterPatch(book, 3) as unknown as Record<string, unknown>;
    expect(patch[STUDY_CHAPTERS_KEY]).toEqual([{ number: 1 }]);
    expect(patch[STUDY_FORGOTTEN_KEY]).toEqual([3]);
  });

  it("un-forgets a chapter that is added back", async () => {
    const { book } = await shelf({
      [STUDY_CHAPTERS_KEY]: [{ number: 1 }],
      [STUDY_FORGOTTEN_KEY]: [3, 5],
    });
    expect(readForgottenChapters(book)).toEqual([3, 5]);

    const patch = adoptChapterPatch(book, 3, "Arrakis") as unknown as Record<string, unknown>;
    expect(patch[STUDY_CHAPTERS_KEY]).toEqual([{ number: 1 }, { number: 3, name: "Arrakis" }]);
    expect(patch[STUDY_FORGOTTEN_KEY]).toEqual([5]);
  });

  it("tolerates a forgotten list that is not a list of numbers", async () => {
    const { book } = await shelf({ [STUDY_FORGOTTEN_KEY]: ["3", null, 2, 2, 0, 4.7] });
    expect(readForgottenChapters(book)).toEqual([2, 4]);
  });
});

// ---------------------------------------------------------------------------
// The index heals itself from the folder
// ---------------------------------------------------------------------------

describe("reconciling the chapter index with the folder", () => {
  let restore: () => void;

  beforeEach(() => {
    restore = installDomGlobals(1200);
  });

  afterEach(() => {
    restore();
  });

  it("reads every chapter number the folder can prove", async () => {
    const { store, reading, book } = await shelf();
    const vault = fakeApp();
    vault.folders.add("Reading/Dune");
    vault.files.set("Reading/Dune/Chapter 01.md", "");
    vault.files.set("Reading/Dune/Chapter 01 — diagram.excalidraw.md", "");
    vault.files.set("Reading/Dune/Chapter 04 — Arrakis.md", "");
    // Not named like a chapter: the reader's own file, and none of our business.
    vault.files.set("Reading/Dune/Notes on the routing bit.md", "");
    vault.files.set("Reading/Dune/Chapter 03.pdf", "");

    expect(chaptersOnDisk(vault.app as never, book, store.settings, reading.reading)).toEqual([
      1, 4,
    ]);
  });

  it("answers an empty list rather than erroring when there is no folder", async () => {
    const { store, reading, book } = await shelf();
    const vault = fakeApp();
    expect(chaptersOnDisk(vault.app as never, book, store.settings, reading.reading)).toEqual([]);
  });

  it("only ever adds, and never contradicts a removal", () => {
    // Nothing to do is the common case, and it says so rather than churning.
    expect(reconciledChapters([{ number: 1 }], [1])).toBeNull();
    expect(reconciledChapters([{ number: 1 }], [])).toBeNull();

    // A chapter with no file yet is a perfectly good plan for a chapter.
    expect(reconciledChapters([{ number: 2, name: "Plans" }], [1])).toEqual([
      { number: 1 },
      { number: 2, name: "Plans" },
    ]);

    // …and one the reader forgot on purpose stays forgotten.
    expect(reconciledChapters([], [1, 2], [1])).toEqual([{ number: 2 }]);
    expect(reconciledChapters([], [1], [1])).toBeNull();
  });

  it("brings the chapters back on the next render — the incident, exactly", async () => {
    // The real shape: `studyChapters: []` on the book, while `Chapter 01.md`
    // and `Chapter 01 — diagram.excalidraw.md` sit in its folder.
    const { store, reading, book } = await shelf({
      filePath: BOOK_PDF,
      [STUDY_CHAPTERS_KEY]: [],
    });
    const vault = fakeApp();
    vault.folders.add("Reading/Dune");
    vault.files.set("Reading/Dune/Chapter 01.md", "the notes I actually wrote");
    vault.files.set("Reading/Dune/Chapter 01 — diagram.excalidraw.md", excalidrawSkeleton());

    expect(readChapters(book)).toEqual([]);

    const host = createHost(1200);
    const pane: BookDetailController = mountBookDetail(
      host as unknown as HTMLElement,
      { kind: "book", id: "b" },
      { app: vault.app as never, store: store as never, reading },
    );
    const el = host as unknown as StubEl;

    // Drawn on this very render, not on some later one.
    expect(el.querySelector(".wl-study")?.textContent).toContain("Chapter 1");
    expect(el.querySelector(".wl-study")?.textContent).not.toContain("No chapters yet");

    // And persisted, so the recovery survives a restart.
    await flush();
    expect(readChapters(book)).toEqual([{ number: 1 }]);

    // Both files are still recognised as this chapter's — nothing was rewritten.
    expect(vault.files.get("Reading/Dune/Chapter 01.md")).toBe("the notes I actually wrote");
    expect(vault.files.size).toBe(2);
    pane.destroy();
  });

  it("settles after one heal instead of writing on every repaint", async () => {
    const { store, reading, book } = await shelf({ [STUDY_CHAPTERS_KEY]: [] });
    const vault = fakeApp();
    vault.folders.add("Reading/Dune");
    vault.files.set("Reading/Dune/Chapter 01.md", "");

    const writes: string[] = [];
    const host = createHost(1200);
    const pane: BookDetailController = mountBookDetail(
      host as unknown as HTMLElement,
      { kind: "book", id: "b" },
      { app: vault.app as never, store: store as never, reading },
    );
    // Let the mount's own heal land first — it is the *repaints after* it that
    // must be silent.
    await flush();
    const update = reading.update.bind(reading);
    Object.assign(reading, {
      update: (kind: never, id: string, patch: never, reason?: string) => {
        writes.push(reason ?? "");
        return update(kind, id, patch, reason);
      },
    });

    (pane as unknown as { refresh(): void }).refresh();
    await flush();
    (pane as unknown as { refresh(): void }).refresh();
    await flush();

    expect(writes.filter((r) => r === "study-chapters-reconciled")).toEqual([]);
    expect(readChapters(book)).toEqual([{ number: 1 }]);
    pane.destroy();
  });

  it("does not resurrect a chapter the reader removed", async () => {
    const { store, reading, book } = await shelf({
      [STUDY_CHAPTERS_KEY]: [],
      [STUDY_FORGOTTEN_KEY]: [1],
    });
    const vault = fakeApp();
    vault.folders.add("Reading/Dune");
    vault.files.set("Reading/Dune/Chapter 01.md", "still on disk, as promised");

    const host = createHost(1200);
    const pane: BookDetailController = mountBookDetail(
      host as unknown as HTMLElement,
      { kind: "book", id: "b" },
      { app: vault.app as never, store: store as never, reading },
    );
    await flush();

    expect(readChapters(book)).toEqual([]);
    expect((host as unknown as StubEl).querySelector(".wl-study")?.textContent).toContain(
      "No chapters yet",
    );
    // The confirmation's promise, kept.
    expect(vault.files.get("Reading/Dune/Chapter 01.md")).toBe("still on disk, as promised");
    pane.destroy();
  });
});

// ---------------------------------------------------------------------------
// The live incident, encoded
// ---------------------------------------------------------------------------

describe("the book this went wrong on", () => {
  it("maps its real title to the folder its files are really in", async () => {
    // Taken off the running vault: `studyChapters` had been emptied while
    // `Chapter 01.md` and `Chapter 01 — diagram.excalidraw.md` sat in
    // `…/Reading/Getting Started with NSX-T - Logical Routing and Switching/`.
    // The colon in the title is the interesting part — the folder on disk has
    // a dash, and reconciliation only finds the files if this agrees.
    const { store, reading, book } = await shelf({
      title: "Getting Started with NSX-T : Logical Routing and Switching",
    });

    expect(studyFolderFor(book, store.settings, reading.reading)).toBe(
      "Reading/Getting Started with NSX-T - Logical Routing and Switching",
    );
    expect(chapterFileClaim("Chapter 01.md")).toEqual({ number: 1, kind: "note" });
    expect(chapterFileClaim("Chapter 01 — diagram.excalidraw.md")).toEqual({
      number: 1,
      kind: "diagram",
    });
  });
});

// ---------------------------------------------------------------------------
// The one-line table row, as a stylesheet rule
// ---------------------------------------------------------------------------

describe("the reading row's action line", () => {
  it("cannot wrap, however many actions it grows", () => {
    // The row is one line by hard-won design and a fourth button must not be
    // the thing that changes that. Asserted in the stylesheet because the DOM
    // harness has no layout engine and cannot measure a row's height.
    const root = dirname(dirname(fileURLToPath(import.meta.url)));
    const css = readFileSync(join(root, "styles/90-reading.css"), "utf8");

    const cell = /\.wl-reading-action-cell\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(cell).toMatch(/white-space:\s*nowrap/);

    const actions = /\.wl-reading-rowactions\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(actions).toMatch(/display:\s*inline-flex/);
    // No `flex-wrap: wrap` — the default is nowrap and it has to stay that way.
    expect(actions).not.toMatch(/flex-wrap:\s*wrap/);
  });
});

// ---------------------------------------------------------------------------
// A chapter is on disk if EITHER of its files is
// ---------------------------------------------------------------------------

describe("a chapter with only one of its two files", () => {
  it("counts as on-disk when only the drawing survives", async () => {
    // The reported asymmetry: delete the note by hand and the chapter must not
    // vanish while its drawing quietly orphans. `chaptersOnDisk` never looks at
    // `claim.kind` (study.ts:583-584), so either file proves the chapter.
    const { store, reading, book } = await shelf();
    const vault = fakeApp();
    vault.folders.add("Reading/Dune");
    vault.files.set("Reading/Dune/Chapter 03 — diagram.excalidraw.md", excalidrawSkeleton());

    expect(chaptersOnDisk(vault.app as never, book, store.settings, reading.reading)).toEqual([3]);
  });

  it("counts as on-disk when only the note survives", async () => {
    const { store, reading, book } = await shelf();
    const vault = fakeApp();
    vault.folders.add("Reading/Dune");
    vault.files.set("Reading/Dune/Chapter 03.md", "");

    expect(chaptersOnDisk(vault.app as never, book, store.settings, reading.reading)).toEqual([3]);
  });

  it("returns both of a chapter's files, whichever exist", async () => {
    const { store, reading, book } = await shelf();
    const vault = fakeApp();
    vault.folders.add("Reading/Dune");
    const note = "Reading/Dune/Chapter 03 — Arrakis.md";
    const drawing = "Reading/Dune/Chapter 03 — diagram.excalidraw.md";
    vault.files.set(note, "");
    vault.files.set(drawing, "");
    // A neighbour, and a file the reader renamed out of the convention.
    vault.files.set("Reading/Dune/Chapter 04.md", "");
    vault.files.set("Reading/Dune/Spice notes.md", "");

    const chapter = { number: 3, name: "Arrakis" };
    const files = chapterFilesFor(
      vault.app as never,
      book,
      chapter,
      store.settings,
      reading.reading,
    );
    expect(files.map((f) => f.path).sort()).toEqual([drawing, note].sort());

    // The naming a file has to earn to be in that set.
    expect(describeChapterFiles(files)).toBe("its note and its drawing");
  });

  it("finds a chapter file the reader renamed within the convention", async () => {
    const { store, reading, book } = await shelf();
    const vault = fakeApp();
    vault.folders.add("Reading/Dune");
    // Chapter renamed from "Arrakis" to "Spice" by hand — still Chapter 03.
    vault.files.set("Reading/Dune/Chapter 03 — Spice.md", "");

    const files = chapterFilesFor(
      vault.app as never,
      book,
      { number: 3, name: "Arrakis" },
      store.settings,
      reading.reading,
    );
    expect(files.map((f) => f.path)).toEqual(["Reading/Dune/Chapter 03 — Spice.md"]);
    expect(describeChapterFiles(files)).toBe("its note");
  });
});
