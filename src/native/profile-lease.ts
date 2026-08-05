import { chmodSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * A process lease backed by SQLite's cross-process file lock. Unlike a PID or
 * mkdir lock, the operating system releases it when the process crashes, so no
 * unsafe stale-lock deletion or platform-specific liveness probing is needed.
 */
export class NativeProfileLease {
  readonly path: string;
  #database: DatabaseSync | undefined;

  private constructor(path: string, database: DatabaseSync) {
    this.path = path;
    this.#database = database;
  }

  static acquire(stateDir: string): NativeProfileLease {
    const path = join(stateDir, ".iblue-native-lease.sqlite");
    const database = new DatabaseSync(path);
    try {
      database.exec("PRAGMA busy_timeout=0; PRAGMA journal_mode=DELETE;");
      database.exec(`
        CREATE TABLE IF NOT EXISTS lease_metadata (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          pid INTEGER NOT NULL,
          acquired_at TEXT NOT NULL
        );
      `);
      // EXCLUSIVE is intentional: only one native APNs/IDS process may read or
      // mutate a profile's transport state at a time.
      database.exec("BEGIN EXCLUSIVE;");
      database.prepare(`
        INSERT INTO lease_metadata (singleton, pid, acquired_at)
        VALUES (1, ?, ?)
        ON CONFLICT(singleton) DO UPDATE SET
          pid=excluded.pid,
          acquired_at=excluded.acquired_at
      `).run(process.pid, new Date().toISOString());
      try {
        chmodSync(path, 0o600);
        chmodSync(`${path}-journal`, 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      return new NativeProfileLease(path, database);
    } catch (error) {
      try {
        database.close();
      } catch {
        // Keep the original acquisition error.
      }
      if (isSqliteBusy(error)) {
        throw new Error(
          `profile native state is already in use by another iBlue process (${stateDir}); ` +
          "stop that profile's server or command before continuing",
        );
      }
      throw error;
    }
  }

  release(): void {
    const database = this.#database;
    if (!database) return;
    this.#database = undefined;
    try {
      database.exec("ROLLBACK;");
    } finally {
      database.close();
    }
  }
}

function isSqliteBusy(error: unknown): boolean {
  const candidate = error as { code?: string; errcode?: number; message?: string };
  return candidate.code === "ERR_SQLITE_ERROR" && (
    candidate.errcode === 5 || /database is locked|database is busy/i.test(candidate.message ?? "")
  );
}
