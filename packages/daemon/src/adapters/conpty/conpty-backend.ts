// GAIMER.RIG.CONPTY.2 — the native-Windows SessionBackend.
//
// Upstream OpenRig reaches the terminal by shelling out to tmux, which does not
// exist on Windows. This backend replaces that transport with a real pty
// (node-pty over Windows ConPTY) plus a headless terminal emulator.
//
// The single most important structural difference from tmux: tmux keeps a
// screen buffer SERVER-SIDE, so `capture-pane` can be a query. A raw pty hands
// you an undifferentiated byte stream and nothing else. So this backend runs an
// @xterm/headless Terminal per session and feeds every pty byte through it;
// that emulator IS the pane, and capture/cursor reads come off its buffer.
// Without it, `capturePaneContent` could only ever return raw bytes with escape
// sequences still in them, which is not what the callers parse.
//
// Fidelity notes, tier by tier (see session-backend.ts for the tiering):
//   Tier 1/2 are implemented for real.
//   Tier 3 (tmux clients, server options, pipe-pane) has no ConPTY analogue.
//     Those degrade to an explicit `unsupported_by_backend` result or a
//     documented in-memory shim — never a silent lie, matching upstream's
//     "NO LIVE TERMINAL LIES" invariant.
//
// Model: one pty == one session == one pane. OpenRig seats are one agent per
// session, so tmux's session>window>pane tree collapses cleanly; pane ids are
// minted in tmux's `%N` shape because callers treat them as opaque strings.

import { spawn as ptySpawn, type IPty } from "node-pty";
// @xterm/headless ships no "exports" map and its "main" is CJS
// (lib-headless/xterm-headless.js), so under plain Node ESM a named import
// fails at load with "does not provide an export named 'Terminal'". Vitest's
// transform hides this, so it only shows up when the real daemon boots.
// Take the CJS default and destructure instead.
import headless from "@xterm/headless";

const { Terminal } = headless;
type Terminal = InstanceType<typeof Terminal>;
import { createWriteStream, type WriteStream } from "node:fs";
import { exec } from "node:child_process";
import { promisify } from "node:util";

import {
  DeliveryGuardError,
  type SeatDeliveryGuard,
} from "../../domain/seat-delivery-guard.js";
import {
  unsupportedByBackend,
  type BackendClient,
  type BackendPane,
  type BackendSession,
  type BackendWindow,
  type CursorPosition,
  type SessionBackend,
  type SessionProbe,
  type SessionResult,
} from "../session-backend.js";

const execAsync = promisify(exec);

/** Canonical pane geometry. MUST stay in sync with TerminalSessionBroker's
 *  CANONICAL_COLS/ROWS — the live-terminal mirror asserts the grids match. */
export const CONPTY_COLS = 90;
export const CONPTY_ROWS = 27;

/** Scrollback the emulator retains, in lines. capturePaneContent reads from it. */
const SCROLLBACK = 5000;

/** getPaneCommand is called ~24x across the daemon and each miss costs a full
 *  process-table query, so results are cached for this long. Short enough that a
 *  harness launch is observed promptly, long enough to survive a polling burst. */
const PANE_COMMAND_TTL_MS = 1500;

/** Shells that mean "no harness is running here" — mirrors upstream's list. */
const SHELL_COMMANDS = new Set([
  "bash", "bash.exe", "cmd", "cmd.exe", "fish", "nu", "nu.exe",
  "powershell", "powershell.exe", "pwsh", "pwsh.exe", "sh", "zsh",
]);

interface ConPtySession {
  name: string;
  paneId: string;
  pty: IPty;
  term: Terminal;
  cwd: string;
  env: Record<string, string>;
  createdAt: number;
  lastActivity: number;
  exited: boolean;
  exitCode: number | null;
  /** remain-on-exit semantics: keep the session addressable after the process
   *  dies so a successor can respawn into it, holding its scrollback. */
  remainOnExit: boolean;
  pipe?: { path: string; stream: WriteStream };
  options: Map<string, string>;
}

export interface ConPtyBackendDeps {
  /** Injected for tests; defaults to node-pty. */
  spawn?: typeof ptySpawn;
  /** Injected for tests; defaults to child_process.exec for process-tree reads. */
  execFn?: (cmd: string) => Promise<string>;
  cols?: number;
  rows?: number;
}

