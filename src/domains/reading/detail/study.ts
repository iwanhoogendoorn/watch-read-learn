/**
 * The Study section — the chapter index, on the book's screen.
 *
 * A section, like every other one in this folder: it takes a `ReadingSurface`
 * and knows nothing about whether it was mounted in the modal or in the
 * workspace view. One implementation, both surfaces, for the reason the header
 * of `sections.ts` gives at length — two copies of a control are two places for
 * a write to go missing.
 *
 * It decides *nothing* about chapters. Every rule lives in `../study.ts`: what a
 * chapter is, where its files go, what a new note says, what happens when
 * Excalidraw is missing. This module is the buttons and the words on them.
 *
 * The five verbs a chapter row offers, and why each is there:
 *
 *   - **Note** and **Diagram** — open the chapter's material, creating it the
 *     first time. The button says which one already exists, because "new or
 *     existing" was the actual ask and a row of identical buttons answers it
 *     for neither.
 *   - **Read** — the book in one pane, the chapter note in a split beside it.
 *     The one that made this feature worth building.
 *   - **Page** — the page on screen, embedded into the chapter note as a live
 *     `![[file#page=N]]` reference. Better than a screenshot in the only way
 *     that matters: it cannot go stale, and it links back.
 *   - **Rename** and **Remove** — the index is editable. Removing forgets a
 *     chapter; it does not delete a file, and the confirmation says so, because
 *     a dialog that does not name the consequence is a dialog nobody reads.
 *
 * A book with no linked file keeps its notes. Only Read and Page depend on the
 * file, and both explain themselves rather than disappearing — a control that
 * vanishes teaches nobody why.
 */
import { Notice, setIcon, type App } from "obsidian";
import { confirmAction, type ConfirmOptions } from "../../../ui/modals/confirm";
import type { ReadingEntry } from "../progress";
import {
  chapterFilesFor,
  chapterHasMaterial,
  chapterLabel,
  describeChapterFiles,
  insertCurrentPage,
  trashChapterFiles,
  nextChapterNumber,
  openChapterMaterial,
  adoptChapterPatch,
  chaptersOnDisk,
  chaptersPatch,
  ensureChapterMaterial,
  forgetChapterPatch,
  openFileInPopout,
  openReadMenu,
  popoutRequested,
  readChapters,
  readForgottenChapters,
  reconciledChapters,
  renamedChapter,
  studyFolderFor,
  withChapter,
  withoutChapter,
  readRequestFor,
  runReadRequest,
  POPOUT_HINT,
  READ_BUTTONS,
  READ_HINT,
  type ChapterMaterial,
  type StudyChapter,
  type StudyContext,
} from "../study";
import type { ReadingSurface } from "./surface";

/** The context every action in this section is run against. */
function contextOf(surface: ReadingSurface, entry: ReadingEntry, app: App): StudyContext {
  return {
    app,
    entry,
    settings: surface.watch.settings,
    reading: surface.reading.reading,
  };
}

/**
 * The whole section. Returns the element so a surface can place it, and returns
 * it even when the book has no chapters yet — the empty state is the invitation.
 */
export function renderStudySection(
  host: HTMLElement,
  entry: ReadingEntry,
  surface: ReadingSurface,
  app: App,
): HTMLElement {
  const section = host.createDiv({ cls: "wl-study" });
  const head = section.createDiv({ cls: "wl-study-head" });
  head.createDiv({ cls: "wl-field-label", text: "Study" });

  const context = contextOf(surface, entry, app);
  const chapters = healIndex(entry, surface, context);
  const linked = (entry.filePath ?? "").trim() !== "";

  const list = section.createDiv({ cls: "wl-study-list" });
  if (chapters.length === 0) {
    list.createDiv({
      cls: "wl-study-empty",
      text: "No chapters yet. Add one to keep a note — or a drawing — per chapter.",
    });
  }
  for (const chapter of chapters) {
    renderChapterRow(list, chapter, entry, surface, context, linked);
  }

  renderAddRow(section, entry, surface, chapters);

  const folder = studyFolderFor(entry, context.settings, context.reading);
  section.createDiv({
    cls: "wl-study-hint",
    text: linked
      ? `Chapter notes and drawings live in ${folder}. Removing a chapter forgets it here and leaves its files alone.`
      : `Chapter notes live in ${folder}. Link the book's file above to read it side by side and to embed the page you are on.`,
  });
  // The modifiers are worth a line of their own; a tooltip is only found by
  // someone who already suspects there is something to find.
  if (linked && chapters.length > 0) {
    section.createDiv({ cls: "wl-study-hint", text: `Read: ${READ_HINT}` });
  }

  return section;
}

