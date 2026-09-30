// GAIMER.RIG.CONPTY.1 — the backend-neutral session-transport contract.
//
// Upstream OpenRig types every consumer against the CONCRETE `TmuxAdapter`
// class (49 non-test files in packages/daemon/src). tmux is therefore not a
// swappable detail today: it is the type. This file extracts the contract
// those consumers actually use so a second backend (ConPTY, for native
// Windows) can stand beside it.
//
// DESIGN RULE (GAIMER golden rule — keep upstream merges clean): tmux.ts is
// NOT edited. The types below are re-exported FROM tmux.ts rather than
// redeclared, and `TmuxAdapter` satisfies `SessionBackend` structurally with
// zero changes — asserted by a type-level test, not by an `implements` clause
// added to upstream code. Consumers migrate by changing a type annotation
// (`TmuxAdapter` -> `SessionBackend`), never logic.
//
// FIDELITY TIERS. Method usage was measured across packages/daemon/src by
// call-site count; the tiers reflect what a PTY can honestly provide:
//
//   Tier 1 — CORE (~80% of all call sites). Direct PTY equivalents. Every
//     backend MUST implement these with full fidelity.
//   Tier 2 — OBSERVABILITY. Needs a headless terminal emulator to maintain a
//     screen buffer (tmux keeps one server-side; a raw pty does not) and, for
//     getPaneCommand, OS process-tree inspection.
//   Tier 3 — TMUX-SERVER CONCEPTS. Clients, server options, pipe-pane. These
//     have no ConPTY analogue. They MUST degrade to an explicit, documented
//     no-op or an `unsupported` result — NEVER to a silent lie. This mirrors
//     upstream's own invariant for live terminals ("NO LIVE TERMINAL LIES",
//     TerminalSessionBroker.ts): a backend that cannot answer says so.

import type {
  ExecFn,
  SessionProbe,
  TmuxClient,
  TmuxCursorPosition,
  TmuxFileOps,
  TmuxPane,
  TmuxResult,
  TmuxSession,
  TmuxWindow,
} from "./tmux.js";

// Re-exported under backend-neutral names. The shapes are upstream's; only the
// names lose the tmux prefix, so a ConPTY backend is not forced to speak in
// tmux nouns while remaining wire-compatible with every existing consumer.
export type {
  ExecFn,
  SessionProbe,
  TmuxFileOps as SessionFileOps,
  TmuxResult as SessionResult,
  TmuxSession as BackendSession,
  TmuxWindow as BackendWindow,
  TmuxPane as BackendPane,
  TmuxClient as BackendClient,
  TmuxCursorPosition as CursorPosition,
};

/** Which transport is behind a `SessionBackend`. Surfaced by `rig doctor`. */
export type BackendKind = "tmux" | "conpty";

/**
 * Canonical failure result for a Tier 3 method a backend cannot honour.
 * Distinguishable from a real error: callers can treat `unsupported_by_backend`
 * as "this concept does not exist here" rather than "the transport broke".
 */
export function unsupportedByBackend(method: string, backend: BackendKind): TmuxResult {
  return {
    ok: false,
    code: "unsupported_by_backend",
    message: `${method} is not supported by the ${backend} backend`,
  };
}

export interface SessionBackend {
  // ── Misdelivery protection ────────────────────────────────────────────────
  //
  // Part of the backend contract, NOT a tmux detail: the guard serializes seat
  // input and re-verifies pane identity before any write lands, so a message
  // can never be delivered into the wrong agent's pane. Four consumers read it
  // directly (claim-service, node-launcher, restore-orchestrator,
  // claude-compaction-enforcer). A backend that ignored it would be silently
  // less safe than tmux, so every backend must honour it on its write paths.

  deliveryGuard?: import("../domain/seat-delivery-guard.js").SeatDeliveryGuard;

  /** Explicit internal human input; transport HTTP options cannot select this. */
  humanInput<T>(target: string, fn: () => Promise<T>): Promise<T>;
  operation<T>(target: string, fn: () => Promise<T>): Promise<T>;

  // ── Tier 1: core session lifecycle + input ────────────────────────────────

  /** Ensure the transport is reachable. tmux: start-server. ConPTY: no-op ok. */
  startServer(): Promise<TmuxResult>;
  createSession(name: string, cwd?: string, env?: Record<string, string>): Promise<TmuxResult>;
  hasSession(name: string): Promise<boolean>;
  killSession(name: string): Promise<TmuxResult>;
  listSessions(): Promise<TmuxSession[]>;