export class ConPtyBackend implements SessionBackend {
  readonly runtime = "conpty";

  /** Misdelivery protection. Assigned by the composition root, exactly as on
   *  TmuxAdapter. Honoured by guardedInput below on every write path — a
   *  backend that merely exposed the field without enforcing it would be
   *  silently less safe than tmux. */
  deliveryGuard?: SeatDeliveryGuard;

  private readonly sessions = new Map<string, ConPtySession>();
  private readonly panesById = new Map<string, ConPtySession>();
  private readonly serverOptions = new Map<string, string>();
  private readonly freshManaged = new Set<string>();
  private paneCounter = 0;

  private paneCommandCache: { at: number; tree: Map<number, { name: string; ppid: number }> } | null = null;

  private readonly spawn: typeof ptySpawn;
  private readonly execFn: (cmd: string) => Promise<string>;
  private readonly cols: number;
  private readonly rows: number;

  constructor(deps: ConPtyBackendDeps = {}) {
    this.spawn = deps.spawn ?? ptySpawn;
    this.execFn = deps.execFn ?? (async (cmd) => (await execAsync(cmd)).stdout);
    this.cols = deps.cols ?? CONPTY_COLS;
    this.rows = deps.rows ?? CONPTY_ROWS;
  }

  // ── resolution ────────────────────────────────────────────────────────────

  /** Callers address sessions by name OR pane id interchangeably (tmux allows
   *  both as a `-t` target), so every lookup accepts either. */
  private resolve(target: string): ConPtySession | undefined {
    return this.sessions.get(target) ?? this.panesById.get(target);
  }

  private notFound(target: string): SessionResult {
    return { ok: false, code: "session_not_found", message: `no session or pane: ${target}` };
  }

  /**
   * Mirrors TmuxAdapter.guardedInput. Serializes the write through the guard's
   * per-node lane, re-resolves the bound target AFTER the async wait, and
   * refuses if the pane identity moved underneath us. The write always targets
   * the immutable pane id, never a session name, which could be recycled.
   */
  private async guardedInput(
    target: string,
    write: (pane: string, beforeWrite: () => void) => Promise<SessionResult>,
  ): Promise<SessionResult> {
    const guard = this.deliveryGuard;
    const session = this.resolve(target);
    if (!session) return this.notFound(target);
    if (!guard) return write(session.paneId, () => {});

    try {
      const created = this.freshManaged.has(session.name);
      const bound = guard.target(target);
      const identity = bound.nodeId;
      return await guard.input(identity, async () => {
        // Re-resolve after the wait: a fresh managed pane owns its own identity
        // until the binding is committed, otherwise the guard's bound pane wins.
        const current = this.resolve(target);
        if (!current || current.exited) {
          throw new DeliveryGuardError("guard_target_unknown", "Managed pane is gone; no input written.");
        }
        const expected = created && guard.ownsLifecycle(bound.nodeId) ? current.paneId : bound.pane;
        if (!expected || expected !== current.paneId) {
          throw new DeliveryGuardError(
            "guard_target_unknown",
            "Managed pane identity unavailable or changed; no input written.",
          );
        }
        return write(current.paneId, () => guard.checkInput(identity));
      });
    } catch (error) {
      return {
        ok: false,
        code: (error as { code?: string }).code ?? "guard_target_unknown",
        message: String((error as Error).message),
      };
    }
  }

  humanInput<T>(target: string, fn: () => Promise<T>): Promise<T> {
    return this.deliveryGuard ? this.deliveryGuard.humanInput(target, fn) : fn();
  }

  operation<T>(target: string, fn: () => Promise<T>): Promise<T> {
    return this.deliveryGuard ? this.deliveryGuard.operation(target, fn) : fn();
  }

  // ── Tier 1: lifecycle ─────────────────────────────────────────────────────

  async startServer(): Promise<SessionResult> {
    // ConPTY has no daemon to start; ptys are per-process children.
    return { ok: true };
  }

