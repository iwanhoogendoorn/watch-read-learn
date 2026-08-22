/**
 * The detail poster — **eagerly loaded, never observed** (QA1 B3).
 *
 * A detail surface is by definition the thing you are looking at, so lazy
 * loading buys nothing here and costs everything: this used to fall back to the
 * letter placeholder whenever no `PosterLoader` was injected, which is exactly
 * what the Library's own `openDetail` does — a title whose card showed a poster
 * opened onto a placeholder.
 *
 * The same resolution rules as everywhere else (`posterUrlFor` for the manual
 * override, `resolvePosterUrl` for a bare TMDB path), the same negative cache,
 * and the same tinted-initial fallback when the image fails.
 */
import type { PosterCacheLookup, TitleV4 } from "../../types";
import {
  isPosterFailed,
  markPosterFailed,
  posterUrlFor,
  renderPosterPlaceholder,
  resolvePosterUrl,
} from "../components/posters";

export function renderDetailPoster(
  host: HTMLElement,
  title: TitleV4,
  cache?: PosterCacheLookup,
): HTMLElement {
  const poster = host.createDiv({ cls: "wl-poster" });
  poster.dataset.posterSeed = title.title;

  // One image rather than a grid of them, but the same rule: a vault with the
  // artwork cached should render offline, and a detail screen that hotlinks is
  // the one place the reader is *looking* at the poster.
  const url = resolvePosterUrl(posterUrlFor(title, cache));
  if (url === "" || isPosterFailed(url)) {
    renderPosterPlaceholder(poster, title.title);
    return poster;
  }

  const img = poster.createEl("img", { cls: "wl-poster-img" });
  img.setAttribute("decoding", "async");
  img.setAttribute("alt", "");
  img.addEventListener("load", () => {
    img.addClass("is-loaded");
    poster.addClass("has-poster");
  });
  img.addEventListener("error", () => {
    markPosterFailed(url);
    img.remove();
    poster.removeClass("has-poster");
    renderPosterPlaceholder(poster, title.title);
  });
  img.src = url;
  return poster;
}