/**
 * The chapter list, with anything the folder can prove folded back in.
 *
 * A real book's index was found empty while `Chapter 01.md` and its drawing
 * were still sitting in the folder. Rather than hunt the write that did it, the
 * list now defers to the disk: whatever emptied it, the next time this section
 * paints, the chapters are back.
 *
 * Two things make that safe to do on every render:
 *
 *   - it only ever **adds**, and never touches a chapter the reader explicitly
 *     forgot (`readForgottenChapters`), so Remove still means Remove;
 *   - the write is **deferred out of the paint**. `surface.patch` repaints, and
 *     repainting from inside a render would empty the host mid-build. A
 *     microtask later the store has it, the section repaints once, and that
 *     second pass finds nothing new — so this settles rather than loops.
 *
 * The returned list is what this render draws, so the rows appear immediately
 * rather than on the repaint.
 */
function healIndex(
  entry: ReadingEntry,
  surface: ReadingSurface,
  context: StudyContext,
): StudyChapter[] {
  const indexed = readChapters(entry);
  const healed = reconciledChapters(
    indexed,
    chaptersOnDisk(context.app, entry, context.settings, context.reading),
    readForgottenChapters(entry),
  );
  if (!healed) return indexed;

  const found = healed.length - indexed.length;
  queueMicrotask(() => {
    surface.patch(chaptersPatch(healed), "study-chapters-reconciled");
  });
  new Notice(
    found === 1
      ? "Found a chapter file on disk — added it back to the chapter list."
      : `Found ${found} chapter files on disk — added them back to the chapter list.`,
  );
  return healed;
}

// ---------------------------------------------------------------------------
// One chapter
// ---------------------------------------------------------------------------

function renderChapterRow(
  host: HTMLElement,
  chapter: StudyChapter,
  entry: ReadingEntry,
  surface: ReadingSurface,
  context: StudyContext,
  linked: boolean,
): void {
  const row = host.createDiv({ cls: "wl-study-row" });
  row.setAttribute("data-chapter", String(chapter.number));

  const name = row.createSpan({ cls: "wl-study-name", text: chapterLabel(chapter) });

  const actions = row.createDiv({ cls: "wl-study-actions" });

  materialButton(actions, chapter, entry, surface, context, "note");
  materialButton(actions, chapter, entry, surface, context, "diagram");

  // One visible button per way of reading. They were modifiers on a single
  // button and that was the wrong call: "I also asked you to create a separate
  // button for the side by side with the pdf and diagram." A modifier is an
  // accelerator for a feature you already know about, never a way to find one.
  // Both survive — the buttons are how you learn, the modifiers are how you go
  // fast, and the right-click menu names all six including the window ones.
  for (const option of READ_BUTTONS) {
    const button = action(
      actions,
      option.icon,
      option.title,
      linked ? `${option.hint} — ${POPOUT_HINT}` : "No file is linked to this book yet",
      (event) => {
        // The button decides the layout; a modifier can still override it, so a
        // Shift-click on "Read & draw" is the same "both" it is anywhere else.
        const request = readRequestFor(event);
        const layout = event.altKey === true || event.shiftKey === true ? request.layout : option.layout;
        void runReadRequest(context, chapter, { layout, popout: request.popout });
      },
    );
    button.addClass("wl-study-read");
    if (!linked) button.addClass("is-unavailable");
    button.addEventListener("contextmenu", (event: MouseEvent) => {
      openReadMenu(event, (request) => {
        void runReadRequest(context, chapter, request);
      });
    });
  }

  const page = action(
    actions,
    "image-plus",
    "Insert page",
    linked
      ? "Embed the page you are reading into this chapter's note"
      : "No file is linked to this book yet",
    () => {
      void insertCurrentPage(context, chapter).then((outcome) => {
        new Notice(outcome.message);
        if (outcome.ok) surface.refresh();
      });
    },
  );
  if (!linked) page.addClass("is-unavailable");

  action(actions, "pencil", "Rename", "Rename this chapter", () =>
    renameInline(row, name, chapter, entry, surface),
  );

  action(actions, "x", "Remove", "Forget this chapter (its files stay)", () => {
    void removeChapter(chapter, entry, surface, context);
  });
}

