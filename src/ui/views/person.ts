/**
 * The person screen — an actor, director or writer as a place rather than a filter.
 *
 * Clicking "Christopher Nolan" in the Dashboard's Top directors used to run a
 * `director:"Christopher Nolan"` search, which can only ever show you what you
 * already own. This shows the person: who they are, and **everything else they
 * made**, with the things you do not have carrying a `+ Add` button. That is the
 * loop the plugin was missing — see who you watch most, open them, add the rest.
 *
 * Three rules it holds to:
 *
 *   - **Cached opens are offline.** A person opened once renders from
 *     `data.json` with no request at all (`services/tmdb-person.ts` owns the
 *     cache). A stale entry still paints immediately and refreshes behind the
 *     screen; the network is never between the user and the page.
 *   - **Owned is owned.** A credit already in the library is drawn as such and
 *     opens its detail modal. It is never offered back as "+ Add" — the same
 *     rule the suggestion engine holds ("nothing already in your library is ever
 *     suggested back").
 *   - **Adding goes through the one add path.** `+ Add` hands an
 *     `OverseerrSearchResult` to the caller's add closure, which is the very
 *     same one the suggestion wizard uses (`buildTitleForHit` in
 *     `ui/modals/add.ts`). There is no second way to create a title here.
 *
 * The renderer (`mountPersonScreen`) is a plain DOM function so it can be
 * mounted headlessly in tests; `PersonView` is the Obsidian shell around it and
 * holds no rendering logic of its own.
 */
import {
  ItemView,
  Notice,
  setIcon,
  type App,
  type ViewStateResult,
  type WorkspaceLeaf,
} from "obsidian";
import type { MountHandle, TitleV4 } from "../../types";
import {
  ageFacts,
  birthdayLabel,
  groupFilmography,
  ownedTitleFor,
  type PersonCacheEntry,
  type PersonCandidate,
  type PersonCredit,
  type PersonService,
} from "../../services/tmdb-person";
import { relativeTime } from "../components/pills";
import { renderPosterPlaceholder } from "../components/posters";

export const VIEW_TYPE_PERSON = "watchlog-person-view";
export const PERSON_VIEW_ICON = "user-round";
export const PERSON_VIEW_DISPLAY_NAME = "Person";

/**
 * Who to open.
 *
 * A `personId` is an identity and needs no resolving. A bare `name` is what the
 * rest of the plugin has — every credit it stores is a string — and has to be
 * turned into one, which is where the ambiguous case lives.
 */
export interface PersonTarget {
  personId?: number;
  name?: string;
}

export interface PersonScreenDeps {
  people: PersonService;
  /** Library titles, for the owned/not-owned decision. Read fresh every render. */
  titles(): readonly TitleV4[];
  /** Open a title already in the library. */
  onOpenTitle(title: TitleV4): void;
  /** The plugin's one add path. Resolves to the created title, or undefined. */
  onAdd(result: PersonCredit["result"]): Promise<TitleV4 | undefined>;
  /** Jump to the Library filtered by this person, for "show only what I own". */
  onJumpToQuery?(query: string): void;
  /** Open an external URL (TMDB / IMDb). Omit to hide those links. */
  onOpenUrl?(url: string): void;
  /** Notify. Defaults to Obsidian's `Notice`; overridden in tests. */
  notify?(message: string): void;
}

export interface PersonScreenHandle extends MountHandle {
  /** Point the screen at someone. Safe to call repeatedly. */
  open(target: PersonTarget): void;
  /** Re-fetch from TMDB and repaint. */
  refresh(): void;
}

/** What the screen is currently able to show. */
type ScreenState =
  | { kind: "empty" }
  | { kind: "loading"; label: string }
  | { kind: "unconfigured" }
  | { kind: "unknown"; name: string }
  | { kind: "ambiguous"; name: string; candidates: PersonCandidate[] }
  | { kind: "error"; message: string }
  | { kind: "person"; entry: PersonCacheEntry; name: string };

