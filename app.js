/* Map Alert Detector
 * Live alerts from free, key-less official sources:
 *   USGS  – earthquakes worldwide           https://earthquake.usgs.gov
 *   GDACS – UN/EU global disaster alerts    https://www.gdacs.org
 *   EONET – NASA natural events (fires, storms, volcanoes, ice…) https://eonet.gsfc.nasa.gov
 */

const REFRESH_MS = 5 * 60 * 1000;
const SEVERITY_NAMES = { 3: "Red", 2: "Orange", 1: "Yellow", 0: "Green", "-1": "Info" };
const SEVERITY_VARS = { 3: "--sev-3", 2: "--sev-2", 1: "--sev-1", 0: "--sev-0", "-1": "--sev-info" };
// The colour always comes with words (and a marker shape), so it is never the only signal.
const SEVERITY_ACTION = { 3: "Take action", 2: "Be prepared", 1: "Be aware", 0: "Low impact", "-1": "For information" };
const SEVERITY_EXPECT = {
  3: "Severe impact is likely for people in the affected area.",
  2: "Significant impact is possible in the affected area.",
  1: "Some local impact is possible.",
  0: "Low impact is expected. Shown so you are aware of it.",
  "-1": "A reported natural event. The source gives it no impact rating.",
};
// What the hazard can do, and what to do about it.
const GUIDANCE = {
  quake: ["Shaking, with possible aftershocks. Buildings and roads near the centre may be damaged.",
    "During shaking: drop, cover and hold on. Afterwards move away from damaged buildings, and expect aftershocks. Near the coast, move to high ground if the shaking was strong or long."],
  storm: ["Very strong wind, heavy rain, flooding and high waves near the coast.",
    "Stay indoors away from windows. Avoid travel, the coast and flooded roads. Charge your phone and follow official instructions."],
  flood: ["Flooded roads and homes. Water can rise quickly, and may be deeper and faster than it looks.",
    "Move to higher ground. Never walk or drive through flood water. Switch off electricity if water enters the building."],
  volcano: ["Ash fall, poor air and possible flight disruption. Danger is highest close to the volcano.",
    "Stay out of the restricted zone. In ash fall stay indoors, close windows and wear a mask outside."],
  fire: ["Fast-moving fire and heavy smoke. Roads may close.",
    "Leave early if told to. Keep windows closed, avoid the area and wear a mask in smoke."],
  drought: ["Water shortage and higher fire risk over a wide area.", "Save water and avoid open fires."],
  other: ["Conditions in the area may be disrupted.", "Check the official report and follow local instructions."],
};
const GUIDANCE_KEY = {
  earthquake: "quake", EQ: "quake", TC: "storm", severeStorms: "storm", FL: "flood", floods: "flood",
  VO: "volcano", volcanoes: "volcano", WF: "fire", wildfires: "fire", DR: "drought", drought: "drought", landslides: "flood",
};
const guidanceFor = (a) => GUIDANCE[GUIDANCE_KEY[a.category] || "other"];

const CATEGORY_ICONS = {
  earthquake: "〰", EQ: "〰",
  TC: "🌀", severeStorms: "🌀",
  FL: "🌊", floods: "🌊",
  VO: "🌋", volcanoes: "🌋",
  DR: "☀", drought: "☀",
  WF: "🔥", wildfires: "🔥",
  seaLakeIce: "🧊", snow: "❄", landslides: "⛰", dustHaze: "🌫",
  tempExtremes: "🌡", manmade: "🏭", waterColor: "💧",
};
const GDACS_TYPES = { EQ: "Earthquake", TC: "Tropical cyclone", FL: "Flood", VO: "Volcano", DR: "Drought", WF: "Wildfire" };

const state = {
  alerts: [],
  seenIds: new Set(),
  firstLoad: true,
  selectedId: null,
  userPos: null,
  notify: false,
  markers: new Map(),
};

// ---------- Map ----------
const map = L.map("map", { worldCopyJump: true, zoomControl: true }).setView([15, 100], 3);

const baseLayers = {
  Streets: L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap contributors",
  }),
  Satellite: L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    { maxZoom: 19, attribution: "Imagery &copy; Esri" }
  ),
  Dark: L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap &copy; CARTO",
  }),
};
baseLayers.Streets.addTo(map);

