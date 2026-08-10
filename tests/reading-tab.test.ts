/**
 * The Reading tab, mounted.
 *
 * This is the integration half: the pure engines are pinned elsewhere, and what
 * matters here is that the tab actually wires them together — that the table
 * renders the v3 rows, that the toolbar narrows them, that the sub-tabs are two
 * independent libraries, and that tearing the tab down leaves nothing behind.
 *
 * The DOM is `tests/helpers/dom.ts`, not jsdom: the tabs mostly use Obsidian's
 * own `createDiv`/`addClass` extensions, and this harness has a controllable
 * geometry that jsdom cannot offer.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WatchLogStore } from "../src/data/store";
import { mountReadingTab } from "../src/domains/reading";
import { createReadingStore } from "../src/domains/reading/store";
import { createHost, installDomGlobals, type StubEl } from "./helpers/dom";
import type { TabController } from "../src/types";

const FIXTURE = join(
  dirname(dirname(fileURLToPath(import.meta.url))),
  "tests/fixtures/data-v3-parity.json",
);
const TEXT = readFileSync(FIXTURE, "utf8");

let restore: () => void;

beforeEach(() => {
  restore = installDomGlobals(1200);
});

afterEach(() => {
  restore();
});

async function mount() {
  const store = new WatchLogStore({
    loadData: async () => JSON.parse(TEXT) as unknown,
    saveData: async () => undefined,
  } as never);
  await store.load();
  const reading = createReadingStore(store);
  const host = createHost(1200);
  const controller = mountReadingTab(host as unknown as HTMLElement, {
    app: {} as never,
    store,
    reading,
  });
  return { host, store, reading, controller, el: controller.el as unknown as StubEl };
}

function rows(el: StubEl): StubEl[] {
  return el.querySelectorAll(".wl-reading-row");
}

function search(el: StubEl, value: string): void {
  const input = el.querySelectorAll(".wl-searchbox-input")[0];
  if (!input) throw new Error("no search box");
  input.value = value;
  input.fire("keydown", { key: "Enter", preventDefault: () => undefined });
}

describe("mounting", () => {
  it("renders both sub-tabs with their counts", async () => {
    const { el, controller } = await mount();
    const tabs = el.querySelectorAll(".wl-reading-subtab");
    expect(tabs).toHaveLength(2);
    expect(tabs[0]?.textContent).toContain("Books");
    expect(tabs[0]?.textContent).toContain("2");
    expect(tabs[1]?.textContent).toContain("Manga");
    expect(tabs[1]?.textContent).toContain("1");
    controller.destroy();
  });

  it("renders the v3 rows, cover and all", async () => {
    const { el, controller } = await mount();
    expect(rows(el)).toHaveLength(2);
    expect(el.textContent).toContain("Dune");
    expect(el.textContent).toContain("Frank Herbert");
    // The cover goes through the shared poster pipeline.
    expect(el.querySelectorAll(".wl-reading-thumb").length).toBe(2);
    controller.destroy();
  });

  it("shows the derived status rather than the stored one", async () => {
    const { el, reading, controller } = await mount();
    // Stored as `Reading`; a release date in the future outranks it.
    reading.updateBook("half-filled", { releaseDate: "2099-01-01" });
    controller.refresh();
    expect(el.textContent).toContain("To be released");
    controller.destroy();
  });

  it("counts what is shown against what exists", async () => {
    const { el, controller } = await mount();
    expect(el.querySelector(".wl-results-info")?.textContent).toBe("2 books");
    search(el, "dune");
    expect(el.querySelector(".wl-results-info")?.textContent).toBe("1 of 2 books");
    controller.destroy();
  });

  it("filters the table from the search box", async () => {
    const { el, controller } = await mount();
    search(el, "author:herbert");
    expect(rows(el)).toHaveLength(1);
    expect(el.textContent).toContain("Dune");
    controller.destroy();
  });

  it("offers a way out when nothing matches, rather than a bare 'no results'", async () => {
    const { el, controller } = await mount();
    search(el, "zzzznothing");
    expect(rows(el)).toHaveLength(0);
    expect(el.textContent).toContain("Nothing matches");
    expect(el.textContent).toContain("Clear search and filters");
    controller.destroy();
  });

  it("clears back to everything", async () => {
    const { el, controller } = await mount();
    search(el, "zzzznothing");
    const clear = el.querySelectorAll(".wl-empty-actions")[0]?.children[0];
    clear?.fire("click");
    expect(rows(el)).toHaveLength(2);
    controller.destroy();
  });
});

describe("the two shelves are two libraries", () => {
  it("switches to manga and shows manga rows", async () => {
    const { el, controller } = await mount();
    el.querySelectorAll(".wl-reading-subtab")[1]?.fire("click");
    expect(rows(el)).toHaveLength(1);
    expect(el.textContent).toContain("Berserk");
    expect(el.textContent).not.toContain("Dune");
    controller.destroy();
  });

  it("keeps each shelf's search to itself", async () => {
    const { el, store, controller } = await mount();
    search(el, "dune");
    el.querySelectorAll(".wl-reading-subtab")[1]?.fire("click");
    // The manga shelf is not filtered by the books shelf's query.
    expect(rows(el)).toHaveLength(1);
    // …and coming back restores it.
    el.querySelectorAll(".wl-reading-subtab")[0]?.fire("click");
    expect(rows(el)).toHaveLength(1);
    expect(el.textContent).toContain("Dune");
    // The view state rides along in the round-tripped reading settings.
    const settings = store.reading.settings as unknown as Record<string, unknown>;
    expect(settings["activeSubTab"]).toBe("book");
    controller.destroy();
  });

  it("renders the custom columns the shelf declares", async () => {
    const { el, controller } = await mount();
    const headers = el.querySelectorAll("th").map((cell) => cell.textContent);
    expect(headers).toContain("Genre");
    expect(el.textContent).toContain("Sci-Fi");

    // Manga has no columns in the fixture, so it gets no extra headers.
    el.querySelectorAll(".wl-reading-subtab")[1]?.fire("click");
    expect(el.querySelectorAll("th").map((cell) => cell.textContent)).not.toContain("Genre");
    controller.destroy();
  });
});

describe("the one-click action", () => {
  it("bumps the progress of the row it belongs to", async () => {
    const { el, reading, controller } = await mount();
    el.querySelectorAll(".wl-reading-subtab")[1]?.fire("click");
    const before = reading.getManga("berserk")?.chaptersRead;
    el.querySelectorAll(".wl-reading-bump")[0]?.fire("click", { stopPropagation: () => undefined });
    expect(reading.getManga("berserk")?.chaptersRead).toBe((before ?? 0) + 1);
    controller.destroy();
  });
});

describe("an empty shelf", () => {
  it("says what to do next instead of showing an empty table", async () => {
    const store = new WatchLogStore({
      loadData: async () => null,
      saveData: async () => undefined,
    } as never);
    await store.load();
    const host = createHost(1200);
    const controller: TabController = mountReadingTab(host as unknown as HTMLElement, {
      app: {} as never,
      store,
    });
    const el = controller.el as unknown as StubEl;
    expect(el.textContent).toContain("No books yet");
    expect(el.textContent).toContain("Open Library");
    expect(el.querySelectorAll(".wl-reading-row")).toHaveLength(0);
    controller.destroy();
  });
});

describe("teardown", () => {
  it("removes itself from the host", async () => {
    const { host, controller } = await mount();
    expect(host.children).toHaveLength(1);
    controller.destroy();
    expect(host.children).toHaveLength(0);
  });

  it("survives a refresh after the underlying data changed", async () => {
    const { el, reading, controller } = await mount();
    reading.deleteBook("dune");
    controller.refresh();
    expect(rows(el)).toHaveLength(1);
    expect(el.textContent).not.toContain("Frank Herbert");
    controller.destroy();
  });
});
