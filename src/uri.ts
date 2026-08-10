/**
 * `obsidian://watchlog` deep links.
 *
 * The protocol handler is what lets anything *outside* Obsidian — a shell
 * alias, an automation, another plugin's button, a note in a different vault —
 * land inside the plugin at a useful spot instead of at "the plugin is open,
 * good luck". Four routes, all query-string driven:
 *
 *   obsidian://watchlog                             → open the view
 *   obsidian://watchlog?tab=upcoming                → open a specific tab
 *   obsidian://watchlog?do=search&query=alien       → filtered Library
 *   obsidian://watchlog?do=add&query=Dune           → add modal, prefilled
 *   obsidian://watchlog?do=surprise                 → roll a random pick
 *
 * The verb parameter is `do`, not `action`: Obsidian writes the protocol path
 * into `params.action` when it invokes the handler, so an `action=` query
 * parameter is at the platform's mercy. `action=` is still honoured when it
 * survives with a value other than the handler name, so hand-written links
 * that guessed the conventional name keep working.
 *
 * Parsing is pure and total: every parameter combination returns either a
 * typed route or an `invalid` with a human reason, so the handler can say
 * *what* was wrong with a link instead of guessing at intent. Unknown tabs and
 * verbs are errors, not fallbacks — a typo in an automation should be heard
 * once, not silently land on the wrong tab forever.
 */
import { TAB_IDS, type TabId } from "./types";

export type WatchlogRoute =
  | { action: "open"; tab: TabId; query: string }
  | { action: "add"; query: string }
  | { action: "surprise" }
  | { action: "invalid"; reason: string };

/** `params` is Obsidian's decoded query string plus its own `action` key. */
export function parseWatchlogRoute(
  params: Record<string, string | undefined>,
): WatchlogRoute {
  const query = (params.query ?? "").trim();
  const rawTab = (params.tab ?? "").trim();

  const fallbackAction = (params.action ?? "").trim().toLowerCase();
  const rawVerb =
    (params.do ?? "").trim().toLowerCase() ||
    (fallbackAction !== "watchlog" ? fallbackAction : "");
  const verb = rawVerb === "" ? "open" : rawVerb;

  if (rawTab !== "" && !(TAB_IDS as readonly string[]).includes(rawTab)) {
    return {
      action: "invalid",
      reason: `unknown tab "${rawTab}" — one of: ${TAB_IDS.join(", ")}`,
    };
  }
  const tab = (rawTab === "" ? "library" : rawTab) as TabId;

  switch (verb) {
    case "open":
      return { action: "open", tab, query };
    // "search" reads better in a hand-written link; it is `open` with a query.
    case "search":
      return { action: "open", tab, query };
    case "add":
      return { action: "add", query };
    case "surprise":
      return { action: "surprise" };
    default:
      return {
        action: "invalid",
        reason: `unknown verb "${verb}" — one of: open, search, add, surprise`,
      };
  }
}