  async createSession(
    name: string,
    cwd?: string,
    env?: Record<string, string>,
  ): Promise<SessionResult> {
    if (this.sessions.has(name)) {
      return { ok: false, code: "duplicate_session", message: `session exists: ${name}` };
    }
    const shell = (await this.getDefaultShell()) ?? "powershell.exe";
    const resolvedCwd = cwd ?? process.cwd();
    const mergedEnv = { ...(process.env as Record<string, string>), ...(env ?? {}) };
    const paneId = `%${this.paneCounter++}`;

    let pty: IPty;
    try {
      pty = this.spawn(shell, [], {
        name: "xterm-256color",
        cols: this.cols,
        rows: this.rows,
        cwd: resolvedCwd,
        env: mergedEnv,
        useConpty: true,
      });
    } catch (err) {
      return { ok: false, code: "spawn_failed", message: err instanceof Error ? err.message : String(err) };
    }

    const term = new Terminal({
      cols: this.cols,
      rows: this.rows,
      scrollback: SCROLLBACK,
      allowProposedApi: true,
    });

    const session: ConPtySession = {
      name, paneId, pty, term,
      cwd: resolvedCwd,
      env: env ?? {},
      createdAt: Date.now(),
      lastActivity: Date.now(),
      exited: false,
      exitCode: null,
      remainOnExit: false,
      options: new Map(),
    };

    pty.onData((data) => {
      session.lastActivity = Date.now();
      term.write(data);
      // pipe-pane equivalent: tee the live stream straight to the file. This is
      // strictly better than tmux's pipe-pane + 50ms file polling.
      session.pipe?.stream.write(data);
    });
    pty.onExit(({ exitCode }) => {
      session.exited = true;
      session.exitCode = exitCode ?? null;
      session.lastActivity = Date.now();
      if (!session.remainOnExit) this.dispose(session);
    });

    this.sessions.set(name, session);
    this.panesById.set(paneId, session);
    this.freshManaged.add(name);
    return { ok: true };
  }

  finishLaunchBinding(session: string): void {
    this.freshManaged.delete(session);
  }

  async hasSession(name: string): Promise<boolean> {
    return this.resolve(name) !== undefined;
  }

  async killSession(name: string): Promise<SessionResult> {
    const s = this.resolve(name);
    if (!s) return this.notFound(name);
    try {
      if (!s.exited) s.pty.kill();
    } catch {
      // already gone; disposal below still cleans up our maps
    }
    s.remainOnExit = false;
    this.dispose(s);
    return { ok: true };
  }

  private dispose(s: ConPtySession): void {
    this.sessions.delete(s.name);
    this.panesById.delete(s.paneId);
    this.freshManaged.delete(s.name);
    if (s.pipe) {
      s.pipe.stream.end();
      s.pipe = undefined;
    }
    s.term.dispose();
  }

  async listSessions(): Promise<BackendSession[]> {
    return [...this.sessions.values()].map((s) => ({
      name: s.name,
      windows: 1,
      created: String(Math.floor(s.createdAt / 1000)),
      attached: false, // ConPTY has no attached-client concept; see listClients.
    }));
  }

  // ── Tier 1: input ─────────────────────────────────────────────────────────

  /**
   * Write literal text with NO trailing submit.
   *
   * Two details are load-bearing and were lifted from upstream's tmux sendText:
   *  - BRACKETED PASTE. Agent TUIs (Claude Code / Codex are Ink apps) otherwise
   *    consume a large paste as individual keystrokes and drop characters.
   *  - RAW LF, never CR. In those TUIs CR (= C-m = Enter) is SUBMIT, so
   *    translating newlines would submit on every line of a multi-line pack.
   *    The single trailing submit stays the caller's separate sendKeys(["C-m"]).
   */
  async sendText(target: string, text: string): Promise<SessionResult> {
    return this.guardedInput(target, (pane, beforeWrite) =>
      this.sendTextUnchecked(pane, text, beforeWrite));
  }

  private async sendTextUnchecked(
    pane: string,
    text: string,
    beforeWrite: () => void,
  ): Promise<SessionResult> {
    const s = this.resolve(pane);
    if (!s) return this.notFound(pane);
    if (s.exited) return { ok: false, code: "pane_dead", message: `pane exited: ${pane}` };
    const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    try {
      beforeWrite();
      s.pty.write(`[200~${normalized}[201~`);
      return { ok: true };
    } catch (err) {
      return { ok: false, code: "write_failed", message: err instanceof Error ? err.message : String(err) };
    }
  }