// Overlays (animated rain radar, wind arrows) are added by wind.js.
const layerControl = L.control.layers(baseLayers, {}, { position: "topright" }).addTo(map);

// ---------- Wind direction helpers (shared with route.js and wind.js) ----------
// Weather data gives the direction wind comes FROM, in degrees (0 = north, 90 = east).
const COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
const compass = (deg) => COMPASS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
// Arrow pointing the way the wind (or weather) is heading.
const dirArrow = (towardDeg, size = 14, color = "currentColor") =>
  `<svg class="dir-arrow" width="${size}" height="${size}" viewBox="0 0 24 24" style="transform:rotate(${towardDeg}deg)" aria-hidden="true">` +
  `<path d="M12 2 L19 21 L12 16.5 L5 21 Z" fill="${color}"/></svg>`;
const windArrow = (fromDeg, size, color) => dirArrow(fromDeg + 180, size, color);
// Compass bearing (degrees) from point a to point b.
function bearing(a, b) {
  const r = Math.PI / 180;
  const y = Math.sin((b.lon - a.lon) * r) * Math.cos(b.lat * r);
  const x = Math.cos(a.lat * r) * Math.sin(b.lat * r) - Math.sin(a.lat * r) * Math.cos(b.lat * r) * Math.cos((b.lon - a.lon) * r);
  return ((Math.atan2(y, x) / r) + 360) % 360;
}

const REGIONS = {
  world: [[-60, -170], [75, 190]],
  thailand: [[5.5, 97.3], [20.5, 105.7]],
  seasia: [[-11, 92], [28, 141]],
  japan: [[24, 122], [46, 146]],
  europe: [[34, -12], [71, 42]],
  namerica: [[14, -168], [72, -52]],
};

const markerLayer = L.layerGroup().addTo(map);
const userLayer = L.layerGroup().addTo(map);