export function mountPersonScreen(
  host: HTMLElement,
  deps: PersonScreenDeps,
  today: () => string = () => new Date().toISOString().slice(0, 10),
): PersonScreenHandle {
  host.addClass("wl-person");
  let state: ScreenState = { kind: "empty" };
  let target: PersonTarget = {};
  /** Bumped on every `open`; a slow answer for a person we left is dropped. */
  let generation = 0;
  let destroyed = false;

  function set(next: ScreenState, forGeneration: number): void {
    if (destroyed || forGeneration !== generation) return;
    state = next;
    render();
  }

  function open(next: PersonTarget): void {
    target = next;
    generation += 1;
    const mine = generation;

    if (!deps.people.configured()) {
      set({ kind: "unconfigured" }, mine);
      return;
    }
    if (next.personId !== undefined) {
      show(next.personId, next.name ?? "", mine);
      return;
    }
    const name = (next.name ?? "").trim();
    if (name === "") {
      set({ kind: "empty" }, mine);
      return;
    }

    // The synchronous path first, and only then the network. This is what makes
    // a second visit free: a name already resolved and a person already cached
    // render without a single request.
    const known = deps.people.cachedResolution(name);
    if (known?.state === "resolved") {
      show(known.personId, known.name, mine);
      return;
    }
    if (known?.state === "ambiguous") {
      set({ kind: "ambiguous", name, candidates: known.candidates }, mine);
      return;
    }

    set({ kind: "loading", label: `Looking up ${name}…` }, mine);
    void deps.people
      .resolve(name)
      .then((outcome) => {
        if (outcome.state === "resolved") show(outcome.personId, outcome.name, mine);
        else if (outcome.state === "ambiguous") set({ kind: "ambiguous", ...outcome }, mine);
        else set({ kind: "unknown", name }, mine);
      })
      .catch((err: unknown) => set({ kind: "error", message: messageOf(err) }, mine));
  }

  /** Paint from cache if we can, fetch only when we cannot. */
  function show(personId: number, name: string, mine: number): void {
    const entry = deps.people.cached(personId);
    if (entry) {
      set({ kind: "person", entry, name: entry.person.name || name }, mine);
      // Stale is still worth showing; the top-up happens behind the finished
      // page rather than in front of a spinner.
      if (deps.people.isStale(entry)) void reload(personId, name, mine, false);
      return;
    }
    set({ kind: "loading", label: name === "" ? "Loading…" : `Loading ${name}…` }, mine);
    void reload(personId, name, mine, true);
  }

  async function reload(
    personId: number,
    name: string,
    mine: number,
    reportFailure: boolean,
  ): Promise<void> {
    try {
      const entry = await deps.people.load(personId, { force: !reportFailure });
      set({ kind: "person", entry, name: entry.person.name || name }, mine);
    } catch (err) {
      if (reportFailure) set({ kind: "error", message: messageOf(err) }, mine);
    }
  }

  function refresh(): void {
    if (state.kind !== "person") {
      open(target);
      return;
    }
    const personId = state.entry.person.id;
    const name = state.name;
    generation += 1;
    const mine = generation;
    set({ kind: "loading", label: `Refreshing ${name}…` }, mine);
    void deps.people
      .load(personId, { force: true })
      .then((entry) => set({ kind: "person", entry, name: entry.person.name || name }, mine))
      .catch((err: unknown) => set({ kind: "error", message: messageOf(err) }, mine));
  }

  function render(): void {
    host.empty();
    // Snapshot: `state` is a mutable binding, so a narrowing does not survive
    // into the callbacks the picker installs.
    const current = state;
    switch (current.kind) {
      case "empty":
        renderMessage(host, "Nobody selected", "Open a cast or crew name to see who they are.");
        return;
      case "unconfigured":
        renderMessage(
          host,
          "TMDB is not configured",
          "Person pages come from TMDB. Add a TMDB read access token in the plugin settings.",
        );
        return;
      case "loading":
        renderMessage(host, current.label, "");
        return;
      case "unknown":
        renderMessage(
          host,
          `Nothing on TMDB for “${current.name}”`,
          "The name may be spelled differently upstream, or this credit may have been typed in by hand.",
        );
        return;
      case "error":
        renderMessage(host, "Could not load this person", current.message);
        return;
      case "ambiguous":
        renderPicker(host, current.name, current.candidates, (candidate) => {
          deps.people.rememberChoice(current.name, candidate.id);
          open({ personId: candidate.id, name: candidate.name });
        });
        return;
      default:
        renderPerson(host, current.entry, deps, today(), refresh);
    }
  }

  render();

  return {
    el: host,
    open,
    refresh,
    destroy() {
      destroyed = true;
      generation += 1;
      host.empty();
      host.removeClass("wl-person");
    },
  };
}

function messageOf(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return "TMDB did not answer.";
}

// ---------------------------------------------------------------------------
// States that are not a person
// ---------------------------------------------------------------------------

