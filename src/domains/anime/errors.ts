/**
 * Failures from the two anime providers.
 *
 * `ApiError` in `services/http.ts` is tagged with `ApiSource`, which the frozen
 * contract fixes to the three video providers (`overseerr | plex | tmdb`). Rather
 * than widen a contract this lane does not own, the anime clients carry their own
 * error type over the **same** `ApiErrorReason` taxonomy, and never let a
 * transport-level `ApiError` escape: every one is caught at the client boundary
 * and re-thrown as an `AnimeApiError` naming the provider that actually failed.
 *
 * It adds one thing the video providers have no use for: `retryAfterMs`. AniList
 * answers a 429 with `Retry-After`, and a Jikan `504 BadResponseException` means
 * MyAnimeList itself is down and deserves a backoff measured in minutes
 * (report §1.1) — both are instructions about *when*, which a bare reason cannot
 * carry.
 */
import type { ApiErrorReason } from "../../types";

export type AnimeProvider = "anilist" | "jikan";

export interface AnimeApiErrorInit {
  provider: AnimeProvider;
  reason: ApiErrorReason;
  status?: number;
  detail?: string;
  providerMessage?: string;
  /** How long to wait before trying again, when the provider said so. */
  retryAfterMs?: number;
}

export class AnimeApiError extends Error {
  readonly provider: AnimeProvider;
  readonly reason: ApiErrorReason;
  readonly status?: number;
  readonly detail?: string;
  readonly providerMessage?: string;
  readonly retryAfterMs?: number;

  constructor(init: AnimeApiErrorInit) {
    super(init.providerMessage || init.detail || `${init.provider}: ${init.reason}`);
    this.name = "AnimeApiError";
    this.provider = init.provider;
    this.reason = init.reason;
    if (init.status !== undefined) this.status = init.status;
    if (init.detail !== undefined) this.detail = init.detail;
    if (init.providerMessage !== undefined) this.providerMessage = init.providerMessage;
    if (init.retryAfterMs !== undefined) this.retryAfterMs = init.retryAfterMs;
  }
}

export function isAnimeApiError(err: unknown): err is AnimeApiError {
  return err instanceof AnimeApiError;
}

/** One sentence per failure, in the same voice as `describeApiError`. */
export function describeAnimeApiError(err: AnimeApiError): string {
  const provider = err.provider === "anilist" ? "AniList" : "Jikan";
  switch (err.reason) {
    case "rate-limited":
      return `${provider} is rate-limiting us${
        err.retryAfterMs ? ` — try again in ${Math.ceil(err.retryAfterMs / 1000)}s` : ""
      }.`;
    case "server":
      return err.provider === "jikan"
        ? "MyAnimeList is not answering Jikan right now. Watch, Read and Learn will back off and retry; AniList is unaffected."
        : `${provider} returned a server error${err.status ? ` (${err.status})` : ""}.`;
    case "not-found":
      return `${provider} has no record of that entry.`;
    case "parse":
      return `${provider} sent a response the plugin could not read.`;
    case "timeout":
      return `${provider} did not answer in time.`;
    case "network":
      return `Could not reach ${provider}. Check this machine's connection.`;
    default:
      return err.providerMessage || `${provider} request failed${err.status ? ` (${err.status})` : ""}.`;
  }
}