  async sendKeys(target: string, keys: string[]): Promise<SessionResult> {
    return this.guardedInput(target, (pane, beforeWrite) =>
      this.sendKeysUnchecked(pane, keys, beforeWrite));
  }

  private async sendKeysUnchecked(
    pane: string,
    keys: string[],
    beforeWrite: () => void,
  ): Promise<SessionResult> {
    const s = this.resolve(pane);
    if (!s) return this.notFound(pane);
    if (s.exited) return { ok: false, code: "pane_dead", message: `pane exited: ${pane}` };
    try {
      beforeWrite();
      for (const k of keys) s.pty.write(encodeKey(k));
      return { ok: true };
    } catch (err) {
      return { ok: false, code: "write_failed", message: err instanceof Error ? err.message : String(err) };
    }
  }

  async sendShellCommand(
    target: string,
    command: string,
    beforeInput?: () => void,
  ): Promise<SessionResult> {
    const written = await this.sendText(target, command);
    if (!written.ok) return written;
    beforeInput?.();
    return this.sendKeys(target, ["Enter"]);
  }

  // ── Tier 2: pane observability ────────────────────────────────────────────

  async listWindows(sessionName: string): Promise<BackendWindow[]> {
    const s = this.resolve(sessionName);
    if (!s) return [];
    return [{ index: 0, name: s.name, panes: 1, active: true }];
  }

  async listPanes(target: string): Promise<BackendPane[]> {
    const s = this.resolve(target);
    if (!s) return [];
    return [{
      id: s.paneId, index: 0, cwd: s.cwd,
      width: this.cols, height: this.rows, active: true,
    }];
  }

  async probeSession(name: string): Promise<SessionProbe> {
    // In-process ownership means presence is always positively known; there is
    // no transport that can be unreachable, so `transport_unavailable` can
    // never be honestly returned here.
    return this.resolve(name) ? { state: "present" } : { state: "absent" };
  }

  async getPanePid(paneId: string): Promise<number | null> {
    const s = this.resolve(paneId);
    if (!s || s.exited) return null;
    return s.pty.pid ?? null;
  }

  async isPaneDead(paneId: string): Promise<boolean> {
    const s = this.resolve(paneId);
    return s ? s.exited : false;
  }

  /**
   * What is actually running in the pane — the method the daemon leans on to
   * tell a live harness from a bare shell.
   *
   * tmux answers this from `#{pane_current_command}`. ConPTY has no equivalent,
   * so we walk the Windows process tree down from the pty's pid and return the
   * deepest descendant that is not a shell; if everything below is a shell, we
   * return the shell, which is the honest answer ("nothing is running here").
   */
  async getPaneCommand(paneId: string): Promise<string | null> {
    const s = this.resolve(paneId);
    if (!s || s.exited) return null;
    const rootPid = s.pty.pid;
    if (!rootPid) return null;

    const tree = await this.processTree();
    const children = new Map<number, number[]>();
    for (const [pid, info] of tree) {
      const sibs = children.get(info.ppid);
      if (sibs) sibs.push(pid);
      else children.set(info.ppid, [pid]);
    }

    let best: string | null = tree.get(rootPid)?.name ?? null;
    const walk = (pid: number, depth: number): void => {
      if (depth > 12) return;
      for (const child of children.get(pid) ?? []) {
        const name = tree.get(child)?.name;
        if (name && !SHELL_COMMANDS.has(name.toLowerCase())) best = name;
        walk(child, depth + 1);
      }
    };
    walk(rootPid, 0);
    return best;
  }

  /** One process-table read, shared by every getPaneCommand in the burst. */
  private async processTree(): Promise<Map<number, { name: string; ppid: number }>> {
    const now = Date.now();
    if (this.paneCommandCache && now - this.paneCommandCache.at < PANE_COMMAND_TTL_MS) {
      return this.paneCommandCache.tree;
    }
    const tree = new Map<number, { name: string; ppid: number }>();
    try {
      const out = await this.execFn(
        'powershell -NoProfile -Command "Get-CimInstance Win32_Process | ' +
        'Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Csv -NoTypeInformation"',
      );
      for (const line of out.split(/\r?\n/).slice(1)) {
        const m = line.match(/^"(\d+)","(\d+)","(.*)"$/);
        if (!m) continue;
        tree.set(Number(m[1]), { ppid: Number(m[2]), name: m[3]! });
      }
    } catch {
      // A failed probe must not be reported as "no process"; callers get the
      // stale-or-empty tree and getPaneCommand falls back to null.
    }
    this.paneCommandCache = { at: now, tree };
    return tree;
  }

