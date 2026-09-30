// GAIMER.RIG.CONPTY.2 — ConPtyBackend behaviour against a REAL pty.
//
// The pty-backed cases are the point: a mocked pty would not prove that the
// headless emulator actually reconstructs a screen from ConPTY's byte stream,
// which is the whole reason this backend exists. They are skipped off Windows.

import { describe, it, expect, afterAll } from "vitest";
import { ConPtyBackend, encodeKey } from "../src/adapters/conpty/conpty-backend.js";

const onWindows = process.platform === "win32";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("encodeKey", () => {
  it("maps the submit keys to CR", () => {
    expect(encodeKey("Enter")).toBe("\r");
    expect(encodeKey("C-m")).toBe("\r");
  });

  it("maps control letters to control codes", () => {
    expect(encodeKey("C-c")).toBe("");
    expect(encodeKey("C-d")).toBe("");
    expect(encodeKey("C-a")).toBe("");
  });

  it("maps navigation and editing keys", () => {
    expect(encodeKey("Up")).toBe("[A");
    expect(encodeKey("Down")).toBe("[B");
    expect(encodeKey("Tab")).toBe("\t");
    expect(encodeKey("BSpace")).toBe("");
    expect(encodeKey("Escape")).toBe("");
  });

  it("prefixes meta keys with ESC", () => {
    expect(encodeKey("M-b")).toBe("b");
  });

  it("passes unknown keys through as literal text", () => {
    // The daemon really does call sendKeys(target, ["3"]).
    expect(encodeKey("3")).toBe("3");
    expect(encodeKey("")).toBe("");
  });
});

describe.runIf(onWindows)("ConPtyBackend (real pty)", () => {
  const backend = new ConPtyBackend();
  const NAME = "gaimer-conpty-test";
  let paneId = "";

  afterAll(async () => {
    await backend.killSession(NAME).catch(() => {});
  });

  it("starts without a server process", async () => {
    expect((await backend.startServer()).ok).toBe(true);
  });

  it("creates a session and refuses a duplicate", async () => {
    expect(await backend.hasSession(NAME)).toBe(false);
    const created = await backend.createSession(NAME, process.cwd(), { GAIMER_SMOKE: "1" });
    expect(created.ok).toBe(true);
    expect(await backend.hasSession(NAME)).toBe(true);

    const dup = await backend.createSession(NAME);
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.code).toBe("duplicate_session");
  });

  it("exposes exactly one tmux-shaped pane, addressable by name or id", async () => {
    const panes = await backend.listPanes(NAME);
    expect(panes).toHaveLength(1);
    paneId = panes[0]!.id;
    expect(paneId).toMatch(/^%\d+$/);
    // Callers use name and pane id interchangeably as a target.
    expect(await backend.hasSession(paneId)).toBe(true);
  });

  it("reports presence positively and absence positively", async () => {
    expect((await backend.probeSession(NAME)).state).toBe("present");
    expect((await backend.probeSession("no-such-session")).state).toBe("absent");
  });

  it("reports the pty pid and the injected env", async () => {
    const pid = await backend.getPanePid(paneId);
    expect(typeof pid).toBe("number");
    expect(pid!).toBeGreaterThan(0);
    expect(await backend.hasSessionEnv(NAME, "GAIMER_SMOKE")).toBe(true);
    expect(await backend.hasSessionEnv(NAME, "DEFINITELY_NOT_SET")).toBe(false);
  });

  it("reconstructs the screen: an echoed marker comes back from the buffer", async () => {
    await sleep(2500); // shell prompt
    const marker = `GAIMER_MARKER_${Date.now()}`;
    const sent = await backend.sendShellCommand(NAME, `echo ${marker}`);
    expect(sent.ok).toBe(true);
    await sleep(2500);

    const content = await backend.capturePaneContent(paneId, 80);
    expect(content).toBeTruthy();
    expect(content!).toContain(marker);
  }, 20000);

  it("captures a full-height screen and a cursor with pane geometry", async () => {
    const screen = await backend.capturePaneScreen(paneId);
    expect(screen!.split("\n")).toHaveLength(27);

    const cursor = await backend.getPaneCursorPosition(paneId);
    expect(cursor).toMatchObject({ width: 90, height: 27 });
    expect(cursor!.x).toBeGreaterThanOrEqual(0);
    expect(cursor!.y).toBeGreaterThanOrEqual(0);
  });

  it("identifies what is running in the pane", async () => {
    const cmd = await backend.getPaneCommand(paneId);
    expect(cmd).toBeTruthy();
    // A bare session should be sitting at a shell.
    expect(cmd!.toLowerCase()).toMatch(/pwsh|powershell|cmd/);
  }, 20000);

  it("tracks last activity as a unix timestamp", async () => {
    const at = await backend.readPaneLastActivity(paneId);
    expect(at!).toBeGreaterThan(1_700_000_000);
  });

  it("resizes the pty and the emulator together", async () => {
    expect((await backend.resizeWindow(NAME, 100, 30)).ok).toBe(true);
    const cursor = await backend.getPaneCursorPosition(paneId);
    expect(cursor).not.toBeNull();
    await backend.resizeWindow(NAME, 90, 27);
  });

  it("degrades tmux-only surfaces honestly, never silently", async () => {
    const sc = await backend.switchClient("client", "target");
    expect(sc.ok).toBe(false);
    if (!sc.ok) expect(sc.code).toBe("unsupported_by_backend");

    expect(await backend.listClients()).toEqual([]);

    expect((await backend.setServerOption("k", "v")).ok).toBe(true);
    expect(await backend.showServerOption("k")).toBe("v");
    expect(await backend.showServerOption("never-set")).toBeNull();
  });

  it("refuses writes to an unknown target with session_not_found", async () => {
    const r = await backend.sendText("ghost-session", "hello");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("session_not_found");
  });

  it("kills the session and forgets it", async () => {
    expect(await backend.isPaneDead(paneId)).toBe(false);
    expect((await backend.killSession(NAME)).ok).toBe(true);
    expect(await backend.hasSession(NAME)).toBe(false);
    expect(await backend.listSessions()).toEqual([]);
  });
});

describe.runIf(process.platform === "win32")("ConPtyBackend + broker live stream", () => {
  it("carries real pty bytes to a subscriber with no pipe-pane file", async () => {
    const { TerminalSessionBroker } = await import("../src/terminal/TerminalSessionBroker.js");
    const backend = new ConPtyBackend();
    const NAME = "gaimer-conpty-stream-test";

    expect((await backend.createSession(NAME, process.cwd())).ok).toBe(true);
    try {
      const received: string[] = [];
      const broker = new TerminalSessionBroker(NAME, backend as never);
      await broker.attach({
        send: (d: string) => received.push(d),
        close: () => {},
      });

      await new Promise((r) => setTimeout(r, 2000)); // shell prompt
      const marker = `GAIMER_STREAM_${Date.now()}`;
      await backend.sendShellCommand(NAME, `echo ${marker}`);
      await new Promise((r) => setTimeout(r, 2500));

      // The bytes reached the viewer through the live subscription, and no
      // pipe-pane temp file was ever created for this session.
      expect(received.join("")).toContain(marker);
      broker.dispose();
    } finally {
      await backend.killSession(NAME);
    }
  }, 25000);
});
