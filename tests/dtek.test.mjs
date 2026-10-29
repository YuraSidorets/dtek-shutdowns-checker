import test from "node:test";
import assert from "node:assert/strict";
import { handleDtekRequest, parseBootstrap, parseSchedule } from "../src/dtek.mjs";

const groupsFor = (state) => Object.fromEntries(Array.from({ length: 24 }, (_, i) => [String(i + 1), state]));

function updateNow(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Kyiv", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(now).map((part) => [part.type, part.value]));
  return `${Number(parts.day)}.${Number(parts.month)}.${parts.year} ${Number(parts.hour)}:${parts.minute}`;
}

function todayFact(groupData, now = new Date()) {
  return { update: updateNow(now), today: Math.floor(now.getTime() / 1000), data: { [Math.floor(now.getTime() / 1000)]: groupData } };
}

function samplePage(fact) {
  return `<html><head><meta name="ajaxUrl" content="/ua/ajax"><meta name="csrf-token" content="token"></head><body><script>DisconSchedule.streets = ["вул. Хрещатик","вул. Саксаганського","майдан Лесі Українки"];
DisconSchedule.preset = {"time_zone":{"1":["00-01","00:00","01:00"]}};
DisconSchedule.fact = ${JSON.stringify(fact)};</script></body></html>`;
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

test("parses current page bootstrap state and CSRF/AJAX metadata", () => {
  const fact = todayFact({ "GPV1.1": groupsFor("yes") });
  const parsed = parseBootstrap(samplePage(fact));
  assert.deepEqual(parsed.streets, ["вул. Хрещатик", "вул. Саксаганського", "майдан Лесі Українки"]);
  assert.equal(parsed.ajaxUrl, "/ua/ajax");
  assert.equal(parsed.csrf, "token");
  assert.deepEqual(parsed.fact, fact);
});

test("maps official hourly states to half-hour slots and merges adjacent states", () => {
  const group = groupsFor("yes");
  group["1"] = "first";
  group["2"] = "second";
  group["3"] = "mfirst";
  group["4"] = "msecond";
  group["5"] = "maybe";
  group["6"] = "no";
  const now = new Date();
  const days = parseSchedule(todayFact({ "GPV1.1": group }, now), ["GPV1.1"], now);
  assert.equal(days.length, 1);
  assert.equal(days[0].slots[0].start, 0);
  assert.equal(days[0].slots[0].end, 30);
  assert.equal(days[0].slots[0].state, "off");
  assert.deepEqual(days[0].slots.slice(0, 5), [
    { start: 0, end: 30, state: "off" },
    { start: 30, end: 90, state: "on" },
    { start: 90, end: 120, state: "off" },
    { start: 120, end: 150, state: "unknown" },
    { start: 150, end: 210, state: "on" },
  ]);
  assert.equal(days[0].slots.at(-1).end, 1440);
});

test("combines multiple feed lines conservatively", () => {
  const on = groupsFor("yes");
  const mixed = groupsFor("yes");
  mixed["1"] = "no";
  mixed["2"] = "maybe";
  const now = new Date();
  const [day] = parseSchedule(todayFact({ "GPV1.1": on, "GPV1.2": mixed }, now), ["GPV1.1", "GPV1.2"], now);
  assert.deepEqual(day.slots.slice(0, 2), [
    { start: 0, end: 120, state: "unknown" },
    { start: 120, end: 1440, state: "on" },
  ]);
});

test("rejects missing lines, unknown source states, and stale or unpublished schedules", () => {
  const now = new Date();
  assert.throws(() => parseSchedule(todayFact({ "GPV1.1": groupsFor("yes") }, now), [], now), /supply-line/i);
  const incomplete = groupsFor("yes");
  delete incomplete["24"];
  assert.throws(() => parseSchedule(todayFact({ "GPV1.1": incomplete }, now), ["GPV1.1"], now), /incomplete/i);
  const unknown = groupsFor("yes");
  unknown["1"] = "unexpected";
  assert.throws(() => parseSchedule(todayFact({ "GPV1.1": unknown }, now), ["GPV1.1"], now), /unknown state/i);
  const old = new Date(now.getTime() - 48 * 60 * 60_000);
  assert.throws(() => parseSchedule(todayFact({ "GPV1.1": groupsFor("yes") }, old), ["GPV1.1"], now), /stale/i);
  assert.throws(() => parseSchedule({ update: updateNow(now), data: {} }, ["GPV1.1"], now), /not published/i);
});

test("serves filtered official street suggestions without requesting address data", async () => {
  const page = samplePage(todayFact({ "GPV1.1": groupsFor("yes") }));
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response(page, { status: 200 }); };
  try {
    const response = await handleDtekRequest(new Request("https://local.test/api/streets?q=Саксаган"));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { streets: ["вул. Саксаганського"] });
    assert.equal(calls, 1);
  } finally { globalThis.fetch = originalFetch; }
});

