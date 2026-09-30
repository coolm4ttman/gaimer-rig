// GAIMER.RIG.CONPTY.4 — the live-stream path of TerminalSessionBroker.
//
// The point of this slice is that a ConPTY-backed session needs neither the
// pipe-pane temp file nor the 50ms tail: a pty already IS the byte stream.
// These tests assert exactly that, and that the tmux path is untouched.

import { describe, it, expect, vi } from "vitest";
import { TerminalSessionBroker, type BrokerTmux, type TerminalSubscriber } from "../src/terminal/TerminalSessionBroker.js";

const ok = { ok: true } as const;

function baseTmux(): BrokerTmux {
  return {
    hasSession: vi.fn(async () => true),
    setWindowOption: vi.fn(async () => ok),
    resizeWindow: vi.fn(async () => ok),
    startPipePane: vi.fn(async () => ok),
    stopPipePane: vi.fn(async () => ok),
    sendKeys: vi.fn(async () => ok),
    sendText: vi.fn(async () => ok),
    capturePaneScreen: vi.fn(async () => ""),
    getPaneCursorPosition: vi.fn(async () => ({ x: 0, y: 0, width: 90, height: 27 })),
    capturePaneContent: vi.fn(async () => ""),
  };
}

function subscriber(): TerminalSubscriber & { data: string[]; closed: Array<[number, string]> } {
  const data: string[] = [];
  const closed: Array<[number, string]> = [];
  return {
    data,
    closed,
    send: (d: string) => data.push(d),
    close: (code: number, reason: string) => closed.push([code, reason]),
  };
}

describe("TerminalSessionBroker live-stream path", () => {
  it("subscribes to the backend stream and never opens a pipe-pane", async () => {
    let emit: ((chunk: string) => void) | null = null;
    const unsubscribe = vi.fn();
    const tmux = baseTmux();
    tmux.subscribeOutput = vi.fn((_name, onData) => {
      emit = onData;
      return unsubscribe;
    });

    const broker = new TerminalSessionBroker("seat@rig", tmux);
    const sub = subscriber();
    await broker.attach(sub);

    // The whole point: no file mirror was ever requested.
    expect(tmux.startPipePane).not.toHaveBeenCalled();
    expect(tmux.subscribeOutput).toHaveBeenCalledWith("seat@rig", expect.any(Function));

    emit!("hello from the pty");
    expect(sub.data.join("")).toContain("hello from the pty");

    broker.dispose();
    expect(unsubscribe).toHaveBeenCalled();
  });

  it("fans one stream out to every subscriber", async () => {
    let emit: ((chunk: string) => void) | null = null;
    const tmux = baseTmux();
    tmux.subscribeOutput = vi.fn((_name, onData) => { emit = onData; return () => {}; });

    const broker = new TerminalSessionBroker("seat@rig", tmux);
    const a = subscriber();
    const b = subscriber();
    await broker.attach(a);
    await broker.attach(b);

    // ONE subscription for the session, regardless of viewer count.
    expect(tmux.subscribeOutput).toHaveBeenCalledTimes(1);

    emit!("shared output");
    expect(a.data.join("")).toContain("shared output");
    expect(b.data.join("")).toContain("shared output");

    broker.dispose();
  });

  it("stops delivering after dispose", async () => {
    let emit: ((chunk: string) => void) | null = null;
    let live = true;
    const tmux = baseTmux();
    tmux.subscribeOutput = vi.fn((_name, onData) => {
      emit = (chunk) => { if (live) onData(chunk); };
      return () => { live = false; };
    });

    const broker = new TerminalSessionBroker("seat@rig", tmux);
    const sub = subscriber();
    await broker.attach(sub);
    broker.dispose();

    const before = sub.data.length;
    emit!("after teardown");
    expect(sub.data.length).toBe(before);
  });

  it("still uses pipe-pane when the backend cannot stream (tmux unchanged)", async () => {
    const tmux = baseTmux(); // no subscribeOutput
    const broker = new TerminalSessionBroker("seat@rig", tmux);
    const sub = subscriber();
    await broker.attach(sub);

    expect(tmux.startPipePane).toHaveBeenCalled();

    broker.dispose();
  });
});