/**
 * Note or Diagram.
 *
 * The `is-present` class is the answer to "new or existing": a chapter that
 * already has a drawing says so before you click, and a chapter that does not
 * is offering to make one.
 */
function materialButton(
  host: HTMLElement,
  chapter: StudyChapter,
  entry: ReadingEntry,
  surface: ReadingSurface,
  context: StudyContext,
  kind: ChapterMaterial,
): void {
  const exists = chapterHasMaterial(
    context.app,
    entry,
    chapter,
    kind,
    context.settings,
    context.reading,
  );
  const noun = kind === "diagram" ? "diagram" : "note";
  const verb = exists ? "Open" : "Create";
  const button = action(
    host,
    kind === "diagram" ? "shapes" : "file-text",
    kind === "diagram" ? "Diagram" : "Note",
    `${verb} this chapter's ${noun} — ${POPOUT_HINT}`,
    (event) => {
      // Cmd-click sends it to a window of its own, exactly as it does on Read.
      // One modifier, one meaning, wherever it is pressed.
      const open = popoutRequested(event)
        ? ensureChapterMaterial(context, chapter, kind).then(async (file) => {
            if (file) await openFileInPopout(context.app, file);
            return file;
          })
        : openChapterMaterial(context, chapter, kind, "tab");
      void open.then((file) => {
        if (file) surface.refresh();
      });
    },
  );
  button.addClass(kind === "diagram" ? "wl-study-diagram" : "wl-study-note");
  if (exists) button.addClass("is-present");
}

/**
 * Rename in place — the label becomes an input, commits on Enter and on blur.
 *
 * Never per keystroke: both surfaces repaint on every write, and a commit per
 * character rebuilds the field under the caret. Escape backs out by repainting,
 * which is the same thing every other inline editor here does.
 */
function renameInline(
  row: HTMLElement,
  label: HTMLElement,
  chapter: StudyChapter,
  entry: ReadingEntry,
  surface: ReadingSurface,
): void {
  label.addClass("is-hidden");
  const input = row.createEl("input", {
    cls: "wl-input wl-study-rename",
    attr: { type: "text", placeholder: "Chapter name", "aria-label": "Chapter name" },
  });
  input.value = chapter.name ?? "";
  input.focus?.();

  let done = false;
  const commit = (): void => {
    if (done) return;
    done = true;
    const next = renamedChapter(readChapters(entry), chapter.number, input.value);
    surface.patch(chaptersPatch(next), "study-chapter-renamed");
  };
  input.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.key === "Enter") commit();
    if (event.key === "Escape") {
      done = true;
      surface.refresh();
    }
  });
  input.addEventListener("blur", commit);
}

/**
 * Remove a chapter — and, by default, its files.
 *
 * THE CORRECTION THIS ENCODES
 * ---------------------------
 * "When I do remove the chapter, it only removes the chapter markdown and does
 * not remove the diagram. Fix this." Removal used to be an index edit that left
 * every file alone, on the principle that the notes are the reader's and not
 * ours to delete. The reader has said plainly that removal means *removal* — so
 * it does, with two guardrails that make that safe:
 *
 *   - **the trash, never a hard delete.** `trashChapterFiles` goes through
 *     `fileManager.trashFile`, which obeys the reader's own "Deleted files"
 *     setting. A mis-click is undone in Finder, not from a backup.
 *   - **one checkbox, ticked, that turns it back into the old behaviour.** The
 *     default is what was asked for; unticking gets the index-only removal, and
 *     the dialog says so in as many words.
 *
 * **Both files or neither.** The note and the drawing are one thing to the
 * person who made them, and `chapterFilesFor` returns the whole set — so the
 * asymmetry that was reported cannot be reintroduced by a caller passing one
 * kind. Whichever exists goes; a missing one is silence, not an error.
 *
 * The index write stays `forgetChapterPatch` either way, so the self-healing
 * disk scan cannot resurrect the chapter on the very next repaint — which
 * matters most on the *unticked* path, where the files are still sitting there.
 */
