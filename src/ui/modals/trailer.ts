/**
 * The trailer modal (SPEC §4.3).
 *
 * Three behaviours, chosen by `settings.trailerMode`:
 *
 *   - `embed`      a `youtube-nocookie.com` iframe in a modal;
 *   - `link-only`  straight out to the browser, no modal at all;
 *   - `off`        nothing plays, and the card action is not offered.
 *
 * The escape hatch is not optional. Embeds fail for two reasons the plugin
 * cannot detect from inside an iframe — region blocks, and studio uploads with
 * embedding disabled — and both present as a black rectangle. So the embed
 * modal *always* also renders "Open on YouTube", and the modal says so rather
 * than leaving the user staring at a dead player.
 *
 * `youtube-nocookie.com` is deliberate: it is the same player without the
 * tracking cookie, which is the right default for something that renders
 * unprompted inside someone's notes.
 */
import { Modal, Notice, type App } from "obsidian";
import { YOUTUBE_EMBED_BASE, YOUTUBE_WATCH_BASE } from "../../constants";
import type { TitleV4, TrailerMode } from "../../types";

/**
 * Everything the iframe is allowed to do. Deliberately short.
 *
 * `fullscreen` is in the list *and* the legacy `allowfullscreen` attribute is
 * kept: Chromium gates the Fullscreen API on the permissions-policy list, so the
 * attribute alone leaves YouTube's fullscreen button dead. No `sandbox` — the
 * research contract says it breaks the player without buying anything.
 */
const IFRAME_ALLOW =
  "accelerometer; autoplay; clipboard-write; encrypted-media; fullscreen; gyroscope; picture-in-picture; web-share";

/** The only schemes a stored trailer URL may use before it reaches the DOM. */
const SAFE_SCHEMES = new Set(["http:", "https:"]);

/**
 * A URL that is safe to put in an `href` or hand to `window.open`.
 *
 * `trailerUrl` is data — it comes from a provider response or from a field the
 * user can type into — so `javascript:`, `file:`, `data:` and friends have to be
 * rejected once, here, rather than trusted at each of the four places that
 * render a trailer link. Returns `""` for anything that is not http(s).
 */
export function safeExternalUrl(raw: string): string {
  const value = raw.trim();
  if (value === "") return "";
  try {
    const parsed = new URL(value);
    return SAFE_SCHEMES.has(parsed.protocol) ? parsed.href : "";
  } catch {
    return "";
  }
}

/** An 11-character YouTube video id. */
const KEY_PATTERN = /^[A-Za-z0-9_-]{11}$/;

/**
 * The video id out of any YouTube URL shape we might have stored — `watch?v=`,
 * `youtu.be/`, `/embed/`, `/shorts/` — or out of a bare id.
 *
 * Returns `""` for anything that is not YouTube, which is the signal to fall
 * back to "open this link externally" rather than to embed something unknown.
 */
export function youtubeKey(raw: string): string {
  const url = raw.trim();
  if (url === "" || url === "none") return "";
  if (KEY_PATTERN.test(url)) return url;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "";
  }

  const host = parsed.hostname.replace(/^www\./, "").toLowerCase();
  const isYouTube =
    host === "youtube.com" ||
    host === "m.youtube.com" ||
    host === "youtube-nocookie.com" ||
    host === "youtu.be";
  if (!isYouTube) return "";

  if (host === "youtu.be") {
    const key = parsed.pathname.slice(1).split("/")[0] ?? "";
    return KEY_PATTERN.test(key) ? key : "";
  }

  const v = parsed.searchParams.get("v");
  if (v && KEY_PATTERN.test(v)) return v;

  const match = /^\/(?:embed|v|shorts)\/([A-Za-z0-9_-]{11})/.exec(parsed.pathname);
  return match?.[1] ?? "";
}

/** The privacy-preserving embed URL. Autoplay is on — the user asked to watch. */
export function youtubeEmbedUrl(key: string): string {
  return `${YOUTUBE_EMBED_BASE}/${encodeURIComponent(key)}?autoplay=1&rel=0&modestbranding=1`;
}

/** The canonical watch URL for a key, for the escape hatch. */
export function youtubeWatchUrl(key: string): string {
  return `${YOUTUBE_WATCH_BASE}${encodeURIComponent(key)}`;
}