function renderMessage(host: HTMLElement, headline: string, detail: string): void {
  const box = host.createDiv({ cls: "wl-person-message" });
  box.createDiv({ cls: "wl-person-message-title", text: headline });
  if (detail) box.createDiv({ cls: "wl-person-message-body", text: detail });
}

/**
 * Two people, one name.
 *
 * Picking for the user is the one thing this screen must not do: the whole
 * filmography would be wrong and nothing on the page would say so. So it asks,
 * and remembers the answer.
 */
function renderPicker(
  host: HTMLElement,
  name: string,
  candidates: readonly PersonCandidate[],
  onPick: (candidate: PersonCandidate) => void,
): void {
  const box = host.createDiv({ cls: "wl-person-message" });
  box.createDiv({ cls: "wl-person-message-title", text: `More than one “${name}”` });
  box.createDiv({
    cls: "wl-person-message-body",
    text: "TMDB knows several people by this name. Which one did you mean?",
  });

  const list = host.createDiv({ cls: "wl-person-choices" });
  for (const candidate of candidates) {
    const row = list.createEl("button", {
      cls: "wl-person-choice",
      attr: { type: "button" },
    });
    const photo = row.createDiv({ cls: "wl-thumb wl-person-choice-photo" });
    photo.dataset.posterSeed = candidate.name;
    if (candidate.profileUrl) {
      const img = photo.createEl("img", { cls: "wl-thumb-img" });
      img.setAttribute("alt", "");
      img.setAttribute("loading", "lazy");
      img.src = candidate.profileUrl;
    } else {
      renderPosterPlaceholder(photo, candidate.name);
    }

    const body = row.createDiv({ cls: "wl-person-choice-body" });
    body.createDiv({ cls: "wl-person-choice-name", text: candidate.name });
    const known = candidate.knownFor.slice(0, 3).join(", ");
    body.createDiv({
      cls: "wl-person-choice-meta",
      text: known || candidate.knownForDepartment || "No other credits listed",
    });
    row.addEventListener("click", () => onPick(candidate));
  }
}

// ---------------------------------------------------------------------------
// The person
// ---------------------------------------------------------------------------

function renderPerson(
  host: HTMLElement,
  entry: PersonCacheEntry,
  deps: PersonScreenDeps,
  today: string,
  onRefresh: () => void,
): void {
  const { person } = entry;

  const head = host.createDiv({ cls: "wl-person-head" });
  const photo = head.createDiv({ cls: "wl-thumb wl-person-photo" });
  photo.dataset.posterSeed = person.name;
  if (person.profileUrl) {
    const img = photo.createEl("img", { cls: "wl-thumb-img" });
    img.setAttribute("alt", "");
    img.setAttribute("loading", "lazy");
    img.src = person.profileUrl;
  } else {
    renderPosterPlaceholder(photo, person.name);
  }

  const heading = head.createDiv({ cls: "wl-person-heading" });
  heading.createEl("h2", { cls: "wl-person-name", text: person.name });
  if (person.knownForDepartment) {
    heading.createDiv({ cls: "wl-person-known", text: `Known for ${person.knownForDepartment}` });
  }

  // When this page was last told anything by TMDB. Without it the Refresh
  // button is an offer with no reason attached: the whole point of the cache is
  // that an opened person may have been fetched months ago, and only this line
  // says which of those you are looking at.
  const sync = heading.createDiv({ cls: "wl-person-syncrow" });
  const when = relativeTime(entry.fetchedAt, new Date(`${today}T12:00:00`));
  sync.createSpan({
    cls: "wl-person-synclabel",
    text: when === "" ? "Never updated" : `Updated ${when}`,
  });

  const actions = heading.createDiv({ cls: "wl-person-actions" });
  const refresh = actions.createEl("button", {
    cls: "wl-btn",
    text: "Refresh",
    attr: { type: "button", title: "Re-fetch this person from TMDB" },
  });
  refresh.addEventListener("click", () => onRefresh());

  if (deps.onJumpToQuery) {
    const owned = actions.createEl("button", {
      cls: "wl-btn",
      text: "In my library",
      attr: { type: "button", title: "Filter the Library by this name" },
    });
    owned.addEventListener("click", () => deps.onJumpToQuery?.(`cast:"${person.name}"`));
  }
  if (deps.onOpenUrl && person.imdbId) {
    const imdb = actions.createEl("button", {
      cls: "wl-btn",
      text: "IMDb",
      attr: { type: "button", title: "Open this person on IMDb" },
    });
    imdb.addEventListener("click", () =>
      deps.onOpenUrl?.(`https://www.imdb.com/name/${person.imdbId}/`),
    );
  }

  const body = host.createDiv({ cls: "wl-person-body" });

  // --- the fact column ------------------------------------------------------
  const facts = body.createDiv({ cls: "wl-person-facts" });
  const age = ageFacts(person, today);
  fact(facts, "Known for", person.knownForDepartment);
  fact(facts, "Gender", person.gender);
  fact(facts, "Born", birthdayLabel(age));
  fact(facts, "Died", age.deathday);
  fact(facts, "Place of birth", person.placeOfBirth);
  fact(facts, "Also known as", person.alsoKnownAs.join(", "));
  fact(facts, "Credits", String(entry.credits.length));
  if (facts.childElementCount === 0) facts.remove();

  // --- biography + filmography ---------------------------------------------
  const main = body.createDiv({ cls: "wl-person-main" });
  main.createDiv({
    cls: "wl-person-bio",
    text: person.biography || "TMDB has no biography for this person.",
  });

  const sections = groupFilmography(entry.credits, person.knownForDepartment);
  const film = main.createDiv({ cls: "wl-person-filmography" });
  film.createEl("h3", { cls: "wl-person-filmography-heading", text: "Filmography" });
  if (sections.length === 0) {
    film.createDiv({
      cls: "wl-person-message-body",
      text: "TMDB lists no film or television credits for this person.",
    });
    return;
  }

  for (const section of sections) {
    film.createDiv({ cls: "wl-person-section-heading", text: section.department });
    const shelf = film.createDiv({ cls: "wl-person-shelf" });
    for (const credit of section.credits) renderCredit(shelf, credit, deps);
  }
}

