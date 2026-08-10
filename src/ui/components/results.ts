/**
 * One provider search result, rendered the same way everywhere.
 *
 * The Add modal and the "match this title" picker show the same thing — poster,
 * name, year, media type, rating, overview, a flag or two — and the only real
 * difference is what picking one *does*. Two copies of this drifted apart in
 * v3; here there is one.
 */
import type { OverseerrSearchResult } from "../../types";
import { renderPosterPlaceholder } from "./posters";

export interface ResultFlag {
  text: string;
  /** `is-ok` (green), `is-tracked` (muted) — see `.wl-flag` in the modal CSS. */
  cls?: string;
}

export interface ProviderResultOptions {
  flags?: ResultFlag[];
  /** Rendered non-interactive, for a result that cannot be chosen. */
  disabled?: boolean;
  onPick: () => void;
}

export function renderProviderResult(
  host: HTMLElement,
  hit: OverseerrSearchResult,
  options: ProviderResultOptions,
): HTMLElement {
  const row = host.createDiv({ cls: "wl-add-result" });
  row.setAttribute("role", "button");
  row.setAttribute("tabindex", "0");

  const posterWrap = row.createDiv({ cls: "wl-add-result-poster" });
  const poster = posterWrap.createDiv({ cls: "wl-poster" });
  poster.dataset.posterSeed = hit.title;
  if (hit.posterUrl) {
    const img = poster.createEl("img", { cls: "wl-poster-img is-loaded" });
    img.setAttribute("alt", "");
    img.setAttribute("decoding", "async");
    img.src = hit.posterUrl;
  } else {
    renderPosterPlaceholder(poster, hit.title);
  }

  const body = row.createDiv({ cls: "wl-add-result-body" });
  body.createDiv({ cls: "wl-add-result-title", text: hit.title });
  const meta: string[] = [];
  if (hit.year) meta.push(String(hit.year));
  meta.push(hit.mediaType === "tv" ? "TV" : "Movie");
  if (hit.voteAverage > 0) meta.push(`★ ${hit.voteAverage.toFixed(1)}`);
  body.createDiv({ cls: "wl-add-result-meta", text: meta.join(" · ") });
  if (hit.overview) {
    body.createDiv({ cls: "wl-add-result-overview", text: hit.overview });
  }

  const flags = options.flags ?? [];
  if (flags.length > 0) {
    const host = row.createDiv({ cls: "wl-add-result-flags" });
    for (const flag of flags) {
      host.createSpan({ cls: `wl-flag ${flag.cls ?? ""}`.trim(), text: flag.text });
    }
  }

  row.addEventListener("click", () => options.onPick());
  row.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    options.onPick();
  });
  if (options.disabled) row.addClass("is-disabled");

  return row;
}