// ---------- Helpers ----------
const $ = (id) => document.getElementById(id);
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const sevColor = (s) => cssVar(SEVERITY_VARS[s]);
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function timeAgo(ms) {
  const sec = Math.round((Date.now() - ms) / 1000);
  if (sec < 60) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

function distanceKm(a, b) {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Representative point for any GeoJSON geometry (average of all coordinates).
function geomCenter(geom) {
  if (!geom) return null;
  if (geom.type === "Point") return { lon: geom.coordinates[0], lat: geom.coordinates[1] };
  const pts = [];
  (function walk(c) {
    if (typeof c[0] === "number") pts.push(c);
    else c.forEach(walk);
  })(geom.coordinates);
  if (!pts.length) return null;
  return {
    lon: pts.reduce((s, p) => s + p[0], 0) / pts.length,
    lat: pts.reduce((s, p) => s + p[1], 0) / pts.length,
  };
}

// All requests go through net.js (timeouts, retries, typed errors, cache, per-host limits).
function getJSON(url, opts) {
  return fetchJSON(url, opts);
}

// Only http(s) links from feeds are shown as links.
const safeUrl = (u) => (/^https?:\/\//i.test(u || "") ? u : "");

// GDACS sends UTC date-times without a zone ("2026-09-26T16:54:52"); read them as UTC.
const utcMs = (s) => (s ? Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : s + "Z") : NaN);
// Date and time with the time zone shown, e.g. "27 Sep 2026, 10:23 GMT+7".
const fmtDateTime = (ms) =>
  Number.isNaN(ms) ? "—"
  : new Date(ms).toLocaleString([], { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZoneName: "short" });

// ---------- Sources → unified alert model ----------
// { id, source, category, title, severity(-1..3), time(ms), lat, lon, place, details:[[k,v]], description, url }

async function fetchUSGS() {
  const feed = $("quake-feed").value;
  const data = await getJSON(`https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/${feed}.geojson`,
    { timeout: 15000, source: "USGS" });
  const pagerLevel = { green: 0, yellow: 1, orange: 2, red: 3 };
  return data.features.map((f) => {
    const p = f.properties;
    const [lon, lat, depth] = f.geometry.coordinates;
    const mag = p.mag ?? 0;
    const magSev = mag >= 7 ? 3 : mag >= 6 ? 2 : mag >= 4.5 ? 1 : 0;
    const severity = Math.max(magSev, pagerLevel[p.alert] ?? -1);
    return {
      id: `usgs-${f.id}`,
      source: "USGS",
      category: "earthquake",
      title: p.title || `M${mag} earthquake`,
      severity,
      time: p.time,
      lat, lon,
      place: p.place,
      details: [
        ["Magnitude", `${mag.toFixed(1)} ${p.magType || ""}`],
        ["Depth", `${depth?.toFixed(1)} km`],
        ["PAGER alert", p.alert ? p.alert.toUpperCase() : "None"],
        ["Tsunami", p.tsunami ? "⚠ Tsunami information issued" : "No"],
        ["Felt reports", p.felt ?? 0],
        ["Significance", p.sig],
        ["Status", p.status],
      ],
      description: "",
      url: p.url,
    };
  });
}

async function fetchGDACS() {
  const to = new Date();
  const from = new Date(Date.now() - 30 * 864e5);
  const d = (x) => x.toISOString().slice(0, 10);
  const url =
    "https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH" +
    `?eventlist=EQ;TC;FL;VO;DR;WF&alertlevel=green;orange;red&fromdate=${d(from)}&todate=${d(to)}`;
  const data = await getJSON(url, { timeout: 15000, source: "GDACS" });
  const level = { Green: 0, Orange: 2, Red: 3 };
  const byId = new Map();
  for (const f of data.features || []) {
    const p = f.properties;
    // USGS already covers earthquakes in more detail; keep only GDACS quakes that are Orange/Red.
    if (p.eventtype === "EQ" && p.alertlevel === "Green") continue;
    const c = geomCenter(f.geometry);
    if (!c) continue;
    const id = `gdacs-${p.eventtype}-${p.eventid}`;
    const prev = byId.get(id);
    if (prev && prev._episode >= p.episodeid) continue;
    let time = utcMs(p.datemodified || p.todate);
    if (Number.isNaN(time)) time = utcMs(p.fromdate);
    byId.set(id, {
      id,
      _episode: p.episodeid,
      source: "GDACS",
      category: p.eventtype,
      title: p.name || `${GDACS_TYPES[p.eventtype]} – ${p.country}`,
      severity: level[p.alertlevel] ?? 0,
      time,
      lat: c.lat, lon: c.lon,
      place: p.country,
      details: [
        ["Type", GDACS_TYPES[p.eventtype] || p.eventtype],
        ["Alert level", p.alertlevel],
        ["Country", p.country || "—"],
        ["Severity", p.severitydata?.severitytext || "—"],
        ["From", fmtDateTime(utcMs(p.fromdate))],
        ["To", fmtDateTime(utcMs(p.todate))],
        ["Ongoing", p.iscurrent === "true" ? "Yes" : "No"],
        ["Data source", p.source || "—"],
      ],
      description: p.htmldescription || p.description || "",
      url: p.url?.report,
    });
  }
  return [...byId.values()];
}

async function fetchEONET() {
  const data = await getJSON("https://eonet.gsfc.nasa.gov/api/v3/events/geojson?status=open&days=30",
    { timeout: 15000, source: "NASA EONET" });
  // The GeoJSON feed has one feature per observation; keep the latest per event.
  const byId = new Map();
  for (const f of data.features || []) {
    const p = f.properties;
    const t = Date.parse(p.date);
    const prev = byId.get(p.id);
    if (prev && prev.time >= t) continue;
    const c = geomCenter(f.geometry);
    if (!c) continue;
    const cat = p.categories?.[0] || {};
    const sev = cat.id === "severeStorms" || cat.id === "volcanoes" ? 1 : -1;
    byId.set(p.id, {
      id: `eonet-${p.id}`,
      source: "EONET",
      category: cat.id,
      title: p.title,
      severity: sev,
      time: t,
      lat: c.lat, lon: c.lon,
      place: "",
      details: [
        ["Category", cat.title || "—"],
        ["Observed", new Date(t).toLocaleString()],
        ...(p.magnitudeValue != null ? [["Magnitude", `${p.magnitudeValue} ${p.magnitudeUnit || ""}`]] : []),
        ["Sources", (p.sources || []).map((s) => s.id).join(", ") || "—"],
      ],
      description: p.description || "",
      url: p.sources?.[0]?.url || p.link,
    });
  }
  return [...byId.values()];
}

const SOURCES = { USGS: fetchUSGS, GDACS: fetchGDACS, EONET: fetchEONET };

// ---------- Loading ----------
async function loadAll() {
  $("status-text").textContent = "Updating…";
  const names = Object.keys(SOURCES);
  const results = await Promise.allSettled(names.map((n) => SOURCES[n]()));
  const alerts = [];
  const errors = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") alerts.push(...r.value);
    else errors.push(`${names[i]}: ${errorText(r.reason, names[i])}`);
  });

  const fresh = alerts.filter((a) => !state.seenIds.has(a.id));
  alerts.forEach((a) => state.seenIds.add(a.id));
  if (!state.firstLoad) announce(fresh.filter((a) => a.severity >= 2));
  state.firstLoad = false;

  state.alerts = alerts;
  const now = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  $("status-text").textContent =
    `Live · ${alerts.length} alerts · updated ${now}` + (errors.length ? ` · ⚠ ${errors.length} source(s) unavailable` : "");
  $("status-text").title = errors.join(" | ");
  render();
  if (state.route) renderRouteResult();
  if (document.body.dataset.mode === "home") window.renderHome?.();
}

