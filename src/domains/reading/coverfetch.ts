/**
 * The one obsidian-touching piece of the cover fallback: `covers.ts` stays
 * pure and takes a byte-fetcher as an argument; the app injects this one,
 * built on `requestUrl` so the request is CORS-free and carries no cookies.
 */
import { requestUrl } from "obsidian";

export async function fetchCoverBytes(url: string): Promise<ArrayBuffer | null> {
  try {
    const res = await requestUrl({ url, throw: false });
    return res.status === 200 ? res.arrayBuffer : null;
  } catch {
    return null;
  }
}
