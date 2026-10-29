import test from "node:test";
import assert from "node:assert/strict";
import { BrowserSessionStore, IDLE_TIMEOUT_MS } from "../src/browser-session-core.mjs";

function coordinator() {
  const state = { session_id: null, launch_until: null, alarm: null };
  const sql = {
    exec(statement, ...values) {
      if (statement.startsWith("SELECT")) return { one: () => ({ ...state }) };
      if (statement.includes("SET launch_until = ?")) state.launch_until = values[0];
      else if (statement.includes("SET session_id = ?, launch_until = NULL")) {
        [state.session_id] = values;
        state.launch_until = null;
      } else if (statement.includes("SET launch_until = NULL") && statement.includes("session_id IS NULL")) {
        state.launch_until = null;
      } else if (statement.includes("SET session_id = NULL") && statement.includes("session_id = ?")) {
        if (state.session_id === values[0]) state.session_id = null;
      } else if (statement.includes("SET session_id = NULL, launch_until = NULL")) {
        state.session_id = null;
        state.launch_until = null;
      }
      return { one: () => ({ ...state }) };
    },
  };
  const ctx = { storage: { sql, setAlarm: async (time) => { state.alarm = time; } } };
  return { coordinator: new BrowserSessionStore(ctx), state };
}

test("coordinates first launch and keeps only an app-owned session ID", async () => {
  const { coordinator: sessions, state } = coordinator();
  assert.deepEqual(await sessions.claim(), { launch: true });
  assert.deepEqual(await sessions.claim(), { waiting: true });
  await sessions.register("only-this-app-session");
  assert.deepEqual(await sessions.claim(), { sessionId: "only-this-app-session" });
  assert.equal(state.alarm > Date.now(), true);
  assert.equal(state.alarm - Date.now() <= IDLE_TIMEOUT_MS, true);
  sessions.forget("different-session");
  assert.deepEqual(await sessions.claim(), { sessionId: "only-this-app-session" });
});

test("clears the session reference on its idle alarm and reopens the launch claim", async () => {
  const { coordinator: sessions, state } = coordinator();
  await sessions.claim();
  await sessions.register("only-this-app-session");
  await sessions.alarm();
  assert.equal(state.session_id, null);
  assert.deepEqual(await sessions.claim(), { launch: true });
});

test("rejects malformed session identifiers", async () => {
  const { coordinator: sessions } = coordinator();
  assert.throws(() => sessions.register(42), /Invalid browser session/);
});
