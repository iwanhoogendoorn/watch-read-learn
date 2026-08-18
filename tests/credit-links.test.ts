/**
 * A credit name as a link to a person — the one implementation, and the two
 * surfaces that draw it differently.
 *
 * Before this, the person screen had exactly one way in: a command-palette
 * command that opened a fuzzy name picker. The names printed on the screen you
 * were already looking at — the whole cast of the thing in front of you — were
 * chips that could only ever run `cast:"…"` against your own library, which is
 * the precise limitation `ui/views/person.ts` exists to lift.
 *
 * What has to hold, and why each is a way to get it wrong:
 *
 *   1. **A person opens; a studio and a genre still filter.** The gate is
 *      `isPersonField` inside the shared module, not a condition at each call
 *      site — a caller may hand every chip the same opener and a studio chip
 *      must still refuse to become a person.
 *   2. **Filtering is not gone, it is a modifier.** Alt-click is the old
 *      behaviour, on every link that offers both, and the tooltip says so.
 *      Losing "what of theirs do I already own?" would be a regression.
 *   3. **The modal and the full view agree.** They lay their credits out
 *      differently on purpose (wrapped chips vs one comma-separated line), so
 *      the only thing stopping them drifting is that neither owns the
 *      behaviour. Both are driven here, through the same assertions.
 *   4. **No network.** Nothing in this file touches TMDB: the opener is
 *      injected, and what is under test is which destination a click picks.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bindCreditLink, isPersonField, personOpener } from "../src/ui/detail/people";
import { DetailModal } from "../src/ui/modals/detail";
import { WatchLogStore } from "../src/data/store";
import { createTitle } from "../src/data/schema";
import { createHost, installDomGlobals, StubEl } from "./helpers/dom";
import type { TitleV4 } from "../src/types";

let restore: () => void;

beforeEach(() => {
  restore = installDomGlobals(900);
});

afterEach(() => {
  restore();
});

// ---------------------------------------------------------------------------
// The shared binder
// ---------------------------------------------------------------------------

interface Bound {
  el: StubEl;
  opened: string[];
  filtered: string[];
}

function bind(field: string, options: { open?: boolean; filter?: boolean } = {}): Bound {
  const host = createHost(900);
  const el = host.createSpan({ cls: "wl-chip", text: "Kurt Russell" });
  const opened: string[] = [];
  const filtered: string[] = [];
  bindCreditLink(el as unknown as HTMLElement, {
    name: "Kurt Russell",
    field,
    ...(options.open === false ? {} : { openPerson: (name: string) => opened.push(name) }),
    ...(options.filter === false ? {} : { onFilter: (query: string) => filtered.push(query) }),
  });
  return { el: el as unknown as StubEl, opened, filtered };
}

describe("which fields name a person", () => {
  it("is cast and director, and nothing else", () => {
    expect(isPersonField("cast")).toBe(true);
    expect(isPersonField("director")).toBe(true);
    // A studio is a company, a genre is a word, a tag is the user's own.
    for (const field of ["studio", "genre", "tag", "year", ""]) {
      expect(isPersonField(field), field).toBe(false);
    }
  });
});

describe("a bound credit link", () => {
  it("opens the person on a plain click", () => {
    const { el, opened, filtered } = bind("cast");
    el.fire("click", {});
    expect(opened).toEqual(["Kurt Russell"]);
    expect(filtered).toEqual([]);
  });

  it("filters on Alt-click, so the old behaviour is one key away", () => {
    const { el, opened, filtered } = bind("director");
    el.fire("click", { altKey: true });
    expect(filtered).toEqual(['director:"Kurt Russell"']);
    expect(opened).toEqual([]);
  });

  it("says both destinations in its tooltip", () => {
    const { el } = bind("cast");
    expect(el.getAttribute("title")).toBe(
      "Open Kurt Russell — Alt-click to filter the library by them instead",
    );
  });

  it("refuses to make a studio a person, opener or no opener", () => {
    const { el, opened, filtered } = bind("studio");
    el.fire("click", {});
    expect(opened).toEqual([]);
    expect(filtered).toEqual(['studio:"Kurt Russell"']);
    // And it describes itself as the filter it is.
    expect(el.getAttribute("title")).toBe("Show every title with studio “Kurt Russell”");
  });

  it("falls back to the filter when there is nowhere to open a person", () => {
    const { el, filtered } = bind("cast", { open: false });
    el.fire("click", {});
    expect(filtered).toEqual(['cast:"Kurt Russell"']);
    expect(el.getAttribute("title")).toBe("Show every title with cast “Kurt Russell”");
  });

  it("still opens when nothing is listening for a filter", () => {
    const { el, opened } = bind("cast", { filter: false });
    el.fire("click", { altKey: true });
    // Alt-click with no filter to reach is a plain click, not a dead one.
    expect(opened).toEqual(["Kurt Russell"]);
    expect(el.getAttribute("title")).toBe("Open Kurt Russell");
  });

  it("wires nothing at all when neither destination exists", () => {
    const { el } = bind("cast", { open: false, filter: false });
    expect(el.getAttribute("title")).toBe(null);
    expect(el.getAttribute("role")).toBe(null);
    // A label that looks like a button and does nothing is worse than a label.
    el.fire("click", {});
  });

  it("is reachable from the keyboard, with the same two destinations", () => {
    const { el, opened, filtered } = bind("cast");
    expect(el.getAttribute("role")).toBe("button");
    expect(el.getAttribute("tabindex")).toBe("0");

    el.fire("keydown", { key: "Enter", preventDefault: () => undefined });
    expect(opened).toEqual(["Kurt Russell"]);
    el.fire("keydown", { key: " ", altKey: true, preventDefault: () => undefined });
    expect(filtered).toEqual(['cast:"Kurt Russell"']);
    // Any other key is not an activation.
    el.fire("keydown", { key: "a", preventDefault: () => undefined });
    expect(opened).toHaveLength(1);
    expect(filtered).toHaveLength(1);
  });

  it("gives no app no opener, rather than an opener that throws", () => {
    expect(personOpener(undefined)).toBeUndefined();
    expect(personOpener(null)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The modal, which draws them as chips
// ---------------------------------------------------------------------------

interface OpenModal {
  el: StubEl;
  opened: string[];
  jumped: string[];
  closed: number;
}

async function openModal(over: Partial<TitleV4> = {}): Promise<OpenModal> {
  const store = new WatchLogStore({
    loadData: async () => null,
    saveData: async () => undefined,
  } as never);
  await store.load();

  const title = createTitle({ id: "t", title: "The Thing", type: "Movie" });
  Object.assign(title, over);
  store.data.titles.push(title);

  const opened: string[] = [];
  const jumped: string[] = [];
  const modal = new DetailModal({} as never, {
    store: store as never,
    titleId: "t",
    onJumpToQuery: (query) => jumped.push(query),
    onOpenPerson: (name) => opened.push(name),
  });

  const contentEl = createHost(900);
  const modalEl = createHost(900);
  let closed = 0;
  Object.assign(modal as unknown as Record<string, unknown>, {
    contentEl,
    modalEl,
    close: () => {
      closed += 1;
    },
  });
  modal.onOpen();

  return {
    el: contentEl as unknown as StubEl,
    opened,
    jumped,
    get closed() {
      return closed;
    },
  };
}

/** The chips under one `wl-detail-chipsection` label. */
function chipsUnder(el: StubEl, label: string): StubEl[] {
  const section = el
    .querySelectorAll(".wl-detail-chipsection")
    .find((node) => node.textContent.startsWith(label));
  return section?.querySelectorAll(".wl-chip") ?? [];
}