/** `manualTrailerUrl` wins over the API-sourced one (SPEC §4.3). */
export function trailerUrlOf(title: TitleV4): string {
  const manual = (title.manualTrailerUrl ?? "").trim();
  if (manual && manual !== "none") return manual;
  const auto = (title.trailerUrl ?? "").trim();
  return auto && auto !== "none" ? auto : "";
}

export function hasTrailer(title: TitleV4): boolean {
  return trailerUrlOf(title) !== "";
}

/**
 * Build the iframe. Exported so the detail modal's inline slot and the modal
 * below render exactly the same player rather than two near-copies.
 */
export function renderTrailerEmbed(host: HTMLElement, key: string, label: string): HTMLIFrameElement {
  const frame = host.createEl("iframe", {
    attr: {
      src: youtubeEmbedUrl(key),
      title: label,
      allow: IFRAME_ALLOW,
      allowfullscreen: "true",
      referrerpolicy: "strict-origin-when-cross-origin",
      loading: "lazy",
    },
  });
  return frame;
}

export interface TrailerModalOptions {
  title: TitleV4;
  /** The resolved trailer URL; the modal never re-derives it. */
  url: string;
}

export class TrailerModal extends Modal {
  constructor(
    app: App,
    private readonly options: TrailerModalOptions,
  ) {
    super(app);
  }

  override onOpen(): void {
    const { contentEl, modalEl } = this;
    modalEl.addClass("wl-modal", "wl-trailer-modal");
    contentEl.empty();

    const { title, url } = this.options;
    contentEl.createEl("h3", { cls: "wl-modal-title", text: `${title.title} — trailer` });

    const key = youtubeKey(url);
    if (key) {
      const slot = contentEl.createDiv({ cls: "wl-trailer-slot" });
      renderTrailerEmbed(slot, key, `${title.title} trailer`);
    } else {
      // Not a YouTube URL — embedding an arbitrary origin inside Obsidian is
      // not something to do quietly, so say what it is and offer the link.
      contentEl.createDiv({
        cls: "wl-modal-message",
        text: "This trailer is not a YouTube link, so it opens in your browser instead.",
      });
    }

    const row = contentEl.createDiv({ cls: "wl-modal-buttons" });
    const external = key ? youtubeWatchUrl(key) : safeExternalUrl(url);
    if (external) {
      const link = row.createEl("a", {
        cls: "wl-btn",
        text: "Open on YouTube",
        href: external,
        attr: { target: "_blank", rel: "noopener noreferrer" },
      });
      link.setAttribute("aria-label", `Open the ${title.title} trailer in your browser`);
    } else {
      // Inline, next to the thing that is wrong — never a Notice wall.
      contentEl.createDiv({
        cls: "wl-modal-detail is-error",
        text: "That trailer link is not an http(s) address, so the plugin will not open it.",
      });
    }

    if (key) {
      contentEl.createDiv({
        cls: "wl-modal-detail",
        text: "Blank player? Some uploads block embedding or are region-locked — the link above always works.",
      });
    }
  }

  override onClose(): void {
    // Emptying the container detaches the iframe, which is what actually stops
    // the audio. Leaving it attached keeps it playing behind a closed modal.
    this.contentEl.empty();
  }
}

/**
 * The single entry point every trailer affordance calls.
 *
 * Returns `false` when nothing happened (no trailer, or trailers are off), so
 * callers can keep their own UI honest instead of guessing.
 */
export function openTrailer(app: App, title: TitleV4, mode: TrailerMode): boolean {
  const url = trailerUrlOf(title);
  if (!url) {
    new Notice(`No trailer stored for «${title.title}».`);
    return false;
  }

  if (mode === "off") {
    new Notice("Trailers are turned off in the plugin's settings.");
    return false;
  }

  if (mode === "link-only") {
    const key = youtubeKey(url);
    const external = key ? youtubeWatchUrl(key) : safeExternalUrl(url);
    if (!external) {
      new Notice(`«${title.title}»'s trailer link is not an http(s) address, so it was not opened.`);
      return false;
    }
    window.open(external, "_blank", "noopener,noreferrer");
    return true;
  }

  new TrailerModal(app, { title, url }).open();
  return true;
}