function fact(parent: HTMLElement, label: string, value: string): void {
  if (value.trim() === "") return;
  const row = parent.createDiv({ cls: "wl-person-fact" });
  row.createDiv({ cls: "wl-person-fact-label", text: label });
  row.createDiv({ cls: "wl-person-fact-value", text: value });
}

/**
 * One filmography poster.
 *
 * Deliberately **not** `buildTitleCard`: that component takes a `TitleV4`, and a
 * credit the user does not own is not one — inventing a literal to satisfy it is
 * exactly what the runtime-preservation contract forbids, and every affordance
 * the card would then draw (status pill, progress bar, "mark episode watched")
 * is meaningless for something that is not in the library yet. The poster box
 * itself is the shared `.wl-thumb`, so it lines up with every other one.
 */
function renderCredit(parent: HTMLElement, credit: PersonCredit, deps: PersonScreenDeps): void {
  const tile = parent.createDiv({ cls: "wl-person-credit" });
  tile.dataset.tmdbId = String(credit.result.tmdbId);

  let owned = ownedTitleFor(credit, deps.titles());
  const activate = (): void => {
    if (owned) deps.onOpenTitle(owned);
  };
  // Bound once, on the tile that never gets replaced: adding something repaints
  // this tile's contents in place, so the shelf keeps its order and its scroll.
  tile.addEventListener("click", activate);
  tile.addEventListener("keydown", (event: KeyboardEvent) => {
    if (!owned || (event.key !== "Enter" && event.key !== " ")) return;
    event.preventDefault();
    activate();
  });

  const paint = (): void => {
    tile.empty();
    tile.toggleClass("is-owned", owned !== undefined);
    tile.toggleClass("is-clickable", owned !== undefined);
    if (owned) {
      tile.setAttribute("role", "button");
      tile.setAttribute("tabindex", "0");
      tile.setAttribute("aria-label", `${credit.result.title} — open details`);
    }

    const poster = tile.createDiv({ cls: "wl-thumb wl-person-credit-poster" });
    poster.dataset.posterSeed = credit.result.title;
    if (credit.result.posterUrl) {
      const img = poster.createEl("img", { cls: "wl-thumb-img" });
      img.setAttribute("alt", "");
      img.setAttribute("loading", "lazy");
      img.src = credit.result.posterUrl;
    } else {
      renderPosterPlaceholder(poster, credit.result.title);
    }

    if (owned) {
      // Owned is a state, not an action: the badge says so and the tile opens it.
      const badge = poster.createDiv({
        cls: "wl-person-credit-badge is-owned",
        attr: { "aria-label": `${credit.result.title} is in your library` },
      });
      setIcon(badge, "check");
    } else {
      const add = poster.createEl("button", {
        cls: "wl-person-add",
        text: "+ Add",
        attr: {
          type: "button",
          "aria-label": `Add ${credit.result.title} to your library`,
          title: `Add ${credit.result.title} to your library`,
        },
      });
      add.addEventListener("click", (event: MouseEvent) => {
        event.preventDefault();
        event.stopPropagation();
        add.disabled = true;
        void deps
          .onAdd(credit.result)
          .then((title) => {
            notify(
              deps,
              title ? `Added «${credit.result.title}».` : `Could not add «${credit.result.title}».`,
            );
            if (title) {
              owned = title;
              paint();
            }
          })
          .catch((err: unknown) => notify(deps, `Could not add: ${messageOf(err)}`))
          .finally(() => {
            add.disabled = false;
          });
      });
    }

    const caption = tile.createDiv({ cls: "wl-person-credit-body" });
    caption.createDiv({ cls: "wl-person-credit-title", text: credit.result.title });
    // Both lines are always drawn, even when empty: a tile that drops one is a
    // tile whose poster sits on a different line from its neighbours.
    caption.createDiv({
      cls: "wl-person-credit-role",
      text: credit.role || (credit.department === "Acting" ? "Actor" : credit.department),
    });
    caption.createDiv({
      cls: "wl-person-credit-year",
      text: credit.result.year === null ? "" : String(credit.result.year),
    });
  };

  paint();
}

