// GAIMER.RIG.CONPTY.1 — compile-time conformance guard.
//
// Type-only module: erases completely at runtime, costs nothing at import, and
// fails the BUILD if upstream's TmuxAdapter ever stops satisfying
// SessionBackend. It lives in src/ deliberately — packages/daemon/tsconfig.json
// sets `"exclude": ["dist", "test"]`, so an assertion placed under test/ is
// never typechecked by `tsc` and would be a guard in name only.
//
// If an upstream merge changes a tmux method signature, the error surfaces
// HERE, at the seam, naming the drifted member — instead of at runtime in a
// live seat.

import type { TmuxAdapter } from "./tmux.js";
import type { SessionBackend } from "./session-backend.js";

/** Compiles only while `T` is assignable to `SessionBackend`. */
type AssertSatisfiesBackend<T extends SessionBackend> = T;

export type TmuxAdapterConformsToSessionBackend = AssertSatisfiesBackend<TmuxAdapter>;
