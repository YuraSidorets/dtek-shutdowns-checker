import { handleDtekRequest } from "./dtek.mjs";

const ALLOWED_ORIGINS = new Set([
  "https://yurasidorets.github.io",
  "http://127.0.0.1:43187",
]);
const ALLOWED_REQUEST_HEADERS = new Set(["content-type"]);

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

  const response = await handleDtekRequest(request, { cookie: env.DTEK_COOKIE, userAgent: env.DTEK_USER_AGENT });
  return allowedOrigin ? withHeaders(response, corsHeaders(allowedOrigin)) : response;
}

export default {
  fetch(request, env) {
    return handleServiceRequest(request, env);
  },
};
