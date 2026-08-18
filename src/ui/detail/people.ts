/**
 * A credit name as a way *into* a person, not just a way to filter by one.
 *
 * Every surface that shows a cast or a director shows it differently — the modal
 * wraps chips, the full view runs one comma-separated line, the Dashboard ranks
 * them with counts — but the *behaviour* behind the name has to be one thing, or
 * "click Pedro Pascal" means three different things depending on where you are.
 * The layout stays with the surface; what a click does lives here.
 *
 * Two destinations, one control:
 *
 *   - **Plain click opens the person.** `cast:"Nolan"` can only ever show you
 *     what you already own, which is exactly the limitation `ui/views/person.ts`
 *     was built to lift. Opening the person is the more useful of the two, so it
 *     is the one that costs nothing.
 *   - **Alt-click filters the Library**, which is what the chips did before, and
 *     it is still the right answer for "what of theirs do I have?". Losing it
 *     would be a regression, so it keeps a binding rather than a footnote, and
 *     the tooltip says so on every link that offers both.
 *
 * A credit is a bare string (`TitleV4.cast` is `string[]`; there are no person
 * ids in this plugin's data), so opening one is opening a *name*. Resolving that
 * name — including the "two people, one name" case, which asks rather than
 * guesses — is `mountPersonScreen`'s job and is not duplicated here.
 *
 * **Studios are not people.** `isPersonField` is the single gate: a caller may
 * hand every chip the same opener and a studio chip will still only ever filter.
 */
import { Notice, type App } from "obsidian";
import { openPersonView } from "../views/person";

/** Query fields the person screen can answer for. */
const PERSON_FIELDS: ReadonlySet<string> = new Set(["cast", "director"]);

/** True for the credit fields that name a human being. */
export function isPersonField(field: string): boolean {
  return PERSON_FIELDS.has(field);
}

export type PersonOpener = (name: string) => void;

/**
 * The opener a surface hands to `bindCreditLink`, built from its `App`.
 *
 * Returns `undefined` without one — a headless host or a test — and every link
 * then degrades to the Library search it had before, which is why no surface
 * needs to know whether the person view is reachable.
 */
export function personOpener(app: App | undefined | null): PersonOpener | undefined {
  if (!app) return undefined;
  return (name: string): void => {
    // Never throw out of a click handler, and never leave a rejected promise
    // behind: the person leaf failing to open is a sentence, not a crash.
    void openPersonView(app, { name }).catch((err: unknown) => {
      const detail = err instanceof Error ? err.message : String(err);
      console.error("[wrl] could not open the person view", err);
      new Notice(`Could not open that person — ${detail}`, 8000);
    });
  };
}

export interface CreditLinkOptions {
  /** The credit exactly as stored. The only identity a credit has. */
  name: string;
  /** Library query field — `cast`, `director`, `studio`, `genre`, `tag`. */
  field: string;
  /** Noun for the tooltip. Defaults to `field`. */
  noun?: string;
  /** Open the person screen. Ignored for a field that is not a person. */
  openPerson?: PersonOpener;
  /** Hand a scoped query back to the Library. */
  onFilter?: (query: string) => void;
}

/** What a bound link ended up able to do, so a surface can style or skip it. */
export interface CreditLinkBinding {
  opens: boolean;
  filters: boolean;
}

/**
 * Give `el` the one credit-link behaviour.
 *
 * Safe on a `<button>` and on a `<span>` alike: the ARIA and the tab stop are
 * only added when the element does not already carry them by being a button.
 * Returns what it wired, and wires nothing at all when neither destination is
 * available — the caller then has a plain, honest label.
 */
export function bindCreditLink(el: HTMLElement, options: CreditLinkOptions): CreditLinkBinding {
  const { name, field } = options;
  const noun = options.noun ?? field;
  const query = `${field}:"${name}"`;

  const open = isPersonField(field) ? options.openPerson : undefined;
  const filter = options.onFilter;
  const binding: CreditLinkBinding = { opens: open !== undefined, filters: filter !== undefined };
  if (!open && !filter) return binding;

  el.setAttribute(
    "title",
    open
      ? filter
        ? `Open ${name} — Alt-click to filter the library by them instead`
        : `Open ${name}`
      : `Show every title with ${noun} “${name}”`,
  );
  if (el.tagName !== "BUTTON") {
    el.setAttribute("role", "button");
    el.setAttribute("tabindex", "0");
  }

  const fire = (event: { altKey?: boolean }): void => {
    if (event.altKey === true && filter) {
      filter(query);
      return;
    }
    if (open) {
      open(name);
      return;
    }
    filter?.(query);
  };

  el.addEventListener("click", (event: MouseEvent) => fire(event));
  el.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    // Space scrolls the page otherwise, which is the one default worth stopping.
    event.preventDefault();
    fire(event);
  });

  return binding;
}