// ---------- Filtering & rendering ----------
function filtered() {
  const sources = new Set([...document.querySelectorAll("#source-chips input:checked")].map((i) => i.value));
  const minSev = Number($("min-severity").value);
  const q = $("search").value.trim().toLowerCase();
  let list = state.alerts.filter(
    (a) =>
      sources.has(a.source) &&
      (minSev === 0 || a.severity >= minSev) &&
      (!q || `${a.title} ${a.place} ${a.category}`.toLowerCase().includes(q))
  );
  if (state.userPos) list.forEach((a) => (a.distance = distanceKm(state.userPos, a)));
  if (state.route) {
    list.forEach((a) => (a.routeDist = routeDistanceKm(a)));
    if ($("near-route").checked) list = list.filter((a) => a.routeDist <= Number($("near-route-km").value));
  }
  const sort = $("sort").value;
  list.sort((a, b) =>
    sort === "severity" ? b.severity - a.severity || b.time - a.time
    : sort === "distance" && state.userPos ? a.distance - b.distance
    : b.time - a.time
  );
  return list;
}

function iconFor(a) {
  return CATEGORY_ICONS[a.category] || "!";
}

function markerFor(a) {
  // Size and shape both rise with severity: ring (info), circle, square (orange), diamond (red).
  const size = a.severity >= 3 ? 30 : a.severity === 2 ? 28 : 24;
  const cls = a.severity === -1 ? "sev-info" : `sev-${a.severity}`;
  const icon = L.divIcon({
    className: "",
    html: `<div class="marker ${cls}"><span>${a.severity >= 1 || a.source !== "USGS" ? iconFor(a) : ""}</span></div>`,
    iconSize: [size, size],
  });
  const m = L.marker([a.lat, a.lon], {
    icon, zIndexOffset: a.severity * 1000, title: `${SEVERITY_NAMES[a.severity]} (${SEVERITY_ACTION[a.severity]}): ${a.title}`,
  });
  m.on("click", () => select(a.id, false));
  return m;
}

function render() {
  const list = filtered();
  markerLayer.clearLayers();
  state.markers.clear();
  list.forEach((a) => {
    const m = markerFor(a);
    m.addTo(markerLayer);
    state.markers.set(a.id, m);
  });

  const counts = [3, 2, 1, 0, -1]
    .map((s) => [s, list.filter((a) => a.severity === s).length])
    .filter(([, n]) => n)
    .map(([s, n]) => `${SEVERITY_NAMES[s]}: ${n}`);
  $("counts").textContent = [`Showing ${list.length}`, ...counts].join(" · ");
  $("tab-count").textContent = list.length;

  const ul = $("alert-list");
  if (!list.length) {
    ul.innerHTML = `<li class="empty">No alerts match your filters.</li>`;
    return;
  }
  ul.innerHTML = list
    .slice(0, 500)
    .map(
      (a) => `
      <li data-id="${esc(a.id)}" class="${a.id === state.selectedId ? "selected" : ""}" style="--bar:${sevColor(a.severity)}">
        <div class="icon" style="background:${sevColor(a.severity)}">${iconFor(a)}</div>
        <div>
          <div class="title">${esc(a.title)}</div>
          <div class="meta"><b style="color:${sevColor(a.severity)}">${SEVERITY_NAMES[a.severity]} · ${SEVERITY_ACTION[a.severity]}</b> · ${esc(a.source)} · ${timeAgo(a.time)}${
            a.distance != null ? ` · ${Math.round(a.distance).toLocaleString()} km away` : ""
          }${a.routeDist != null && state.route ? ` · ${Math.round(a.routeDist)} km from route` : ""
          }${a.place && !a.title.includes(a.place) ? ` · ${esc(a.place)}` : ""}</div>
        </div>
      </li>`
    )
    .join("");
}