  async signalPaneProcess(paneId: string, signal: "TERM" | "KILL"): Promise<SessionResult> {
    const s = this.resolve(paneId);
    if (!s) return this.notFound(paneId);
    try {
      // ConPTY has no POSIX signals. TERM maps to the pty's own kill (which
      // closes the console handle and lets the child shut down); KILL escalates
      // to a hard taskkill of the process tree.
      if (signal === "KILL" && s.pty.pid) {
        await this.execFn(`taskkill /PID ${s.pty.pid} /T /F`);
      } else {
        s.pty.kill();
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, code: "signal_failed", message: err instanceof Error ? err.message : String(err) };
    }
  }

  async respawnPane(
    paneTarget: string,
    command?: string,
    opts?: { cwd?: string; env?: Record<string, string> },
  ): Promise<SessionResult> {
    const s = this.resolve(paneTarget);
    if (!s) return this.notFound(paneTarget);
    const name = s.name;
    const cwd = opts?.cwd ?? s.cwd;
    const env = opts?.env ?? s.env;

    s.remainOnExit = false;
    try { if (!s.exited) s.pty.kill(); } catch { /* already dead */ }
    this.dispose(s);

    const created = await this.createSession(name, cwd, env);
    if (!created.ok) return created;
    if (command && command.length > 0) {
      return this.sendShellCommand(name, command);
    }
    return { ok: true };
  }

  async capturePaneContent(paneId: string, lines = 20): Promise<string | null> {
    const s = this.resolve(paneId);
    if (!s) return null;
    const buf = s.term.buffer.active;
    const end = buf.length;
    const start = Math.max(0, end - lines);
    const out: string[] = [];
    for (let i = start; i < end; i++) {
      out.push(buf.getLine(i)?.translateToString(true) ?? "");
    }
    // Trailing blank lines are emulator padding, not content.
    while (out.length && out[out.length - 1]!.trim() === "") out.pop();
    return out.join("\n");
  }

  async capturePaneScreen(paneId: string): Promise<string | null> {
    const s = this.resolve(paneId);
    if (!s) return null;
    const buf = s.term.buffer.active;
    const out: string[] = [];
    for (let y = 0; y < this.rows; y++) {
      out.push(buf.getLine(buf.viewportY + y)?.translateToString(true) ?? "");
    }
    return out.join("\n");
  }

  async getPaneCursorPosition(paneId: string): Promise<CursorPosition | null> {
    const s = this.resolve(paneId);
    if (!s) return null;
    const buf = s.term.buffer.active;
    return { x: buf.cursorX, y: buf.cursorY, width: this.cols, height: this.rows };
  }

  async readPaneLastActivity(paneId: string): Promise<number | null> {
    const s = this.resolve(paneId);
    return s ? Math.floor(s.lastActivity / 1000) : null;
  }

  async resizeWindow(target: string, cols: number, rows: number): Promise<SessionResult> {
    const s = this.resolve(target);
    if (!s) return this.notFound(target);
    try {
      s.pty.resize(cols, rows);
      s.term.resize(cols, rows);
      return { ok: true };
    } catch (err) {
      return { ok: false, code: "resize_failed", message: err instanceof Error ? err.message : String(err) };
    }
  }

  async getDefaultShell(): Promise<string | null> {
    // Prefer PowerShell 7 when present, then Windows PowerShell, then COMSPEC.
    for (const candidate of ["pwsh.exe", "powershell.exe"]) {
      try {
        await this.execFn(`where ${candidate}`);
        return candidate;
      } catch { /* not on PATH; try the next */ }
    }
    return process.env.COMSPEC ?? "cmd.exe";
  }

  async hasSessionEnv(sessionName: string, varName: string): Promise<boolean | null> {
    const s = this.resolve(sessionName);
    if (!s) return null;
    return Object.prototype.hasOwnProperty.call(s.env, varName);
  }