  /** Write literal text to the session's active pane. No trailing newline. */
  sendText(target: string, text: string): Promise<TmuxResult>;
  /** Send named keys (`Enter`, `C-m`, `C-c`, `Up`, `BSpace`, …) or literals. */
  sendKeys(target: string, keys: string[]): Promise<TmuxResult>;
  /** Write a shell command plus a submit keypress, guarded by `beforeInput`. */
  sendShellCommand(target: string, command: string, beforeInput?: () => void): Promise<TmuxResult>;

  /** Release a session from the fresh-managed launch fence. */
  finishLaunchBinding(session: string): void;

  // ── Tier 2: pane observability ────────────────────────────────────────────

  listWindows(sessionName: string): Promise<TmuxWindow[]>;
  listPanes(target: string): Promise<TmuxPane[]>;
  probeSession(name: string): Promise<SessionProbe>;

  /**
   * The command currently running in the pane — how upstream decides whether a
   * harness (claude/codex) is actually live versus sitting at a bare shell.
   * 24 call sites: the single most load-bearing observability method.
   * tmux: `#{pane_current_command}`. ConPTY: process-tree walk from the pty pid.
   */
  getPaneCommand(paneId: string): Promise<string | null>;
  getPanePid(paneId: string): Promise<number | null>;
  isPaneDead(paneId: string): Promise<boolean>;
  signalPaneProcess(paneId: string, signal: "TERM" | "KILL"): Promise<TmuxResult>;
  respawnPane(
    paneTarget: string,
    command?: string,
    opts?: { cwd?: string; env?: Record<string, string> },
  ): Promise<TmuxResult>;

  /** Last `lines` rows of scrollback, newest last. Requires a screen buffer. */
  capturePaneContent(paneId: string, lines?: number): Promise<string | null>;
  /** The visible screen exactly as rendered, for the live-terminal seed. */
  capturePaneScreen(paneId: string): Promise<string | null>;
  getPaneCursorPosition(paneId: string): Promise<TmuxCursorPosition | null>;
  readPaneLastActivity(paneId: string): Promise<number | null>;

  resizeWindow(target: string, cols: number, rows: number): Promise<TmuxResult>;
  getDefaultShell(): Promise<string | null>;
  hasSessionEnv(sessionName: string, varName: string): Promise<boolean | null>;

  // ── Tier 3: tmux-server concepts (degrade explicitly) ─────────────────────

  setSessionOption(sessionName: string, key: string, value: string): Promise<TmuxResult>;
  getSessionOption(sessionName: string, key: string): Promise<string | null>;
  setServerOption(option: string, value: string): Promise<TmuxResult>;
  showServerOption(option: string): Promise<string | null>;
  setWindowOption(target: string, option: string, value: string): Promise<TmuxResult>;
  setRemainOnExit(paneTarget: string, on: boolean): Promise<TmuxResult>;

  /** Mirror pane output to a file. ConPTY tees the pty stream directly. */
  startPipePane(sessionName: string, outputPath: string): Promise<TmuxResult>;
  stopPipePane(sessionName: string): Promise<TmuxResult>;

  /**
   * OPTIONAL live-output capability (GAIMER.RIG.CONPTY.4).
   *
   * tmux can only mirror a pane to a FILE, so the live-terminal broker writes
   * a pipe-pane log and polls it every 50ms — that poll is the floor on how
   * live the web terminal can feel, and it burns a stat+read per session per
   * tick. A pty already IS the byte stream, so a ConPTY-backed session can
   * hand bytes straight to the broker with no file and no timer.
   *
   * Optional on purpose: TmuxAdapter does not implement it and is not edited
   * (golden rule). Callers feature-detect and fall back to pipe-pane polling.
   *
   * Returns an unsubscribe function. Implementations MUST tolerate being
   * called for an unknown target (returning a no-op) and MUST stop delivering
   * after unsubscribe.
   */
  subscribeOutput?(target: string, onData: (chunk: string) => void): () => void;

  /** Attached human terminals. No ConPTY analogue — returns []. */
  listClients(): Promise<TmuxClient[]>;
  /** Retarget a human's view. No ConPTY analogue — `unsupported_by_backend`. */
  switchClient(client: string, target: string): Promise<TmuxResult>;

  createProbeSession(name: string, cwd?: string): Promise<TmuxResult>;
}
