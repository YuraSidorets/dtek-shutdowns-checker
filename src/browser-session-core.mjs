const IDLE_TIMEOUT_MS = 30_000;
const LAUNCH_LEASE_MS = 25_000;

export class BrowserSessionStore {
  constructor(ctx) {
    this.ctx = ctx;
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS browser_session (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      session_id TEXT,
      launch_until INTEGER
    )`);
    this.sql.exec("INSERT OR IGNORE INTO browser_session (singleton, session_id, launch_until) VALUES (1, NULL, NULL)");
  }

  async claim() {
    const now = Date.now();
    const row = this.sql.exec("SELECT session_id, launch_until FROM browser_session WHERE singleton = 1").one();
    if (row.session_id) {
      await this.ctx.storage.setAlarm(now + IDLE_TIMEOUT_MS);
      return { sessionId: row.session_id };
    }
    if (row.launch_until && row.launch_until > now) return { waiting: true };
    this.sql.exec("UPDATE browser_session SET launch_until = ? WHERE singleton = 1", now + LAUNCH_LEASE_MS);
    return { launch: true };
  }

  register(sessionId) {
    if (typeof sessionId !== "string" || sessionId.length < 1 || sessionId.length > 256) {
      throw new TypeError("Invalid browser session identifier.");
    }
    this.sql.exec("UPDATE browser_session SET session_id = ?, launch_until = NULL WHERE singleton = 1", sessionId);
    return this.ctx.storage.setAlarm(Date.now() + IDLE_TIMEOUT_MS);
  }

  async touch(sessionId) {
    const row = this.sql.exec("SELECT session_id FROM browser_session WHERE singleton = 1").one();
    if (row.session_id === sessionId) await this.ctx.storage.setAlarm(Date.now() + IDLE_TIMEOUT_MS);
  }

  releaseLaunch() {
    this.sql.exec("UPDATE browser_session SET launch_until = NULL WHERE singleton = 1 AND session_id IS NULL");
  }

  forget(sessionId) {
    this.sql.exec("UPDATE browser_session SET session_id = NULL WHERE singleton = 1 AND session_id = ?", sessionId);
  }

  async alarm() {
    this.sql.exec("UPDATE browser_session SET session_id = NULL, launch_until = NULL WHERE singleton = 1");
  }
}

export { IDLE_TIMEOUT_MS, LAUNCH_LEASE_MS };
