/* Shared network layer (loaded before app.js; every module fetches JSON through it).
 *   fetchJSON(url, opts)     → the parsed data, or throws a FetchError (or an AbortError)
 *   fetchJSONMeta(url, opts) → { data, stale, age, error }
 *   errorText(err, service)  → a short message people can act on
 * Options: timeout   ms per attempt (default 12000)
 *          budget    ms for all attempts together (default = timeout), so a hung service
 *                    fails after about `timeout` instead of timeout × attempts
 *          retries   extra attempts on network errors, timeouts, 429 and 5xx (default 2)
 *          ttl       ms to reuse a cached answer (0 = no cache)
 *          key       cache and de-duplication key (default: the URL)
 *          staleIfError  on failure, return the last cached answer marked stale
 *          signal    AbortSignal of the caller (a newer search, pan or click)
 *          source    service name used in error messages
 * Also: in-flight de-duplication, a memory + localStorage cache (LRU, 200 keys)
 * and per-host limits (Nominatim 1 request/s, Photon, Open-Meteo, BigDataCloud 2 at a time).
 * Fires a document "net:retry" event when the device comes back online or the tab is shown again.
 */

class FetchError extends Error {
  // kind: "offline" | "network" | "timeout" | "rate" | "server" | "notfound" | "bad"
  constructor(kind, message, { status = 0, source = "", reason = "", retryAfter = 0 } = {}) {
    super(message);
    this.name = "FetchError";
    this.kind = kind;
    this.status = status;
    this.source = source;
    this.reason = reason;
    this.retryAfter = retryAfter; // ms, from the Retry-After header
  }
}

const abortError = () => new DOMException("The request was cancelled.", "AbortError");
const isAbort = (err) => err?.name === "AbortError";
const hostOf = (url) => { try { return new URL(url, location.href).hostname; } catch { return ""; } };

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const onAbort = () => { clearTimeout(t); reject(abortError()); };
    const t = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// ---------- Per-host limits ----------
// [host test, max requests at once, minimum ms between request starts]
const HOST_RULES = [
  [(h) => h === "nominatim.openstreetmap.org", 1, 1000],
  [(h) => h === "photon.komoot.io" || h === "api-bdc.io" || h === "open-meteo.com" || h.endsWith(".open-meteo.com"), 2, 0],
];
const limiters = new Map();

function makeLimiter(max, gap) {
  let active = 0, last = -Infinity, timer = null;
  const queue = [];
  const pump = () => {
    while (active < max && queue.length) {
      const wait = last + gap - Date.now();
      if (wait > 0) {
        if (!timer) timer = setTimeout(() => { timer = null; pump(); }, wait);
        return;
      }
      active++;
      last = Date.now();
      queue.shift().start();
    }
  };
  // Resolves with a release() function once a slot is free.
  return (signal) => new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    let released = false;
    const release = () => { if (!released) { released = true; active--; pump(); } };
    const onAbort = () => {
      const i = queue.indexOf(job);
      if (i >= 0) { queue.splice(i, 1); reject(abortError()); }
    };
    const job = { start: () => { signal?.removeEventListener("abort", onAbort); resolve(release); } };
    signal?.addEventListener("abort", onAbort, { once: true });
    queue.push(job);
    pump();
  });
}

function limiterFor(host) {
  if (!limiters.has(host)) {
    const rule = HOST_RULES.find(([test]) => test(host));
    limiters.set(host, rule ? makeLimiter(rule[1], rule[2]) : null);
  }
  return limiters.get(host);
}

// ---------- One attempt ----------
async function attemptFetch(url, signal, timeout, source) {
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, timeout);
  const onAbort = () => ctrl.abort();
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    const text = await res.text();
    if (!res.ok) {
      let body = null;
      try { body = JSON.parse(text); } catch { /* not JSON */ }
      const reason = [body?.reason, body?.message, body?.error].find((v) => typeof v === "string" && v) || "";
      const s = res.status;
      const kind = s === 404 ? "notfound" : s === 429 ? "rate" : s >= 500 ? "server" : "bad";
      const ra = (res.headers.get("Retry-After") || "").trim();
      const retryAfter = !ra ? 0 : /^\d+$/.test(ra) ? +ra * 1000 : Math.max(0, Date.parse(ra) - Date.now()) || 0;
      throw new FetchError(kind, `${source}: HTTP ${s}${reason ? ` – ${reason}` : ""}`, { status: s, source, reason, retryAfter });
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new FetchError("bad", `${source}: invalid JSON`, { status: res.status, source, reason: `${source} sent an unreadable answer.` });
    }
  } catch (err) {
    if (err instanceof FetchError) throw err;
    if (signal.aborted && !timedOut) throw abortError();
    if (navigator.onLine === false) throw new FetchError("offline", `${source}: offline`, { source });
    if (timedOut) throw new FetchError("timeout", `${source}: no answer after ${Math.round(timeout / 1000)} s`, { source });
    // fetch() rejects with a TypeError when the connection, DNS or CORS fails.
    throw new FetchError("network", `${source}: ${err.message}`, { source, reason: err.message });
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
}

// ---------- Retries ----------
const RETRY_KINDS = new Set(["offline", "network", "timeout", "rate", "server"]);
const RETRY_DELAYS = [1000, 3000];

