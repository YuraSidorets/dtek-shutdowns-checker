import test from "node:test";
import assert from "node:assert/strict";
import { createBrowserFetch } from "../src/browser.mjs";

function fakePuppeteer({ navigationError } = {}) {
  const calls = { goto: [], evaluate: [], closed: 0 };
  const page = {
    async goto(...args) {
      calls.goto.push(args);
      if (navigationError) throw navigationError;
      return { status: () => 200 };
    },
    async content() { return "<html>official DTEK</html>"; },
    async evaluate(callback, args) {
      calls.evaluate.push(args);
      return { status: 200, contentType: "application/json", body: JSON.stringify({ result: true }) };
    },
  };
  return {
    calls,
    api: { async launch() { return { async newPage() { return page; }, async close() { calls.closed++; } }; } },
  };
}

test("browser transport loads only DTEK and sends AJAX in the browser context", async () => {
  const fake = fakePuppeteer();
  const session = await createBrowserFetch({}, fake.api);
  try {
    assert.equal(fake.calls.goto[0][0], "https://www.dtek-kem.com.ua/ua/shutdowns");
    assert.equal(fake.calls.goto[0][1].waitUntil, "networkidle2");
    const page = await session.fetch("https://www.dtek-kem.com.ua/ua/shutdowns");
    assert.equal(await page.text(), "<html>official DTEK</html>");
    const ajax = await session.fetch("https://www.dtek-kem.com.ua/ua/ajax", {
      method: "POST",
      headers: { cookie: "private=secret", "x-csrf-token": "token", "content-type": "application/x-www-form-urlencoded" },
      body: "method=getHomeNum",
    });
    assert.deepEqual(await ajax.json(), { result: true });
    assert.deepEqual(fake.calls.evaluate[0].requestHeaders, {
      "content-type": "application/x-www-form-urlencoded",
      "x-csrf-token": "token",
    });
  } finally { await session.close(); }
  assert.equal(fake.calls.closed, 1);
});

test("browser transport rejects arbitrary destinations and closes after navigation failure", async () => {
  const fake = fakePuppeteer();
  const session = await createBrowserFetch({}, fake.api);
  await assert.rejects(() => session.fetch("https://example.com/"), /only supports DTEK/i);
  await session.close();

  const broken = fakePuppeteer({ navigationError: new Error("navigation failed") });
  await assert.rejects(() => createBrowserFetch({}, broken.api), /navigation failed/);
  assert.equal(broken.calls.closed, 1);
});