export async function removeChapter(
  chapter: StudyChapter,
  entry: ReadingEntry,
  surface: ReadingSurface,
  context: StudyContext,
): Promise<void> {
  const folder = studyFolderFor(entry, context.settings, context.reading);
  const files = chapterFilesFor(context.app, entry, chapter, context.settings, context.reading);
  const what = describeChapterFiles(files);
  const label = chapterLabel(chapter);

  const options: ConfirmOptions = {
    title: `Remove ${label}?`,
    message:
      files.length === 0
        ? `Forgets ${label} here. There are no files for it in ${folder}.`
        // "its note and its drawing go" / "its drawing goes" — the verb follows
        // how many *kinds* were found, not how many files.
        : `${label}, ${what} ${what.includes(" and ") ? "go" : "goes"} to the trash.`,
    details:
      files.length === 0
        ? ["Nothing on disk to move."]
        : [
            `Untick the box to keep ${what} in ${folder} and only forget the chapter here.`,
            'Trashed files go wherever your "Deleted files" setting sends them, so this is undoable.',
          ],
    confirmText: "Remove",
    danger: true,
  };
  // Ticked by default: deletion is what removal was said to mean. The box is
  // the way back to the old behaviour, not the way to the new one.
  if (files.length > 0) {
    options.checkbox = { label: `Also move ${what} to the trash.`, default: true };
  }

  const result = await confirmAction(context.app, options);
  if (!result.confirmed) return;

  surface.patch(forgetChapterPatch(entry, chapter.number), "study-chapter-removed");
  if (files.length === 0 || !result.checked) return;

  const outcome = await trashChapterFiles(
    context.app,
    entry,
    chapter,
    context.settings,
    context.reading,
  );
  if (outcome.failed.length > 0) {
    new Notice(
      `${label} removed, but ${outcome.failed.length} file(s) could not be trashed: ${outcome.failed.join(", ")}`,
    );
  } else if (outcome.trashed.length > 0) {
    new Notice(
      outcome.trashed.length === 1
        ? `${label} removed — 1 file moved to the trash.`
        : `${label} removed — ${outcome.trashed.length} files moved to the trash.`,
    );
  }
  surface.refresh();
}

// ---------------------------------------------------------------------------
// Adding one
// ---------------------------------------------------------------------------

/**
 * "Add chapter" — the next number, with an optional name typed beside it.
 *
 * The number is proposed rather than asked for, because a chapter list is
 * almost always built in order, and typing "4" into a box to get chapter 4 is
 * work the screen can do.
 */
function renderAddRow(
  host: HTMLElement,
  entry: ReadingEntry,
  surface: ReadingSurface,
  chapters: readonly StudyChapter[],
): void {
  const row = host.createDiv({ cls: "wl-study-add" });
  const next = nextChapterNumber(chapters);

  const input = row.createEl("input", {
    cls: "wl-input wl-study-newname",
    attr: {
      type: "text",
      placeholder: `Chapter ${next} name (optional)`,
      "aria-label": `Name for chapter ${next}`,
    },
  });

  const add = (): void => {
    surface.patch(adoptChapterPatch(entry, next, input.value), "study-chapter-added");
  };

  input.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.key === "Enter") add();
  });

  const button = row.createEl("button", {
    cls: "wl-btn wl-study-addbtn",
    attr: { type: "button", title: `Add chapter ${next} to this book` },
  });
  const icon = button.createSpan({ cls: "wl-btn-icon" });
  setIcon(icon, "plus");
  button.createSpan({ cls: "wl-btn-label", text: `Add chapter ${next}` });
  button.addEventListener("click", add);
}

// ---------------------------------------------------------------------------

/** One icon button, labelled for screen readers and titled for everyone else. */
function action(
  host: HTMLElement,
  icon: string,
  label: string,
  title: string,
  onClick: (event: MouseEvent) => void,
): HTMLElement {
  const button = host.createEl("button", {
    cls: "wl-btn wl-icon-btn wl-study-btn",
    attr: { type: "button", "aria-label": label, title },
  });
  setIcon(button, icon);
  button.addEventListener("click", onClick);
  return button;
}
