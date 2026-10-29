import puppeteer from "@cloudflare/puppeteer";

const PAGE_URL = "https://www.dtek-kem.com.ua/ua/shutdowns";
const AJAX_URL = "https://www.dtek-kem.com.ua/ua/ajax";

function responseLike(status, body, contentType) {
  return new Response(body, {
    status,
    headers: { "content-type": contentType },
  });
}

export async function createBrowserFetch(binding, puppeteerApi = puppeteer) {
  let stage = "launch";
  let browser;
  let page;
  try {
    browser = await puppeteerApi.launch(binding);
    stage = "page creation";
    page = await browser.newPage();
    stage = "DTEK navigation";
    const navigation = await page.goto(PAGE_URL, { waitUntil: "networkidle2", timeout: 20_000 });
    const pageStatus = navigation?.status() ?? 200;
    let pageHtml;

    const fetchImpl = async (input, init = {}) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const method = (init.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
      if (method === "GET" && url.href === PAGE_URL) {
        pageHtml ??= await page.content();
        return responseLike(pageStatus, pageHtml, "text/html; charset=utf-8");
      }
      if (method !== "POST" || url.origin !== "https://www.dtek-kem.com.ua" || url.pathname !== "/ua/ajax") {
        throw new TypeError("The browser transport only supports DTEK schedule and address requests.");
      }

      const headers = new Headers(init.headers);
      headers.delete("cookie");
      headers.delete("origin");
      headers.delete("referer");
      headers.delete("user-agent");
      const result = await page.evaluate(async ({ target, requestHeaders, body }) => {
        const response = await fetch(target, {
          method: "POST",
          headers: requestHeaders,
          body,
          credentials: "same-origin",
          signal: AbortSignal.timeout(12_000),
        });
        return { status: response.status, contentType: response.headers.get("content-type") ?? "application/json", body: await response.text() };
      }, { target: AJAX_URL, requestHeaders: Object.fromEntries(headers), body: init.body ?? "" });
      return responseLike(result.status, result.body, result.contentType);
    };

    return {
      fetch: fetchImpl,
      close: () => browser.close(),
    };
  } catch (error) {
    try { await browser?.close(); } catch { /* preserve the setup failure */ }
    const failure = new Error(`Browser ${stage} failed.`, { cause: error });
    failure.stage = stage;
    throw failure;
  }
}
