import { DurableObject } from "cloudflare:workers";
import { BrowserSessionStore } from "./browser-session-core.mjs";

export class BrowserSessionCoordinator extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.store = new BrowserSessionStore(ctx);
  }

  claim() { return this.store.claim(); }
  register(sessionId) { return this.store.register(sessionId); }
  touch(sessionId) { return this.store.touch(sessionId); }
  releaseLaunch() { return this.store.releaseLaunch(); }
  forget(sessionId) { return this.store.forget(sessionId); }
  alarm() { return this.store.alarm(); }
}
