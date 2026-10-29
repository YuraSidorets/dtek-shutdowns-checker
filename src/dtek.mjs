const PAGE_URL = "https://www.dtek-kem.com.ua/ua/shutdowns";
const AJAX_URL = "https://www.dtek-kem.com.ua/ua/ajax";
const TIME_ZONE = "Europe/Kyiv";
const REQUEST_TIMEOUT_MS = 12_000;

class AdapterError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function readJsonAssignment(html, property) {
  const marker = `DisconSchedule.${property} =`;
  const markerIndex = html.indexOf(marker);
  if (markerIndex < 0) throw new AdapterError(`DTEK page is missing ${property} data.`);

  let index = markerIndex + marker.length;
  while (/\s/.test(html[index] ?? "")) index++;
  const start = index;
  const opening = html[index];
  if (opening !== "{" && opening !== "[") throw new AdapterError(`DTEK ${property} data is malformed.`);
  const stack = [opening === "{" ? "}" : "]"];
  let inString = false;
  let escaped = false;
  for (index++; index < html.length && stack.length; index++) {
    const char = html[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") stack.push("}");
    else if (char === "[") stack.push("]");
    else if (char === "}" || char === "]") {
      if (stack.pop() !== char) throw new AdapterError(`DTEK ${property} data is malformed.`);
    }
  }
  if (stack.length || inString) throw new AdapterError(`DTEK ${property} data is incomplete.`);
  try {
    return JSON.parse(html.slice(start, index));
  } catch {
    throw new AdapterError(`DTEK ${property} data is not valid JSON.`);
  }
}

