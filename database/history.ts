import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { RETENTION_MS, type Activity } from "../lib/protocol";

export class HistoryStore {
  private db: DatabaseSync;

  constructor(path = process.env.SETU_DATABASE ?? "database/setu.sqlite") {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS activity (
        owner TEXT NOT NULL,
        id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        payload TEXT NOT NULL,
        PRIMARY KEY (owner, id)
      );
      CREATE INDEX IF NOT EXISTS activity_age ON activity(created_at);
    `);
    this.cleanup();
  }

  add(owner: string, activity: Activity) {
    this.db
      .prepare("INSERT OR REPLACE INTO activity VALUES (?, ?, ?, ?)")
      .run(owner, activity.id, activity.createdAt, JSON.stringify(activity));
    this.db
      .prepare(
        "DELETE FROM activity WHERE owner = ? AND id NOT IN (SELECT id FROM activity WHERE owner = ? ORDER BY created_at DESC LIMIT 200)",
      )
      .run(owner, owner);
  }

  list(owner: string): Activity[] {
    this.cleanup();
    return this.db
      .prepare(
        "SELECT payload FROM activity WHERE owner = ? ORDER BY created_at DESC LIMIT 200",
      )
      .all(owner)
      .map((row) => JSON.parse(row.payload as string) as Activity);
  }

  clear(owner: string) {
    this.db.prepare("DELETE FROM activity WHERE owner = ?").run(owner);
  }

  cleanup() {
    this.db
      .prepare("DELETE FROM activity WHERE created_at < ?")
      .run(Date.now() - RETENTION_MS);
  }

  close() {
    this.db.close();
  }
}
