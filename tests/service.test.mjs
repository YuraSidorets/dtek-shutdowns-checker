import test from "node:test";
import assert from "node:assert/strict";
import { handleServiceRequest } from "../src/service.mjs";

const GITHUB_ORIGIN = "https://yurasidorets.github.io";
const LOCAL_ORIGIN = "http://127.0.0.1:43187";

function samplePage() {
  const now = new Date();
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Kyiv", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(now).map((part) => [part.type, part.value]));
  const update = `${Number(parts.day)}.${Number(parts.month)}.${parts.year} ${Number(parts.hour)}:${parts.minute}`;
  const group = Object.fromEntries(Array.from({ length: 24 }, (_, i) => [String(i + 1), "yes"]));
  const fact = { update, today: Math.floor(now.getTime() / 1000), data: { [Math.floor(now.getTime() / 1000)]: { "GPV1.1": group } } };
  return `<meta name="ajaxUrl" content="/ua/ajax"><script>DisconSchedule.streets = ["вул. Хрещатик"];
DisconSchedule.preset = {"time_zone":{"1":["00-01","00:00","01:00"]}};
DisconSchedule.fact = ${JSON.stringify(fact)};</script>`;
}

test("allows the GitHub Pages origin on API responses", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(samplePage(), { status: 200 });
  try {
    const response = await handleServiceRequest(new Request("https://lookup.workers.dev/api/streets?q=Хрещат", { headers: { origin: GITHUB_ORIGIN } }));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("access-control-allow-origin"), GITHUB_ORIGIN);
    assert.match(response.headers.get("vary"), /Origin/);
    assert.deepEqual(await response.json(), { streets: ["вул. Хрещатик"] });
  } finally { globalThis.fetch = originalFetch; }
});

test("allows the local preview origin and answers GET preflight", async () => {
  const response = await handleServiceRequest(new Request("https://lookup.workers.dev/api/streets", {
    method: "OPTIONS",
    headers: {
      origin: LOCAL_ORIGIN,
      "access-control-request-method": "GET",
      "access-control-request-headers": "content-type",
    },
  }));
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("access-control-allow-origin"), LOCAL_ORIGIN);
  assert.equal(response.headers.get("access-control-allow-methods"), "GET, OPTIONS");
  assert.equal(response.headers.get("access-control-allow-headers"), "Content-Type");
});

test("does not reflect disallowed origins and does not call upstream", async () => {
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => { called = true; return new Response(samplePage()); };
  try {
    const response = await handleServiceRequest(new Request("https://lookup.workers.dev/api/streets?q=Хрещат", { headers: { origin: "https://evil.example" } }));
    assert.equal(response.status, 403);
    assert.equal(response.headers.get("access-control-allow-origin"), null);
    assert.deepEqual(await response.json(), { error: "Origin is not allowed." });
    assert.equal(called, false);
  } finally { globalThis.fetch = originalFetch; }
});

test("returns CORS headers on upstream errors for an allowed origin", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("Incapsula", { status: 403 });
  try {
    const response = await handleServiceRequest(new Request("https://lookup.workers.dev/api/streets?q=Хрещат", { headers: { origin: GITHUB_ORIGIN } }));
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("access-control-allow-origin"), GITHUB_ORIGIN);
    assert.match((await response.json()).error, /anti-bot/i);
  } finally { globalThis.fetch = originalFetch; }
});

test("rejects disallowed preflight methods and headers", async () => {
  const method = await handleServiceRequest(new Request("https://lookup.workers.dev/api/streets", {
    method: "OPTIONS", headers: { origin: GITHUB_ORIGIN, "access-control-request-method": "POST" },
  }));
  assert.equal(method.status, 405);
  const headers = await handleServiceRequest(new Request("https://lookup.workers.dev/api/streets", {
    method: "OPTIONS", headers: { origin: GITHUB_ORIGIN, "access-control-request-method": "GET", "access-control-request-headers": "authorization" },
  }));
  assert.equal(headers.status, 403);
});

test("does not launch a browser for unsupported routes or methods", async () => {
  const route = await handleServiceRequest(new Request("https://lookup.workers.dev/nope"), { BROWSER: {} });
  assert.equal(route.status, 404);
  const method = await handleServiceRequest(new Request("https://lookup.workers.dev/api/streets", { method: "POST" }), { BROWSER: {} });
  assert.equal(method.status, 405);
  const invalidBatch = await handleServiceRequest(new Request("https://lookup.workers.dev/api/schedules?addresses=%5B%5D"), { BROWSER: {} });
  assert.equal(invalidBatch.status, 400);
});