function readMetaContent(html, name) {
  const tags = html.match(/<meta\b[^>]*>/gi) ?? [];
  for (const tag of tags) {
    const names = [...tag.matchAll(/([\w:-]+)\s*=\s*(["'])(.*?)\2/g)].map((m) => [m[1].toLowerCase(), m[3]]);
    const attrs = Object.fromEntries(names);
    if (attrs.name === name) return attrs.content;
  }
  return undefined;
}

export function parseBootstrap(html) {
  if (typeof html !== "string" || !html.includes("DisconSchedule.")) {
    throw new AdapterError("DTEK returned a page without its schedule application data.");
  }
  const streets = readJsonAssignment(html, "streets");
  const preset = readJsonAssignment(html, "preset");
  const fact = readJsonAssignment(html, "fact");
  if (!Array.isArray(streets) || streets.length === 0) throw new AdapterError("DTEK street suggestions are missing.");
  if (!preset || !preset.time_zone || !fact || !fact.data || !fact.update) {
    throw new AdapterError("DTEK schedule data is incomplete or unpublished.");
  }
  return { streets, preset, fact, ajaxUrl: readMetaContent(html, "ajaxUrl") || "/ua/ajax", csrf: readMetaContent(html, "csrf-token") };
}

function localDateFromEpoch(epochSeconds) {
  const date = new Date(Number(epochSeconds) * 1000);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function kyivDateNow(now = new Date()) {
  return localDateFromEpoch(now.getTime() / 1000);
}

function parseFactUpdate(value) {
  const match = /^(\d{1,2})\.(\d{1,2})\.(\d{4})\s+(\d{1,2}):(\d{2})$/.exec(value ?? "");
  if (!match) return null;
  const [, day, month, year, hour, minute] = match.map(Number);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return null;
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  // DTEK publishes this timestamp as Kyiv wall time. Resolve its UTC offset
  // from the IANA zone, so summer/winter changes do not depend on host TZ.
  const guessParts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    timeZoneName: "longOffset",
  }).formatToParts(new Date(guess));
  const zone = guessParts.find((part) => part.type === "timeZoneName")?.value ?? "GMT+02:00";
  const offset = /GMT([+-])(\d{2}):(\d{2})/.exec(zone);
  if (!offset) return null;
  const delta = (Number(offset[2]) * 60 + Number(offset[3])) * (offset[1] === "+" ? 1 : -1);
  const corrected = guess - delta * 60_000;
  const check = new Intl.DateTimeFormat("en-GB", {
    timeZone: TIME_ZONE, day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).format(new Date(corrected));
  const [d, m, y, h, min] = check.match(/\d+/g).map(Number);
  return d === day && m === month && y === year && h === hour && min === minute ? corrected : null;
}

function staleFact(fact, now = new Date()) {
  const updatedAt = parseFactUpdate(fact?.update);
  if (!updatedAt) return true;
  const age = now.getTime() - updatedAt;
  return age < -5 * 60_000 || age > 36 * 60 * 60_000;
}

function segmentStates(value) {
  switch (value) {
    case "yes": return ["on", "on"];
    case "no": return ["off", "off"];
    case "first": return ["off", "on"];
    case "second": return ["on", "off"];
    case "mfirst": return ["unknown", "on"];
    case "msecond": return ["on", "unknown"];
    case "maybe": return ["unknown", "unknown"];
    default: return null;
  }
}

function combineLineStates(states) {
  if (states.every((state) => state === "on")) return "on";
  if (states.every((state) => state === "off")) return "off";
  return "unknown";
}

function makeSlots(intervalStates) {
  const slots = [];
  for (let index = 0; index < intervalStates.length; index++) {
    const start = index * 30;
    const state = intervalStates[index];
    const previous = slots.at(-1);
    if (previous && previous.state === state && previous.end === start) previous.end += 30;
    else slots.push({ start, end: start + 30, state });
  }
  return slots;
}

export function parseSchedule(fact, groups, now = new Date()) {
  if (staleFact(fact, now)) throw new AdapterError("DTEK schedule is stale or has an invalid update time.", 503);
  if (!Array.isArray(groups) || groups.length === 0 || groups.some((group) => typeof group !== "string" || !group)) {
    throw new AdapterError("DTEK did not publish a usable supply-line assignment for this house.", 404);
  }
  const today = kyivDateNow(now);
  const dates = Object.keys(fact.data ?? {})
    .map((epoch) => ({ epoch, date: localDateFromEpoch(epoch) }))
    .filter((entry) => entry.date && entry.date >= today)
    .sort((a, b) => a.date.localeCompare(b.date));
  if (dates.length === 0) throw new AdapterError("DTEK has not published a current schedule for this address.", 503);

  const days = dates.map(({ epoch, date }) => {
    const dayData = fact.data[epoch];
    if (!dayData || typeof dayData !== "object") throw new AdapterError(`DTEK schedule for ${date} is malformed.`);
    const halfHours = [];
    for (let hour = 1; hour <= 24; hour++) {
      const perLine = groups.map((group) => segmentStates(dayData[group]?.[String(hour)]));
      if (perLine.some((parts) => !parts)) throw new AdapterError(`DTEK schedule for ${date} is incomplete or uses an unknown state.`);
      for (let half = 0; half < 2; half++) halfHours.push(combineLineStates(perLine.map((parts) => parts[half])));
    }
    return { date, slots: makeSlots(halfHours) };
  });
  return days;
}

export function parseScheduleAddresses(request) {
  const url = new URL(request.url);
  let addresses;
  try { addresses = JSON.parse(url.searchParams.get("addresses") ?? ""); }
  catch { return { error: "addresses must be a JSON array of three street and house pairs." }; }
  if (!Array.isArray(addresses) || addresses.length !== 3) {
    return { error: "Exactly three street and house pairs are required." };
  }
  const normalized = [];
  for (const value of addresses) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { error: "Each address must contain a street and house." };
    }
    const street = typeof value.street === "string" ? value.street.trim() : "";
    const house = typeof value.house === "string" ? value.house.trim() : "";
    if (!street || street.length > 200 || !house || house.length > 40) {
      return { error: "Each address must contain a valid street and house." };
    }
    normalized.push({ street, house });
  }
  return { addresses: normalized };
}

function asObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AdapterError(`DTEK ${label} response is malformed.`);
  return value;
}

async function upstreamGet(fetchImpl, session = {}) {
  let response;
  try {
    response = await fetchImpl(PAGE_URL, {
      headers: { accept: "text/html,application/xhtml+xml", "accept-language": "uk-UA,uk;q=0.9,en;q=0.7", ...(session.cookie ? { cookie: session.cookie } : {}), ...(session.userAgent ? { "user-agent": session.userAgent } : {}) },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new AdapterError(`Could not reach DTEK (${error?.name === "TimeoutError" ? "request timed out" : "network error"}). Retry later or check DTEK directly.`, 503);
  }
  if (!response.ok) {
    const status = response.status;
    const detail = status === 403 ? "DTEK's anti-bot protection denied this server request" : `DTEK returned HTTP ${status}`;
    throw new AdapterError(`${detail}. Check the official schedule page directly: ${PAGE_URL}`, status === 403 ? 503 : 502);
  }
  const html = await response.text();
  if (/incapsula incident|request unsuccessful|access denied/i.test(html.slice(0, 4000))) {
    throw new AdapterError(`DTEK's anti-bot protection denied this server request. Check the official schedule page directly: ${PAGE_URL}`, 503);
  }
  const bootstrap = parseBootstrap(html);
  const setCookies = response.headers.getSetCookie?.() ?? [];
  const fallbackCookieHeader = response.headers.get("set-cookie") ?? "";
  const receivedCookies = (setCookies.length ? setCookies : fallbackCookieHeader.match(/(?:^|,\s*)([^=;,\s]+=[^;,]*)/g) ?? [])
    .map((cookie) => cookie.trim().replace(/^,\s*/, "").split(";", 1)[0])
    .filter(Boolean)
    .join("; ");
  const cookies = new Map((session.cookie || '').split(';').concat(receivedCookies.split(';')).map(v => v.trim()).filter(Boolean).map(v => [v.slice(0, v.indexOf('=')), v.slice(v.indexOf('=') + 1)]));
  return { ...bootstrap, cookies: [...cookies].map(([key, value]) => `${key}=${value}`).join('; '), userAgent: session.userAgent };
}

async function upstreamAddress(fetchImpl, bootstrap, street, house = "") {
  const url = new URL(bootstrap.ajaxUrl, PAGE_URL);
  if (url.origin !== new URL(PAGE_URL).origin) throw new AdapterError("DTEK page returned an unexpected AJAX endpoint.");
  const body = new URLSearchParams();
  body.set("method", "getHomeNum");
  const fields = [
    ["street", street],
    ["house_num", house],
    ["updateFact", bootstrap.fact.update],
  ];
  fields.forEach(([name, value], index) => {
    body.set(`data[${index}][name]`, name);
    body.set(`data[${index}][value]`, value);
  });
  let response;
  try {
    const headers = {
      accept: "application/json, text/javascript, */*; q=0.01",
      "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
      "x-requested-with": "XMLHttpRequest",
      origin: new URL(PAGE_URL).origin,
      referer: PAGE_URL,
    };
    if (bootstrap.csrf) headers["x-csrf-token"] = bootstrap.csrf;
    if (bootstrap.cookies) headers.cookie = bootstrap.cookies;
    if (bootstrap.userAgent) headers["user-agent"] = bootstrap.userAgent;
    response = await fetchImpl(url, { method: "POST", headers, body: body.toString(), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (error) {
    throw new AdapterError(`Could not query DTEK address data (${error?.name === "TimeoutError" ? "request timed out" : "network error"}). Retry later.`, 503);
  }
  if (!response.ok) throw new AdapterError(`DTEK address lookup failed with HTTP ${response.status}. Retry later or check DTEK directly.`, 503);
  let answer;
  try { answer = await response.json(); }
  catch { throw new AdapterError("DTEK returned a non-JSON address response.", 502); }
  if (answer?.result !== true) throw new AdapterError("DTEK could not find this address. Check the street and house in its official form.", 404);
  return asObject(answer.data, "address");
}

export async function handleDtekRequest(request, session = {}) {
  const url = new URL(request.url);
  if (request.method !== "GET") return json({ error: "Only GET requests are supported." }, 405);
  if (!["/api/streets", "/api/houses", "/api/schedule", "/api/schedules"].includes(url.pathname)) return json({ error: "Route not found." }, 404);

  const batch = url.pathname === "/api/schedules"
    ? (session.batchAddresses ? { addresses: session.batchAddresses } : parseScheduleAddresses(request))
    : null;
  if (batch?.error) return json({ error: batch.error }, 400);

  try {
    const fetchImpl = session.fetchImpl ?? globalThis.fetch;
    const bootstrap = await upstreamGet(fetchImpl, session);
    if (url.pathname === "/api/streets") {
      const query = (url.searchParams.get("q") ?? "").trim().toLocaleLowerCase("uk");
      const streets = bootstrap.streets
        .filter((street) => typeof street === "string" && street.toLocaleLowerCase("uk").includes(query))
        .slice(0, 30);
      return json({ streets });
    }

    const street = (url.searchParams.get("street") ?? "").trim();
    if (!batch) {
      if (!street) return json({ error: "street is required." }, 400);
      if (!bootstrap.streets.includes(street)) return json({ error: "Select a street from DTEK's suggestions." }, 404);
    }
    if (url.pathname === "/api/houses") {
      const houses = await upstreamAddress(fetchImpl, bootstrap, street);
      return json({ houses: Object.keys(houses).filter((house) => house !== "-" && house !== ".") });
    }

    if (batch) {
      const results = [];
      for (const { street: addressStreet, house: addressHouse } of batch.addresses) {
        try {
          if (!bootstrap.streets.includes(addressStreet)) throw new AdapterError("Select a street from DTEK's suggestions.", 404);
          const selectedHouses = await upstreamAddress(fetchImpl, bootstrap, addressStreet, addressHouse);
          const address = selectedHouses[addressHouse];
          if (!address) throw new AdapterError("Select a house from DTEK's suggestions.", 404);
          results.push({
            ok: true,
            street: addressStreet,
            house: addressHouse,
            fetchedAt: new Date().toISOString(),
            updatedAt: bootstrap.fact.update,
            days: parseSchedule(bootstrap.fact, address.sub_type_reason),
          });
        } catch (error) {
          results.push({
            ok: false,
            street: addressStreet,
            house: addressHouse,
            error: error instanceof Error ? error.message : "DTEK address lookup failed.",
            status: error instanceof AdapterError ? error.status : 502,
          });
        }
      }
      return json({ results });
    }

    const house = (url.searchParams.get("house") ?? "").trim();
    if (!house) return json({ error: "house is required." }, 400);
    const selectedHouses = await upstreamAddress(fetchImpl, bootstrap, street, house);
    const address = selectedHouses[house];
    if (!address) return json({ error: "Select a house from DTEK's suggestions." }, 404);
    const groups = address.sub_type_reason;
    const days = parseSchedule(bootstrap.fact, groups);
    return json({ street, house, fetchedAt: new Date().toISOString(), updatedAt: bootstrap.fact.update, days });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "DTEK request failed unexpectedly." }, error instanceof AdapterError ? error.status : 502);
  }
}
