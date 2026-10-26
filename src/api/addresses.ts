/**
 * Pure address logic for the local API: which interfaces to bind for a
 * "Listen on" choice, and whether a caller is on this machine.
 *
 * No node imports. The interface list is passed in (`server.ts` supplies
 * `os.networkInterfaces()` at run time), so every rule here is unit-tested
 * without a network. Modelled on Food Spot's `src/api/addresses.ts`.
 */
import type { Settings } from "../types";

/** The "Listen on" choice, as stored in `settings.apiHost`. */
export type ApiHostMode = Settings["apiHost"];

/** The slice of `os.networkInterfaces()` used here. Node < 18.4 spelled family as 4. */
export type InterfaceMap = Record<
  string,
  { address: string; family: string | number; internal: boolean }[] | undefined
>;

export const LOOPBACK_HOST = "127.0.0.1";
export const ALL_HOSTS = "0.0.0.0";

const isIPv4 = (family: string | number): boolean => family === "IPv4" || family === 4;

/**
 * True for 127.0.0.0/8 and ::1, in plain or IPv4-mapped IPv6 spelling.
 *
 * An unknown peer address is NOT loopback: the remote-write guard keys off
 * this, so it has to fail closed.
 */
export function isLoopbackAddress(addr: string | undefined): boolean {
  if (typeof addr !== "string" || addr === "") return false;
  const lower = addr.toLowerCase();
  const a = lower.startsWith("::ffff:") ? lower.slice(7) : lower;
  if (a === "::1") return true;
  const m = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(a);
  return m !== null && m.slice(1).every((part) => Number(part) <= 255);
}

/** Tailscale assigns IPv4 addresses from the CGNAT block 100.64.0.0/10. */
export function isTailscaleAddress(ip: string): boolean {
  const m = /^100\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (m === null) return false;
  if (m.slice(2).some((part) => Number(part) > 255)) return false;
  const second = Number(m[1]);
  return second >= 64 && second <= 127;
}

/** macOS names the Tailscale tunnel `utunN`; Linux and Windows call it `tailscale0` / `Tailscale`. */
const TAILSCALE_IFACE = /^(utun|tailscale)/i;

/**
 * This machine's Tailscale IPv4 address, if the tailnet interface is up.
 *
 * A tunnel interface is preferred: 100.64.0.0/10 is carrier-grade NAT space,
 * and an ISP or a second VPN can hand out an address from it on an ordinary
 * interface. Any other interface carrying such an address is the fallback.
 */
export function pickTailscaleAddress(ifaces: InterfaceMap): string | undefined {
  const candidates = (preferTunnel: boolean): string | undefined => {
    for (const [name, list] of Object.entries(ifaces)) {
      if (preferTunnel !== TAILSCALE_IFACE.test(name)) continue;
      for (const i of list ?? []) {
        if (!i.internal && isIPv4(i.family) && isTailscaleAddress(i.address)) return i.address;
      }
    }
    return undefined;
  };
  return candidates(true) ?? candidates(false);
}

export interface BindPlan {
  /** Addresses to listen on, one server each, same port. */
  hosts: string[];
  /** Tailscale mode, but no tailnet address yet: serving loopback meanwhile. */
  waitingForTailscale: boolean;
}

/**
 * Hosts for a "Listen on" choice.
 *
 * Tailscale mode binds loopback too, so scripts on this Mac keep using
 * 127.0.0.1, and keep working while the tailnet is still coming up. An
 * unrecognised mode falls back to loopback: the narrowest choice is the safe
 * one when the setting cannot be read.
 */
export function bindPlan(mode: ApiHostMode | string, ifaces: InterfaceMap): BindPlan {
  if (mode === "all") return { hosts: [ALL_HOSTS], waitingForTailscale: false };
  if (mode === "tailscale") {
    const ts = pickTailscaleAddress(ifaces);
    return ts === undefined
      ? { hosts: [LOOPBACK_HOST], waitingForTailscale: true }
      : { hosts: [LOOPBACK_HOST, ts], waitingForTailscale: false };
  }
  return { hosts: [LOOPBACK_HOST], waitingForTailscale: false };
}