function notify(deps: PersonScreenDeps, message: string): void {
  if (deps.notify) deps.notify(message);
  else new Notice(message);
}

// ---------------------------------------------------------------------------
// The Obsidian shell
// ---------------------------------------------------------------------------

/**
 * The leaf.
 *
 * A view rather than a modal because a filmography is a place you browse and
 * come back to — and because a modal cannot be opened next to the Library.
 */
export class PersonView extends ItemView {
  private screen: PersonScreenHandle | null = null;
  private target: PersonTarget = {};

  constructor(
    leaf: WorkspaceLeaf,
    private readonly deps: PersonScreenDeps,
  ) {
    super(leaf);
  }

  override getViewType(): string {
    return VIEW_TYPE_PERSON;
  }

  override getDisplayText(): string {
    return this.target.name ? `Person — ${this.target.name}` : PERSON_VIEW_DISPLAY_NAME;
  }

  override getIcon(): string {
    return PERSON_VIEW_ICON;
  }

  override async onOpen(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    this.screen = mountPersonScreen(root, this.deps);
    this.screen.open(this.target);
  }

  override async onClose(): Promise<void> {
    this.screen?.destroy();
    this.screen = null;
  }

  /** Workspace state, so a reopened tab lands on the same person. */
  override getState(): Record<string, unknown> {
    return { ...super.getState(), ...this.target };
  }

  override async setState(state: unknown, result: ViewStateResult): Promise<void> {
    await super.setState(state, result);
    const raw = (state ?? {}) as Record<string, unknown>;
    const next: PersonTarget = {};
    if (typeof raw["personId"] === "number") next.personId = raw["personId"];
    if (typeof raw["name"] === "string") next.name = raw["name"];
    this.target = next;
    this.screen?.open(next);
  }

  /** Point an already-open leaf at somebody else. */
  show(target: PersonTarget): void {
    this.target = target;
    this.screen?.open(target);
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * What registering needs from the plugin, structurally.
 *
 * Declared rather than imported so this module never depends on `main.ts` — the
 * import would be circular, and `main.ts` is not this lane's to touch anyway.
 */
export interface PersonViewHost {
  app: App;
  registerView(type: string, creator: (leaf: WorkspaceLeaf) => PersonView): void;
}

/** One call in `onload`. The factory is lazy, so it costs nothing until opened. */
export function registerPersonView(host: PersonViewHost, deps: PersonScreenDeps): void {
  host.registerView(VIEW_TYPE_PERSON, (leaf: WorkspaceLeaf) => new PersonView(leaf, deps));
}

/**
 * Open (or re-point) the person leaf.
 *
 * One leaf is reused rather than a tab per person: this is a place you pass
 * through on the way to adding something, not a set of pinned reference pages.
 */
export async function openPersonView(app: App, target: PersonTarget): Promise<void> {
  const { workspace } = app;
  const existing = workspace.getLeavesOfType(VIEW_TYPE_PERSON);
  const leaf = existing[0] ?? workspace.getLeaf("tab");
  await leaf.setViewState({ type: VIEW_TYPE_PERSON, active: true, state: { ...target } });
  workspace.revealLeaf(leaf);
  if (leaf.view instanceof PersonView) leaf.view.show(target);
}