  // ── Tier 3: tmux-server concepts ──────────────────────────────────────────

  async setSessionOption(sessionName: string, key: string, value: string): Promise<SessionResult> {
    const s = this.resolve(sessionName);
    if (!s) return this.notFound(sessionName);
    s.options.set(key, value);
    return { ok: true };
  }

  async getSessionOption(sessionName: string, key: string): Promise<string | null> {
    return this.resolve(sessionName)?.options.get(key) ?? null;
  }

  async setServerOption(option: string, value: string): Promise<SessionResult> {
    // No server exists. Stored so showServerOption round-trips honestly rather
    // than reporting a value that was never applied anywhere.
    this.serverOptions.set(option, value);
    return { ok: true };
  }

  async showServerOption(option: string): Promise<string | null> {
    return this.serverOptions.get(option) ?? null;
  }

  async setWindowOption(target: string, option: string, value: string): Promise<SessionResult> {
    return this.setSessionOption(target, `window.${option}`, value);
  }

  /** Real behaviour: keeps the session addressable after its process exits so a
   *  successor can respawn into it. Must be set BEFORE the retiree is signalled. */
  async setRemainOnExit(paneTarget: string, on: boolean): Promise<SessionResult> {
    const s = this.resolve(paneTarget);
    if (!s) return this.notFound(paneTarget);
    s.remainOnExit = on;
    return { ok: true };
  }

  async startPipePane(sessionName: string, outputPath: string): Promise<SessionResult> {
    const s = this.resolve(sessionName);
    if (!s) return this.notFound(sessionName);
    if (s.pipe) s.pipe.stream.end();
    try {
      s.pipe = { path: outputPath, stream: createWriteStream(outputPath, { flags: "a" }) };
      return { ok: true };
    } catch (err) {
      return { ok: false, code: "pipe_failed", message: err instanceof Error ? err.message : String(err) };
    }
  }

  async stopPipePane(sessionName: string): Promise<SessionResult> {
    const s = this.resolve(sessionName);
    if (!s) return this.notFound(sessionName);
    s.pipe?.stream.end();
    s.pipe = undefined;
    return { ok: true };
  }

  /** tmux clients are attached human terminals. ConPTY sessions are owned by
   *  this process and viewed over the web UI, so there is never a client to
   *  report. Empty is the honest answer, not a failure. */
  async listClients(): Promise<BackendClient[]> {
    return [];
  }

  async switchClient(_client: string, _target: string): Promise<SessionResult> {
    return unsupportedByBackend("switchClient", "conpty");
  }

  async createProbeSession(name: string, cwd?: string): Promise<SessionResult> {
    return this.createSession(name, cwd);
  }
}

/**
 * Translate a tmux key name into the bytes a pty expects.
 * The daemon's actual vocabulary is small — Enter, C-m, C-c, C-d, Up, Down,
 * Tab, BSpace, Escape — but the live-terminal WebSocket forwards arbitrary keys
 * from the browser, so generic C-<x>/M-<x> parsing and literal passthrough
 * both matter.
 */
export function encodeKey(key: string): string {
  switch (key) {
    case "Enter": case "C-m": return "\r";
    case "Escape": case "Esc": return "";
    case "Tab": return "\t";
    case "BSpace": case "BackSpace": return "";
    case "Space": return " ";
    case "Up": return "[A";
    case "Down": return "[B";
    case "Right": return "[C";
    case "Left": return "[D";
    case "Home": return "[H";
    case "End": return "[F";
    case "PageUp": return "[5~";
    case "PageDown": return "[6~";
    case "Delete": return "[3~";
    default: break;
  }
  // Ctrl-<letter> -> the matching control code (C-a = 0x01 … C-z = 0x1a).
  const ctrl = /^C-([a-zA-Z])$/.exec(key);
  if (ctrl) {
    return String.fromCharCode(ctrl[1]!.toLowerCase().charCodeAt(0) - 96);
  }
  // Alt-<key> -> ESC prefix.
  const meta = /^M-(.+)$/.exec(key);
  if (meta) return `${encodeKey(meta[1]!)}`;
  // Anything else is literal text (callers do send bare strings like "3").
  return key;
}
