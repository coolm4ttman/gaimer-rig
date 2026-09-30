// GAIMER.RIG.WIN.2 — regression guard for the Tailscale/IPv6 daemon-start bug.
//
// The daemon binds loopback AND a tailnet IPv6 address in default bind mode.
// The listener gate probes every bound host, and an unbracketed IPv6 literal
// makes an unparseable URL, so the probe threw, the gate stayed INDETERMINATE,
// and `rig daemon start` reported "healthz not responding" even though the
// daemon had bound and was serving normally.

import { describe, it, expect } from "vitest";
import { hostForUrl, verifyRequiredListeners } from "../src/daemon-lifecycle.js";

const TAILNET_V6 = "fd7a:115c:a1e0::4635:642e";

describe("hostForUrl", () => {
  it("leaves IPv4 and hostnames alone", () => {
    expect(hostForUrl("127.0.0.1")).toBe("127.0.0.1");
    expect(hostForUrl("localhost")).toBe("localhost");
    expect(hostForUrl("example.internal")).toBe("example.internal");
  });

  it("brackets IPv6 literals", () => {
    expect(hostForUrl(TAILNET_V6)).toBe(`[${TAILNET_V6}]`);
    expect(hostForUrl("::1")).toBe("[::1]");
  });

  it("does not double-bracket", () => {
    expect(hostForUrl(`[${TAILNET_V6}]`)).toBe(`[${TAILNET_V6}]`);
  });

  it("produces a URL the WHATWG parser accepts", () => {
    // The pre-fix string threw here, which is exactly why fetch failed.
    expect(() => new URL(`http://${hostForUrl(TAILNET_V6)}:7433/healthz`)).not.toThrow();
    expect(() => new URL(`http://${TAILNET_V6}:7433/healthz`)).toThrow();
  });
});

describe("verifyRequiredListeners with a tailnet IPv6 listener", () => {
  it("passes the gate when both listeners answer", async () => {
    const probed: string[] = [];
    const result = await verifyRequiredListeners({
      bind: { mode: "default", hosts: ["127.0.0.1", TAILNET_V6], tailscaleDetected: true },
      port: 7433,
      probe: async (url) => {
        probed.push(url);
        // Reject anything that is not a parseable URL, the way fetch does.
        new URL(url);
        return "healthy";
      },
    });

    expect(result.ok).toBe(true);
    expect(probed).toContain("http://127.0.0.1:7433/healthz");
    expect(probed).toContain(`http://[${TAILNET_V6}]:7433/healthz`);
  });
});