async function fetchWithRetry(url, signal, { timeout, budget, retries, source }) {
  const limit = limiterFor(hostOf(url));
  let deadline = null; // the budget starts with the first attempt, not while queued
  for (let n = 0; ; n++) {
    const release = limit ? await limit(signal) : null;
    let err;
    try {
      deadline ??= Date.now() + budget;
      const left = deadline - Date.now();
      if (left < 500) throw new FetchError("timeout", `${source}: out of time`, { source });
      return await attemptFetch(url, signal, Math.min(timeout, left), source);
    } catch (e) {
      err = e;
    } finally {
      release?.();
    }
    if (isAbort(err) || signal.aborted || !RETRY_KINDS.has(err.kind) || n >= retries) throw err;
    let wait = RETRY_DELAYS[Math.min(n, RETRY_DELAYS.length - 1)] * (0.7 + Math.random() * 0.6);
    if (err.retryAfter) {
      if (err.retryAfter > 10000) throw err; // the service asks for a longer break
      wait = Math.max(wait, err.retryAfter);
    }
    if (Date.now() + wait + 500 > deadline) throw err; // no time left for another attempt
    await sleep(wait, signal);
  }
}

// ---------- In-flight de-duplication ----------
// Callers asking for the same key share one request. It is only cancelled
// when every caller that is waiting for it has aborted.
const inflight = new Map();

function shared(key, start, signal) {
  let f = inflight.get(key);
  if (!f) {
    f = { ctrl: new AbortController(), waiters: 0 };
    f.promise = start(f.ctrl.signal).finally(() => { if (inflight.get(key) === f) inflight.delete(key); });
    f.promise.catch(() => {}); // failures are reported to each waiter
    inflight.set(key, f);
  }
  const flight = f;
  flight.waiters++;
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      if (--flight.waiters === 0) {
        if (inflight.get(key) === flight) inflight.delete(key);
        flight.ctrl.abort();
      }
      reject(abortError());
    };
    if (signal?.aborted) return onAbort();
    signal?.addEventListener("abort", onAbort, { once: true });
    flight.promise.then(resolve, reject).finally(() => signal?.removeEventListener("abort", onAbort));
  });
}

// ---------- Cache: memory + localStorage, LRU ----------
const CACHE_PREFIX = "mad.c.";
const CACHE_INDEX = "mad.cache-index"; // keys in least → most recently used order
const CACHE_MAX = 200;
const memCache = new Map();

function memPut(key, entry) {
  memCache.delete(key);
  memCache.set(key, entry);
  if (memCache.size > CACHE_MAX) memCache.delete(memCache.keys().next().value);
}

function readIndex() {
  try { return JSON.parse(localStorage.getItem(CACHE_INDEX)) || []; } catch { return []; }
}

// Moves `key` to the most recently used end and drops the oldest entries over the cap.
function touchIndex(key, dropExtra = 0) {
  try {
    const idx = readIndex().filter((k) => k !== key);
    if (key) idx.push(key);
    while (idx.length > CACHE_MAX || (dropExtra-- > 0 && idx.length > 1)) localStorage.removeItem(CACHE_PREFIX + idx.shift());
    localStorage.setItem(CACHE_INDEX, JSON.stringify(idx));
  } catch { /* storage unavailable */ }
}

function cacheGet(key) {
  const hit = memCache.get(key);
  if (hit) { memPut(key, hit); return hit; }
  let entry = null;
  try { entry = JSON.parse(localStorage.getItem(CACHE_PREFIX + key)); } catch { /* unavailable or corrupt */ }
  if (!entry || typeof entry.at !== "number") return null;
  memPut(key, entry);
  touchIndex(key);
  return entry;
}

function cacheSet(key, entry) {
  memPut(key, entry);
  const json = JSON.stringify(entry);
  for (let tries = 0; tries < 2; tries++) {
    try {
      localStorage.setItem(CACHE_PREFIX + key, json);
      touchIndex(key);
      return;
    } catch {
      touchIndex(null, Math.ceil(readIndex().length / 4)); // probably full: free the oldest quarter and try again
    }
  }
}

// ---------- Public API ----------
async function fetchJSONMeta(url, opts = {}) {
  const {
    timeout = 12000, retries = 2, ttl = 0, key = url, staleIfError = false, signal,
    source = hostOf(url) || "The service",
  } = opts;
  const budget = opts.budget ?? timeout;
  if (signal?.aborted) throw abortError();
  const cached = ttl > 0 || staleIfError ? cacheGet(key) : null;
  if (cached && ttl > 0 && Date.now() - cached.at < ttl) {
    return { data: cached.data, stale: false, age: Date.now() - cached.at, error: null };
  }
  try {
    const data = await shared(key, (sig) =>
      fetchWithRetry(url, sig, { timeout, budget, retries, source }).then((d) => {
        if (ttl > 0 || staleIfError) cacheSet(key, { at: Date.now(), ttl, data: d });
        return d;
      }), signal);
    return { data, stale: false, age: 0, error: null };
  } catch (err) {
    if (isAbort(err) || !staleIfError || !cached) throw err;
    return { data: cached.data, stale: true, age: Date.now() - cached.at, error: err };
  }
}

async function fetchJSON(url, opts) {
  return (await fetchJSONMeta(url, opts)).data;
}

// Message for people, based on what went wrong.
function errorText(err, service) {
  const s = service || err?.source || "The service";
  switch (err?.kind) {
    case "offline": return "You're offline. Check your connection.";
    case "network": return `${s} can't be reached right now. Check your connection and try again.`;
    case "timeout": return `${s} took too long to respond.`;
    case "rate": return `${s} is busy (too many requests). Try again in a minute.`;
    case "server": return `${s} is having problems (error ${err.status}).`;
    case "notfound":
    case "bad": return err.reason || `${s} couldn't answer this request (error ${err.status}).`;
  }
  return err?.message || String(err);
}

// Let modules re-run failed loads when the connection comes back or the app is reopened.
const fireNetRetry = () => document.dispatchEvent(new CustomEvent("net:retry"));
window.addEventListener("online", fireNetRetry);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") fireNetRetry();
});
