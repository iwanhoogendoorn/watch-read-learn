/**
 * Legacy fence compatibility — SPEC D8 / §4.9.
 *
 * v3 registered six languages; v4 registers one and translates the other five
 * into the same `WidgetPlan` the new renderers consume. The user's existing
 * notes keep rendering untouched, and they get the v4 behaviour for free (the
 * `wl-upcoming` shim, for instance, is no longer limited to a single `once`
 * schedule — it reads the airing engine like every other upcoming surface).
 *
 * The sixth fence, v3's ```` ```watchlog ```` with an `id:` body, needs no shim:
 * `id` is a first-class key of the v4 DSL, so those blocks parse as-is and now
 * render a card instead of v3's bespoke layout.
 *
 * Exact v3 grammars are documented in `docs/research/report-watchlog.md` §2.6;
 * each translator below reproduces one of them. All are pure and unit-tested.
 */
import type { LegacyFence, WidgetIssue, WidgetStat } from "../types";
import { emptySpec, type WidgetPlan, type WidgetSystem } from "./render";

function issue(message: string): WidgetIssue {
  return { line: 0, key: "", value: "", message };
}

function bodyLines(source: string): string[] {
  return source
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

/**
 * `wl-todo` — a tracker card resolved by **title name** (case-insensitive
 * exact match). A line reading exactly `mini` switches to the compact card.
 */
export function translateWlTodo(source: string): WidgetPlan {
  const lines = bodyLines(source);
  const mini = lines.some((line) => line.toLowerCase() === "mini");
  const name = lines.find((line) => line.toLowerCase() !== "mini") ?? "";
  const spec = emptySpec();
  spec.view = "now";
  spec.limit = 1;
  if (name) spec.titles = [name];

  return {
    spec,
    issues: name
      ? []
      : [issue('wl-todo: the block needs a title name on its own line, e.g. "Dexter: Resurrection".')],
    options: {
      variant: mini ? "mini" : "full",
      errorHeading: "Watch, Read and Learn widget — invalid wl-todo block",
    },
  };
}

/** The seven bodies v3's `wl-stat` accepted, mapped onto the v4 stat blocks. */
const LEGACY_STAT_BODIES: Record<string, { stat: WidgetStat; extra?: WidgetStat[] }> = {
  watched: { stat: "time" },
  completed: { stat: "completed" },
  remaining: { stat: "time" },
  time: { stat: "time" },
  "time full": { stat: "time" },
  "completed full": { stat: "completed" },
  "time completed full": { stat: "time", extra: ["completed"] },
};

export const LEGACY_STAT_VOCABULARY = Object.keys(LEGACY_STAT_BODIES);

/**
 * `wl-stat` — the body is one of seven exact strings. v4 folds the "mini" and
 * "full" variants into the same strip; the numbers are identical and now come
 * from the single time formula in `data/episodes.ts`.
 */
export function translateWlStat(source: string): WidgetPlan {
  const body = bodyLines(source).join(" ").toLowerCase().trim();
  const spec = emptySpec();
  spec.view = "stat";
  spec.stat = "time";

  const match = LEGACY_STAT_BODIES[body];
  if (!match) {
    return {
      spec,
      issues: [
        issue(
          `wl-stat: unknown stat "${body}". Use ${LEGACY_STAT_VOCABULARY.join(", ")}.`,
        ),
      ],
      options: { errorHeading: "Watch, Read and Learn widget — invalid wl-stat block" },
    };
  }

  spec.stat = match.stat;
  return {
    spec,
    issues: [],
    options: {
      errorHeading: "Watch, Read and Learn widget — invalid wl-stat block",
      ...(match.extra ? { extraStats: match.extra } : {}),
    },
  };
}

/**
 * `wl-upcoming` — body must be exactly `next` or `next full`. v3 scanned
 * `airtime` for `once` schedules; v4 reads the airing engine, so recurring
 * weekly shows finally appear (report §5).
 */
export function translateWlUpcoming(source: string): WidgetPlan {
  const body = bodyLines(source).join(" ").toLowerCase().trim();
  const spec = emptySpec();
  spec.view = "upcoming";
  spec.limit = 1;
  spec.sort = "nextAirDate";
  spec.direction = "asc";

  if (body !== "next" && body !== "next full") {
    return {
      spec,
      issues: [issue(`wl-upcoming: unknown body "${body}". Use next or next full.`)],
      options: { errorHeading: "Watch, Read and Learn widget — invalid wl-upcoming block" },
    };
  }
  return { spec, issues: [], options: { errorHeading: "Watch, Read and Learn widget — invalid wl-upcoming block" } };
}

/** `wl-nowwatching` — empty body, or `full`. Renders the pinned title(s). */
export function translateWlNowWatching(source: string): WidgetPlan {
  const body = bodyLines(source).join(" ").toLowerCase().trim();
  const spec = emptySpec();
  spec.view = "now";
  spec.limit = 1;

  if (body !== "" && body !== "full") {
    return {
      spec,
      issues: [issue(`wl-nowwatching: unknown body "${body}". Leave it empty, or use full.`)],
      options: { errorHeading: "Watch, Read and Learn widget — invalid wl-nowwatching block" },
    };
  }
  return {
    spec,
    issues: [],
    options: {
      variant: body === "full" ? "full" : "compact",
      errorHeading: "Watch, Read and Learn widget — invalid wl-nowwatching block",
    },
  };
}

/** `wl-now-next` — no body. Two columns: NOW WATCHING | UPCOMING NEXT. */
export function translateWlNowNext(source: string): WidgetPlan {
  const body = bodyLines(source).join(" ").trim();
  const spec = emptySpec();
  spec.view = "now";
  spec.limit = 1;

  return {
    spec,
    issues: body
      ? [issue(`wl-now-next: this block takes no body, but found "${body}".`)]
      : [],
    options: { twoColumn: true, errorHeading: "Watch, Read and Learn widget — invalid wl-now-next block" },
  };
}

export const LEGACY_TRANSLATORS: Record<LegacyFence, (source: string) => WidgetPlan> = {
  "wl-todo": translateWlTodo,
  "wl-stat": translateWlStat,
  "wl-upcoming": translateWlUpcoming,
  "wl-nowwatching": translateWlNowWatching,
  "wl-now-next": translateWlNowNext,
};

/** Register all five shims against the same registry as the modern fence. */
export function registerLegacyFences(system: WidgetSystem): void {
  for (const [lang, translate] of Object.entries(LEGACY_TRANSLATORS)) {
    system.registerFence(lang, translate);
  }
}
