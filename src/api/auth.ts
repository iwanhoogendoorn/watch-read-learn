/**
 * Bearer-token helpers for the local API.
 *
 * `crypto` is required at call time, never imported: this file is reachable
 * from the settings tab, and the bundle has to load on mobile, where there is
 * no node. Only the desktop server ever calls `sameToken`. The bare name, not
 * `node:crypto`, is the one the esbuild config marks external.
 */

/**
 * Constant-time token comparison.
 *
 * Both sides are hashed first, so the comparison is always over two 32-byte
 * digests: `timingSafeEqual` throws on unequal lengths, and comparing the raw
 * strings would leak the token's length through the early exit.
 */
export function sameToken(given: string, expected: string): boolean {
  if (expected === "") return false;
  const crypto = require("crypto") as typeof import("node:crypto");
  const digest = (s: string): Buffer => crypto.createHash("sha256").update(s, "utf8").digest();
  return crypto.timingSafeEqual(digest(given), digest(expected));
}

/** 24 random bytes as 48 hex characters. Web Crypto, so it works on any platform. */
export function randomToken(): string {
  const bytes = new Uint8Array(24);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