function select(id, fly = true) {
  const a = state.alerts.find((x) => x.id === id);
  if (!a) return;
  state.selectedId = id;
  document.querySelectorAll(".alert-list li").forEach((li) => li.classList.toggle("selected", li.dataset.id === id));
  document.querySelector(`.alert-list li[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "nearest" });
  // On phones the details sheet covers the lower part of the map, so keep the marker in the top part.
  const z = fly ? Math.max(map.getZoom(), 6) : map.getZoom();
  let target = L.latLng(a.lat, a.lon);
  if (innerWidth <= 800) target = map.unproject(map.project(target, z).add([0, map.getSize().y * 0.28]), z);
  if (fly || innerWidth <= 800) map.flyTo(target, z, { duration: 0.8 });
  showDetail(a);
}

function showDetail(a) {
  const gmaps = `https://www.google.com/maps/search/?api=1&query=${a.lat.toFixed(5)},${a.lon.toFixed(5)}`;
  const desc = a.description ? `<p>${esc(a.description.replace(/<[^>]*>/g, ""))}</p>` : "";
  const el = $("detail");
  el.innerHTML = `
    <button class="close" aria-label="Close">✕</button>
    <span class="badge" style="background:${sevColor(a.severity)}">${SEVERITY_NAMES[a.severity]} · ${SEVERITY_ACTION[a.severity]}</span>
    <span class="badge src">${esc(a.source)}</span>
    <h2>${iconFor(a)} ${esc(a.title)}</h2>
    <h3 class="d-h">What to expect</h3>
    <p>${SEVERITY_EXPECT[a.severity]} ${guidanceFor(a)[0]}</p>
    <h3 class="d-h">What to do</h3>
    <p>${guidanceFor(a)[1]}</p>
    <h3 class="d-h">Details</h3>
    <dl>
      <dt>Time</dt><dd>${new Date(a.time).toLocaleString()} (${timeAgo(a.time)})</dd>
      <dt>Location</dt><dd>${a.lat.toFixed(3)}, ${a.lon.toFixed(3)}</dd>
      ${a.distance != null ? `<dt>Distance</dt><dd>${Math.round(a.distance).toLocaleString()} km from you</dd>` : ""}
      ${a.details.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}
    </dl>
    <div class="wx-box" id="detail-wx"><span class="muted">Loading current weather…</span></div>
    ${desc}
    <div class="actions">
      <a class="primary" href="${gmaps}" target="_blank" rel="noopener">Open in Google Maps</a>
      ${safeUrl(a.url) ? `<a href="${esc(a.url)}" target="_blank" rel="noopener">Official report ↗</a>` : ""}
    </div>
    <p class="src-line">Source: ${esc(a.source)} · Loaded ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.
      General guidance only; follow local authorities. Emergency in Thailand: 1784 (disaster hotline), 1669 (medical), 191 (police), 199 (fire).</p>`;
  el.classList.remove("hidden");
  pointWeatherHTML(a.lat, a.lon).then((html) => {
    const box = $("detail-wx");
    if (box && state.selectedId === a.id) box.innerHTML = `<div class="muted" style="font-size:12px">Weather there now</div>${html}`;
  });
  el.querySelector(".close").onclick = () => {
    el.classList.add("hidden");
    state.selectedId = null;
    document.querySelectorAll(".alert-list li.selected").forEach((li) => li.classList.remove("selected"));
  };
}

// ---------- New-alert notifications ----------
function announce(newAlerts) {
  newAlerts.slice(0, 5).forEach((a) => {
    const t = document.createElement("div");
    t.className = "toast";
    t.style.borderLeftColor = sevColor(a.severity);
    t.innerHTML = `<strong>New ${SEVERITY_NAMES[a.severity]} alert</strong><br>${esc(a.title)}`;
    t.onclick = () => { select(a.id); t.remove(); };
    $("toasts").appendChild(t);
    setTimeout(() => t.remove(), 15000);
    if (state.notify && "Notification" in window && Notification.permission === "granted") {
      const n = new Notification(`${SEVERITY_NAMES[a.severity]} alert – ${a.source}`, { body: a.title });
      n.onclick = () => { window.focus(); select(a.id); };
    }
  });
}

// ---------- UI wiring ----------
// The app has four modes, each with its own layout: home (overview page), route and alerts
// (side panel + map) and map (full-screen weather map).
function setMode(mode, { push = true } = {}) {
  if (!["home", "route", "alerts", "map"].includes(mode)) mode = "home";
  document.body.dataset.mode = mode;
  document.querySelectorAll("#modes button").forEach((b) => {
    b.classList.toggle("active", b.dataset.mode === mode);
    b.setAttribute("aria-current", b.dataset.mode === mode ? "page" : "false");
  });
  document.querySelectorAll(".tab-panel").forEach((p) => p.classList.toggle("hidden", p.id !== `tab-${mode}`));
  document.querySelector(".sidebar").scrollTop = 0;
  if (push && location.hash !== `#${mode}`) history.replaceState(null, "", `${location.pathname}${location.search}#${mode}`);
  if (mode === "home") window.renderHome?.();
  else setTimeout(() => map.invalidateSize(), 0); // the map changes size between modes
}
const showTab = setMode; // older name, still used by the route and alert code
$("modes").addEventListener("click", (e) => {
  const b = e.target.closest("[data-mode]");
  if (b) setMode(b.dataset.mode);
});

// The "click the map" tip disappears after the first click or 12 seconds.
const hideHint = () => $("map-hint").style.opacity = 0;
map.once("click", hideHint);
setTimeout(hideHint, 12000);

$("alert-list").addEventListener("click", (e) => {
  const li = e.target.closest("li[data-id]");
  if (li) select(li.dataset.id);
});
["search", "min-severity", "sort"].forEach((id) => $(id).addEventListener("input", render));
$("source-chips").addEventListener("change", render);
$("quake-feed").addEventListener("change", loadAll);
$("btn-refresh").addEventListener("click", loadAll);

$("btn-locate").addEventListener("click", () => {
  if (!navigator.geolocation) return alert("Geolocation is not supported by this browser.");
  $("status-text").textContent = "Finding your location…";
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      state.userPos = { lat: pos.coords.latitude, lon: pos.coords.longitude };
      userLayer.clearLayers();
      L.circleMarker([state.userPos.lat, state.userPos.lon], {
        radius: 8, color: "#fff", weight: 2, fillColor: "#2f6fed", fillOpacity: 1,
      }).bindTooltip("You are here").addTo(userLayer);
      L.circle([state.userPos.lat, state.userPos.lon], { radius: 500000, color: "#2f6fed", weight: 1, fillOpacity: 0.05 })
        .addTo(userLayer);
      map.flyTo([state.userPos.lat, state.userPos.lon], 5);
      const sortSel = $("sort");
      sortSel.querySelector('option[value="distance"]').disabled = false;
      sortSel.value = "distance";
      showTab("alerts");
      $("btn-locate").classList.add("active");
      render();
      $("status-text").textContent = `${state.alerts.length} alerts · sorted by distance from you`;
    },
    (err) => ($("status-text").textContent = `Location unavailable: ${err.message}`)
  );
});

$("btn-notify").addEventListener("click", async () => {
  if (!("Notification" in window)) return alert("Notifications are not supported by this browser.");
  if (!state.notify) {
    const perm = await Notification.requestPermission();
    state.notify = perm === "granted";
    $("status-text").textContent = state.notify
      ? "Notifications on: new Orange and Red alerts while this page is open"
      : "Notifications are blocked. Allow them for this site in your browser settings.";
  } else {
    state.notify = false;
  }
  $("btn-notify").classList.toggle("active", state.notify);
});

$("jump-to").addEventListener("change", (e) => {
  const b = REGIONS[e.target.value];
  if (b) map.fitBounds(b);
});

loadAll();
setInterval(loadAll, REFRESH_MS);
setInterval(render, 60 * 1000); // keep "x min ago" fresh
