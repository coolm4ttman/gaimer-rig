// GAIMER.RIG.WIN.1 — narrow public surface for the session-transport decision,
// so the CLI's preflight can ask which backend the daemon will actually use
// instead of assuming tmux. Lane rule (see gateway-protocol-surface.ts):
// exports map + dist + cli tsconfig paths, all three.
// Re-export only — no logic here.
export { resolveSessionBackendKind } from "./adapters/session-backend-factory.js";
export type { BackendKind } from "./adapters/session-backend.js";
