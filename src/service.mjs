import { handleDtekRequest, parseScheduleAddresses } from "./dtek.mjs";
import { createBrowserFetch } from "./browser.mjs";

const ALLOWED_ORIGINS = new Set([
  "https://yurasidorets.github.io",
  "http://127.0.0.1:43187",
]);
const ALLOWED_REQUEST_HEADERS = new Set(["content-type"]);
const DTEK_API_PATHS = new Set(["/api/streets", "/api/houses", "/api/schedule", "/api/schedules"]);

function jsonError(message, status, headers = {}) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

function corsHeaders(origin) {
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, OPTIONS",
    "access-control-allow-headers": "Content-Type",
    "access-control-expose-headers": "Retry-After",
    "access-control-max-age": "600",
    "cache-control": "no-store",
    vary: "Origin, Access-Control-Request-Headers, Access-Control-Request-Method",
  };
}

function withHeaders(response, headers) {
  const merged = new Headers(response.headers);
  for (const [name, value] of Object.entries(headers)) merged.set(name, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers: merged });
}

const SESSION_WAIT_MS = 12_000;

function browserRateLimit(error) {
  for (let current = error; current; current = current.cause) {
    if (current.status === 429 || /browser time limit|too many requests|rate.?limit/i.test(current.message ?? "")) {
      const retryAfter = Math.max(1, Number.parseInt(current.headers?.get?.("Retry-After") ?? "20", 10) || 20);
      return jsonError(`Browser service is rate limited. Retry in ${retryAfter} seconds.`, 429, { "retry-after": String(retryAfter) });
    }
  }
  return null;
}

async function waitBriefly() {
  await new Promise((resolve) => setTimeout(resolve, 200));
}

function refreshIdleTimeout(session, coordinator) {
  const close = session.close.bind(session);
  return {
    ...session,
    async close() {
      try { await close(); }
      finally { await coordinator.touch(session.sessionId); }
    },
  };
}

async function getBrowserSession(env) {
  if (!env.BROWSER_SESSIONS) return createBrowserFetch(env.BROWSER);
  const coordinator = env.BROWSER_SESSIONS.getByName("dtek-shutdowns-checker-browser");
  const deadline = Date.now() + SESSION_WAIT_MS;
  while (Date.now() < deadline) {
    const claim = await coordinator.claim();
    if (claim.sessionId) {
      try {
        const session = await createBrowserFetch(env.BROWSER, undefined, { sessionId: claim.sessionId });
        return refreshIdleTimeout(session, coordinator);
      } catch (error) {
        if (error.stage !== "session connection") throw error;
        await coordinator.forget(claim.sessionId);
        continue;
      }
    }
    if (claim.launch) {
      try {
        const session = await createBrowserFetch(env.BROWSER, undefined, {
          onSession: (sessionId) => coordinator.register(sessionId),
        });
        return refreshIdleTimeout(session, coordinator);
      } catch (error) {
        await coordinator.releaseLaunch();
        throw error;
      }
    }
    await waitBriefly();
  }
  const error = new Error("Browser session startup is still in progress.");
  error.status = 429;
  error.headers = new Headers({ "retry-after": "2" });
  throw error;
}

export async function handleServiceRequest(request, env = {}) {
  const origin = request.headers.get("origin");
  const allowedOrigin = origin && ALLOWED_ORIGINS.has(origin) ? origin : null;
  if (origin && !allowedOrigin) return jsonError("Origin is not allowed.", 403, { vary: "Origin" });

  if (request.method === "OPTIONS") {
    if (!allowedOrigin) return jsonError("A permitted Origin is required for preflight.", 403, { vary: "Origin" });
    const method = request.headers.get("access-control-request-method")?.toUpperCase();
    if (method && method !== "GET") return jsonError("Only GET requests are allowed.", 405, corsHeaders(allowedOrigin));
    const requestedHeaders = (request.headers.get("access-control-request-headers") ?? "")
      .split(",").map((header) => header.trim().toLowerCase()).filter(Boolean);
    if (requestedHeaders.some((header) => !ALLOWED_REQUEST_HEADERS.has(header))) {
      return jsonError("The requested preflight headers are not allowed.", 403, corsHeaders(allowedOrigin));
    }
    return new Response(null, { status: 204, headers: corsHeaders(allowedOrigin) });
  }

  if (request.method !== "GET") {
    const response = jsonError("Only GET requests are supported.", 405);
    return allowedOrigin ? withHeaders(response, corsHeaders(allowedOrigin)) : response;
  }

  let response;
  const pathname = new URL(request.url).pathname;
  const parsedBatch = pathname === "/api/schedules" ? parseScheduleAddresses(request) : null;
  if (parsedBatch?.error) {
    response = jsonError(parsedBatch.error, 400);
  } else if (env.BROWSER && request.method === "GET" && DTEK_API_PATHS.has(pathname)) {
    let browserSession;
    try {
      browserSession = await getBrowserSession(env);
      response = await handleDtekRequest(request, { fetchImpl: browserSession.fetch, batchAddresses: parsedBatch?.addresses });
    } catch (error) {
      response = browserRateLimit(error) ?? jsonError("DTEK browser lookup is temporarily unavailable. Retry later.", 503);
    } finally {
      if (browserSession) {
        try { await browserSession.close(); }
        catch { response = jsonError("DTEK browser lookup is temporarily unavailable. Retry later.", 503); }
      }
    }
  } else {
    response = await handleDtekRequest(request, { cookie: env.DTEK_COOKIE, userAgent: env.DTEK_USER_AGENT });
  }
  return allowedOrigin ? withHeaders(response, corsHeaders(allowedOrigin)) : response;
}

export default {
  fetch(request, env) {
    return handleServiceRequest(request, env);
  },
};