test("returns house suggestions and a mapped schedule for a verified house", async () => {
  const now = new Date();
  const page = samplePage(todayFact({ "GPV1.1": groupsFor("yes") }, now));
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    requests.push({ url, init });
    if (url.includes("/ua/ajax")) return jsonResponse({ result: true, data: { "1": { sub_type_reason: ["GPV1.1"] }, "2А": { sub_type_reason: ["GPV1.1"] } } });
    return new Response(page, { status: 200 });
  };
  try {
    const housesResponse = await handleDtekRequest(new Request("https://local.test/api/houses?street=%D0%B2%D1%83%D0%BB.%20%D0%A5%D1%80%D0%B5%D1%89%D0%B0%D1%82%D0%B8%D0%BA"));
    assert.equal(housesResponse.status, 200);
    assert.deepEqual(await housesResponse.json(), { houses: ["1", "2А"] });
    const response = await handleDtekRequest(new Request("https://local.test/api/schedule?street=%D0%B2%D1%83%D0%BB.%20%D0%A5%D1%80%D0%B5%D1%89%D0%B0%D1%82%D0%B8%D0%BA&house=1"));
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.street, "вул. Хрещатик");
    assert.equal(body.house, "1");
    assert.equal(body.updatedAt, updateNow(now));
    assert.equal(body.days[0].slots[0].state, "on");
    assert.equal(requests.filter((item) => item.url.includes("/ua/ajax")).length, 2);
    assert.match(requests.at(-1).init.body, /data%5B1%5D%5Bvalue%5D=1/);
    assert.equal(requests.at(-1).init.headers["x-csrf-token"], "token");
  } finally { globalThis.fetch = originalFetch; }
});

test("returns three schedules from one bootstrap and preserves individual lookup failures", async () => {
  const now = new Date();
  const page = samplePage(todayFact({ "GPV1.1": groupsFor("yes") }, now));
  const requests = [];
  const fetchImpl = async (input, init = {}) => {
    const url = String(input);
    requests.push({ url, init });
    if (!url.includes("/ua/ajax")) return new Response(page, { status: 200 });
    const params = new URLSearchParams(init.body);
    const house = params.get("data[1][value]");
    return jsonResponse({ result: true, data: { "1": { sub_type_reason: ["GPV1.1"] } } });
  };
  const addresses = [
    { street: "вул. Хрещатик", house: "1" },
    { street: "вул. Саксаганського", house: "1" },
    { street: "майдан Лесі Українки", house: "99" },
  ];
  const request = new Request(`https://local.test/api/schedules?addresses=${encodeURIComponent(JSON.stringify(addresses))}`);
  const response = await handleDtekRequest(request, { fetchImpl });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(requests.filter((item) => !item.url.includes("/ua/ajax")).length, 1);
  assert.equal(requests.filter((item) => item.url.includes("/ua/ajax")).length, 3);
  assert.deepEqual(body.results.map((result) => result.ok), [true, true, false]);
  assert.deepEqual(body.results.slice(0, 2).map((result) => [result.street, result.house, result.days[0].slots[0].state]), [
    ["вул. Хрещатик", "1", "on"],
    ["вул. Саксаганського", "1", "on"],
  ]);
  assert.match(body.results[2].error, /house/i);
  assert.equal(body.results[0].updatedAt, updateNow(now));
});

test("rejects invalid schedule batches before making upstream requests", async () => {
  let calls = 0;
  const response = await handleDtekRequest(new Request("https://local.test/api/schedules?addresses=%5B%5D"), {
    fetchImpl: async () => { calls++; throw new Error("must not run"); },
  });
  assert.equal(response.status, 400);
  assert.equal(calls, 0);
});

test("returns an actionable non-200 error when Incapsula blocks the upstream page", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("Incapsula incident", { status: 403 });
  try {
    const response = await handleDtekRequest(new Request("https://local.test/api/streets?q=Хрещат"));
    assert.equal(response.status, 503);
    assert.match((await response.json()).error, /anti-bot protection/i);
  } finally { globalThis.fetch = originalFetch; }
});

test("rejects invalid routes and methods", async () => {
  const route = await handleDtekRequest(new Request("https://local.test/nope"));
  assert.equal(route.status, 404);
  const method = await handleDtekRequest(new Request("https://local.test/api/streets", { method: "POST" }));
  assert.equal(method.status, 405);
});

test("forwards a private session, applies refreshed cookies, and never returns them", async () => {
  const page = samplePage(todayFact({ "GPV1.1": groupsFor("yes") }));
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).includes('/ua/ajax')) return jsonResponse({ result: true, data: { '1': { sub_type_reason: ['GPV1.1'] } } });
    return new Response(page, { headers: { 'set-cookie': 'session=new; Path=/; HttpOnly' } });
  };
  try {
    const response = await handleDtekRequest(new Request('https://local.test/api/schedule?' + new URLSearchParams({ street: 'вул. Хрещатик', house: '1' })), { cookie: 'security=private; session=old', userAgent: 'test-agent' });
    assert.equal(response.status, 200);
    assert.equal(calls[0].init.headers.cookie, 'security=private; session=old');
    assert.equal(calls[1].init.headers.cookie, 'security=private; session=new');
    assert.equal(calls[1].init.headers['user-agent'], 'test-agent');
    assert.doesNotMatch(await response.text(), /security=|session=|private|test-agent/);
  } finally { globalThis.fetch = originalFetch; }
});
