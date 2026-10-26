/**
 * Address rules for the local API (`src/api/addresses.ts`). Pure: the
 * interface list is a fixture, never this machine's.
 */
import { describe, expect, it } from "vitest";
import {
  bindPlan,
  isLoopbackAddress,
  isTailscaleAddress,
  pickTailscaleAddress,
  type InterfaceMap,
} from "../src/api/addresses";

const LO: InterfaceMap = {
  lo0: [
    { address: "127.0.0.1", family: "IPv4", internal: true },
    { address: "::1", family: "IPv6", internal: true },
  ],
  en0: [{ address: "192.168.1.20", family: "IPv4", internal: false }],
};

const WITH_TAILNET: InterfaceMap = {
  ...LO,
  utun4: [
    { address: "fd7a:115c:a1e0::1", family: "IPv6", internal: false },
    { address: "100.67.202.68", family: "IPv4", internal: false },
  ],
};

describe("isLoopbackAddress", () => {
  it("accepts 127/8, ::1 and IPv4-mapped loopback", () => {
    for (const a of ["127.0.0.1", "127.255.0.9", "::1", "::ffff:127.0.0.1", "::FFFF:127.0.0.2"]) {
      expect(isLoopbackAddress(a), a).toBe(true);
    }
  });

  it("fails closed: undefined, empty and anything else are not loopback", () => {
    expect(isLoopbackAddress(undefined)).toBe(false);
    for (const a of ["", "0.0.0.0", "100.67.202.68", "192.168.1.20", "::ffff:10.0.0.1", "127.0.0.256", "128.0.0.1", "localhost", "::2"]) {
      expect(isLoopbackAddress(a), a).toBe(false);
    }
  });
});

describe("isTailscaleAddress", () => {
  it("is exactly 100.64.0.0/10", () => {
    expect(isTailscaleAddress("100.64.0.1")).toBe(true);
    expect(isTailscaleAddress("100.127.255.254")).toBe(true);
    expect(isTailscaleAddress("100.67.202.68")).toBe(true);
    expect(isTailscaleAddress("100.63.255.255")).toBe(false);
    expect(isTailscaleAddress("100.128.0.1")).toBe(false);
    expect(isTailscaleAddress("10.64.0.1")).toBe(false);
    expect(isTailscaleAddress("100.64.0.300")).toBe(false);
  });
});

describe("pickTailscaleAddress", () => {
  it("finds the tailnet IPv4 on a utun interface", () => {
    expect(pickTailscaleAddress(WITH_TAILNET)).toBe("100.67.202.68");
  });

  it("prefers a utun/tailscale interface over another interface in the same CGNAT block", () => {
    const ifaces: InterfaceMap = {
      en0: [{ address: "100.80.1.1", family: "IPv4", internal: false }],
      tailscale0: [{ address: "100.101.102.103", family: 4, internal: false }],
    };
    expect(pickTailscaleAddress(ifaces)).toBe("100.101.102.103");
  });

  it("falls back to any interface carrying such an address, and to undefined without one", () => {
    expect(pickTailscaleAddress({ en5: [{ address: "100.70.0.2", family: "IPv4", internal: false }] })).toBe(
      "100.70.0.2",
    );
    expect(pickTailscaleAddress(LO)).toBeUndefined();
    expect(pickTailscaleAddress({})).toBeUndefined();
  });
});

describe("bindPlan", () => {
  it("tailscale with a tailnet address: loopback and the tailnet IP", () => {
    expect(bindPlan("tailscale", WITH_TAILNET)).toEqual({
      hosts: ["127.0.0.1", "100.67.202.68"],
      waitingForTailscale: false,
    });
  });

  it("tailscale without one: loopback only, waiting for Tailscale", () => {
    expect(bindPlan("tailscale", LO)).toEqual({ hosts: ["127.0.0.1"], waitingForTailscale: true });
  });

  it("loopback, all, and an unknown mode", () => {
    expect(bindPlan("loopback", WITH_TAILNET)).toEqual({ hosts: ["127.0.0.1"], waitingForTailscale: false });
    expect(bindPlan("all", WITH_TAILNET)).toEqual({ hosts: ["0.0.0.0"], waitingForTailscale: false });
    expect(bindPlan("everywhere", WITH_TAILNET)).toEqual({ hosts: ["127.0.0.1"], waitingForTailscale: false });
    expect(bindPlan("", WITH_TAILNET)).toEqual({ hosts: ["127.0.0.1"], waitingForTailscale: false });
  });
});