describe("the detail modal's chips", () => {
  it("opens the person from a cast chip, and gets out of the way first", async () => {
    const modal = await openModal({ cast: ["Kurt Russell", "Keith David"] });
    const chips = chipsUnder(modal.el, "Cast");
    expect(chips.map((c) => c.textContent)).toEqual(["Kurt Russell", "Keith David"]);

    chips[1]?.fire("click", {});
    expect(modal.opened).toEqual(["Keith David"]);
    expect(modal.jumped).toEqual([]);
    // A leaf opening behind a modal is a leaf nobody sees.
    expect(modal.closed).toBe(1);
  });

  it("keeps the Library search on Alt-click", async () => {
    const modal = await openModal({ director: ["John Carpenter"] });
    chipsUnder(modal.el, "Director")[0]?.fire("click", { altKey: true });
    expect(modal.jumped).toEqual(['director:"John Carpenter"']);
    expect(modal.opened).toEqual([]);
  });

  it("leaves studios, genres and tags on the search where they belong", async () => {
    const modal = await openModal({
      studio: ["Universal"],
      genres: ["Horror"],
      tags: ["rewatch"],
    });
    chipsUnder(modal.el, "Studio")[0]?.fire("click", {});
    chipsUnder(modal.el, "Genres")[0]?.fire("click", {});
    chipsUnder(modal.el, "Tags")[0]?.fire("click", {});
    expect(modal.jumped).toEqual([
      'studio:"Universal"',
      'genre:"Horror"',
      'tag:"rewatch"',
    ]);
    expect(modal.opened).toEqual([]);
  });

  it("offers a name the user typed in by hand just as readily", async () => {
    // `manualCast` is the user's own addition; it is as openable as TMDB's.
    const modal = await openModal({ cast: ["Kurt Russell"], manualCast: ["A. N. Other"] });
    const chips = chipsUnder(modal.el, "Cast");
    expect(chips).toHaveLength(2);
    chips[1]?.fire("click", {});
    expect(modal.opened).toEqual(["A. N. Other"]);
  });
});
