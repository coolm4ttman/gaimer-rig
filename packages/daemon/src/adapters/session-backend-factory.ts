// GAIMER.RIG.CONPTY.3 — the one place a session transport is chosen.
//
// Every other consumer is typed against SessionBackend and never learns which
// implementation it holds. Keeping the decision here means adding a future
// backend touches this file and nothing else.

import { TmuxAdapter, type ExecFn } from "./tmux.js";
import { execCommand } from "./tmux-exec.js";
import { ConPtyBackend } from "./conpty/conpty-backend.js";
import type { BackendKind, SessionBackend } from "./session-backend.js";

export interface SessionBackendOptions {
  /** Force a backend regardless of platform. Used by tests and by an operator
   *  who is running tmux under WSL2 on Windows and wants it addressed directly. */
  kind?: BackendKind;
  /** Command runner for the tmux backend. Ignored by ConPTY. */
  exec?: ExecFn;
}

/**
 * Resolve which transport to use.
 *
 * Windows has no tmux, so ConPTY is the only native option there. Everywhere
 * else tmux remains the default: it is what upstream tests and operators
 * expect, and it keeps merges from upstream behaving identically.
 *
 * `OPENRIG_SESSION_BACKEND=tmux|conpty` overrides, so a Windows user running
 * the daemon inside WSL2 can still get tmux without a code change.
 */
export function resolveSessionBackendKind(options: SessionBackendOptions = {}): BackendKind {
  if (options.kind) return options.kind;

  const env = process.env.OPENRIG_SESSION_BACKEND?.trim().toLowerCase();
  if (env === "tmux" || env === "conpty") return env;

  // An EXPLICITLY injected tmux command runner means the caller wants tmux:
  // the daemon's tests inject a fake tmux and assert on the commands it
  // receives, and an operator may point a Windows daemon at a tmux running
  // under WSL2. Honouring the injection keeps both working without a flag.
  if (options.exec) return "tmux";

  return process.platform === "win32" ? "conpty" : "tmux";
}

export function createSessionBackend(options: SessionBackendOptions = {}): SessionBackend {
  const kind = resolveSessionBackendKind(options);
  return kind === "conpty"
    ? new ConPtyBackend()
    : new TmuxAdapter(options.exec ?? execCommand);
}
