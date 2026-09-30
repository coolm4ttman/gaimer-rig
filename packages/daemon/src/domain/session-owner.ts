import type Database from "better-sqlite3";

export interface SessionOwnerRow {
  node_id: string;
  logical_id: string;
  rig_name: string;
}

/**
 * The OTHER managed node that currently owns a tmux session name, if any: a node whose binding names
 * it, or a node with a live (not superseded, detached or exited) session row under it. A session name
 * can be shared across rigs, for example by an archived duplicate of a live rig, so the name alone
 * never proves which node a session belongs to.
 */
export function findOtherSessionOwner(db: Database.Database, tmuxSession: string, nodeId: string): SessionOwnerRow | null {
  const bindingOwner = db.prepare(`
    SELECT n.id AS node_id, n.logical_id, r.name AS rig_name
    FROM bindings b
    JOIN nodes n ON n.id = b.node_id
    JOIN rigs r ON r.id = n.rig_id
    WHERE b.tmux_session = ? AND n.id != ?
    LIMIT 1
  `).get(tmuxSession, nodeId) as SessionOwnerRow | undefined;
  if (bindingOwner) return bindingOwner;

  return db.prepare(`
    SELECT n.id AS node_id, n.logical_id, r.name AS rig_name
    FROM sessions s
    JOIN nodes n ON n.id = s.node_id
    JOIN rigs r ON r.id = n.rig_id
    WHERE s.session_name = ? AND n.id != ? AND s.status NOT IN ('superseded', 'detached', 'exited')
    LIMIT 1
  `).get(tmuxSession, nodeId) as SessionOwnerRow | undefined ?? null;
}
