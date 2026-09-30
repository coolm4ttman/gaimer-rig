// GAIMER.RIG.WIN.4 — `rig daemon stop` prefers a graceful HTTP drain.
//
// On Windows process.kill(pid,"SIGTERM") is TerminateProcess: the daemon's
// signal handlers never run, so it cannot close its phases and never writes a
// shutdown receipt. POST /api/shutdown runs the same phases a signal would.
// The signal remains the fallback AND the escalation, so a daemon that will not
// go away is still stopped rather than waited on forever.

import { describe, it, expect, vi } from "vitest";
import { stopDaemon, STATE_FILE, type DaemonState, type LifecycleDeps } from "../src/daemon-lifecycle.js";

const STATE: DaemonState = {
  pid: 555,
  port: 7433,
  host: "127.0.0.1",
  db: "openrig.sqlite",
  startedAt: "2026-01-01T00:00:00Z",
};

function cleanReceipt(pid: number): string {
  return JSON.stringify({
    schema: "openrig.daemon-shutdown/v1",
    pid,
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    outcome: "clean",
    phase: "complete",
    failures: [],
  });
}

function deps(overrides: Partial<LifecycleDeps> = {}): LifecycleDeps {
  return {
    spawn: vi.fn(),
    // healthz: first probe answers (daemon up), then refuses (daemon gone).
    fetch: vi.fn()
      .mockResolvedValueOnce({ ok: true })
      .mockRejectedValue(Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } })),
    kill: vi.fn(() => true),
    exists: vi.fn((p: string) => p === STATE_FILE),
    readFile: vi.fn((p: string) =>
      p === STATE_FILE ? JSON.stringify(STATE) : p.endsWith("daemon-shutdown.json") ? cleanReceipt(555) : null),
    writeFile: vi.fn(),
    removeFile: vi.fn(),
    openForAppend: vi.fn(() => 1),
    closeFile: vi.fn(),
    isProcessAlive: vi.fn().mockReturnValueOnce(true).mockReturnValue(false),
    listDir: vi.fn(() => []),
    ...overrides,
  } as unknown as LifecycleDeps;
}

describe("stopDaemon graceful shutdown", () => {
  it("POSTs /api/shutdown and does NOT signal when the daemon accepts", async () => {
    const post = vi.fn(async () => ({ ok: true }));
    const d = deps({ post });

    await stopDaemon(d);

    expect(post).toHaveBeenCalledWith("http://127.0.0.1:7433/api/shutdown");
    expect(d.kill).not.toHaveBeenCalled();
  });

  it("falls back to SIGTERM when the daemon refuses the request", async () => {
    const post = vi.fn(async () => ({ ok: false }));
    const d = deps({ post });

    await stopDaemon(d);

    expect(post).toHaveBeenCalled();
    expect(d.kill).toHaveBeenCalledWith(555, "SIGTERM");
  });

  it("falls back to SIGTERM when the request throws", async () => {
    const post = vi.fn(async () => { throw new Error("connection refused"); });
    const d = deps({ post });

    await stopDaemon(d);

    expect(d.kill).toHaveBeenCalledWith(555, "SIGTERM");
  });

  it("escalates to SIGTERM when an accepted drain does not actually exit", async () => {
    const post = vi.fn(async () => ({ ok: true }));
    // The daemon accepts the drain but never goes away, so it stays alive for
    // the whole graceful window and only dies once the signal lands. This is
    // the case the escalation exists for: an accepted drain is not an exit.
    let signalled = false;
    const kill = vi.fn(() => { signalled = true; return true; });
    const isProcessAlive = vi.fn(() => !signalled);
    const d = deps({ post, kill, isProcessAlive });

    await stopDaemon(d).catch(() => {});

    expect(post).toHaveBeenCalled();
    expect(kill).toHaveBeenCalledWith(555, "SIGTERM");
  }, 40000);

  it("uses the signal path unchanged when the backend cannot POST", async () => {
    const d = deps(); // no `post` dep at all

    await stopDaemon(d);

    expect(d.kill).toHaveBeenCalledWith(555, "SIGTERM");
  });
});
