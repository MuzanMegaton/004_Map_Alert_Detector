/* Route planner: compares alternative routes and departure times for weather,
 * air quality, river floods and nearby alerts, and recommends the safest option.
 *   Geocoding  – OpenStreetMap Nominatim (forward), BigDataCloud (reverse, client API)
 *   Routing    – OSRM public server               https://router.project-osrm.org
 *   Weather    – Open-Meteo forecast API          https://open-meteo.com
 *   Air        – Open-Meteo Air Quality (CAMS)
 *   Floods     – Open-Meteo Flood API (GloFAS river discharge)
 * Uses globals from app.js (map, state, render, $, esc, getJSON, distanceKm, sevColor).
 */

// WMO weather codes → [label, emoji, risk weight (0 = not a hazard)]
const WMO = {
  0: ["Clear sky", "☀️", 0], 1: ["Mainly clear", "🌤", 0], 2: ["Partly cloudy", "⛅", 0], 3: ["Overcast", "☁️", 0],
  45: ["Fog", "🌫", 4], 48: ["Freezing fog", "🌫", 6],
  51: ["Light drizzle", "🌦", 0], 53: ["Drizzle", "🌦", 0], 55: ["Dense drizzle", "🌧", 0],
  56: ["Freezing drizzle", "🌧", 8], 57: ["Freezing drizzle", "🌧", 8],
  61: ["Light rain", "🌦", 0], 63: ["Rain", "🌧", 0], 65: ["Heavy rain", "🌧", 6],
  66: ["Freezing rain", "🌧", 8], 67: ["Heavy freezing rain", "🌧", 10],
  71: ["Light snow", "🌨", 0], 73: ["Snow", "🌨", 5], 75: ["Heavy snow", "❄️", 8], 77: ["Snow grains", "🌨", 0],
  80: ["Rain showers", "🌦", 0], 81: ["Heavy showers", "🌧", 6], 82: ["Violent showers", "⛈", 8],
  85: ["Snow showers", "🌨", 5], 86: ["Heavy snow showers", "❄️", 8],
  95: ["Thunderstorm", "⛈", 10], 96: ["Thunderstorm with hail", "⛈", 12], 99: ["Severe thunderstorm, hail", "⛈", 12],
};
const wmo = (c) => WMO[c] || ["Unknown", "❔", 0];

const ALERT_WEIGHT = { 3: 40, 2: 15, 1: 4, 0: 1, "-1": 1 };
const DEPARTURES = [0, 1, 2, 3, 6, 12, 24]; // hours from now compared in "best time to leave"
const ROUTE_COLORS = ["#2f6fed", "#7a5af8", "#0e9384"];

const routeLayer = L.layerGroup().addTo(map);
state.route = null; // { from, to, alts:[...], sel, depart }

// ---------- Geo helpers ----------
// Places picked from the suggestion list (or "My location"), by the text shown in the box.
const picked = new Map();

async function geocode(q) {
  q = q.trim();
  if (picked.has(q)) return picked.get(q);
  const m = q.match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);
  if (m) return { lat: +m[1], lon: +m[2], name: q };
  const [best] = await searchPlaces(q, 1);
  if (best) return best;
  const res = await getJSON(
    `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`
  );
  if (!res.length) throw new Error(`Place not found: "${q}"`);
  return { lat: +res[0].lat, lon: +res[0].lon, name: res[0].display_name.split(",").slice(0, 2).join(",") };
}

// Place search by name (Photon, OpenStreetMap data, allows search-as-you-type).
// Results are biased toward the area currently shown on the map.
const PLACE_ICONS = { city: "🏙", town: "🏘", village: "🏡", state: "🗺", country: "🌏", district: "📍", locality: "📍", street: "🛣", house: "🏢" };
async function searchPlaces(q, limit = 6) {
  const c = map.getCenter();
  try {
    const r = await getJSON(
      `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=${limit}&lang=en` +
      `&lat=${c.lat.toFixed(3)}&lon=${c.lng.toFixed(3)}`
    );
    const seen = new Set();
    return r.features
      .map((f) => {
        const p = f.properties;
        const where = [p.city !== p.name && p.city, p.state !== p.name && p.state, p.country !== p.name && p.country]
          .filter(Boolean).join(", ");
        return {
          lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0],
          name: p.name || p.street || q,
          label: where ? `${p.name || p.street}, ${where}` : p.name || q,
          where, icon: PLACE_ICONS[p.type] || "📍",
        };
      })
      .filter((x) => !seen.has(x.label) && seen.add(x.label));
  } catch {
    return [];
  }
}

function setupSuggest(input) {
  const box = document.createElement("ul");
  box.className = "suggest hidden";
  box.setAttribute("role", "listbox");
  input.parentElement.appendChild(box);
  let items = [], active = -1, timer, seq = 0;

  const close = () => { box.classList.add("hidden"); active = -1; };
  const choose = (i) => {
    const it = items[i];
    if (!it) return;
    input.value = it.label;
    picked.set(it.label, it);
    close();
    // Jump to the next empty box, or run the check when both are filled.
    if (input.id === "route-from" && !$("route-to").value) $("route-to").focus();
    else if ($("route-from").value && $("route-to").value) runRoute();
  };
  const paint = () => {
    box.innerHTML = items.length
      ? items.map((it, i) => `
        <li role="option" data-i="${i}" class="${i === active ? "active" : ""}">
          <span class="ico">${it.icon}</span>
          <span><b>${esc(it.name)}</b>${it.where ? `<br><small>${esc(it.where)}</small>` : ""}</span>
        </li>`).join("")
      : `<li class="none">No places found</li>`;
    box.classList.remove("hidden");
  };

  input.addEventListener("input", () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) return close();
    timer = setTimeout(async () => {
      const my = ++seq;
      box.innerHTML = `<li class="none"><i class="spinner"></i>Searching…</li>`;
      box.classList.remove("hidden");
      const res = await searchPlaces(q);
      if (my !== seq) return; // a newer search has started
      items = res;
      active = -1;
      paint();
    }, 250);
  });
  input.addEventListener("keydown", (e) => {
    if (box.classList.contains("hidden") || !items.length) return;
    if (e.key === "ArrowDown") { active = (active + 1) % items.length; paint(); e.preventDefault(); }
    else if (e.key === "ArrowUp") { active = (active - 1 + items.length) % items.length; paint(); e.preventDefault(); }
    else if (e.key === "Enter" && active >= 0) { choose(active); e.preventDefault(); }
    else if (e.key === "Escape") close();
  });
  box.addEventListener("mousedown", (e) => {
    const li = e.target.closest("li[data-i]");
    if (li) { e.preventDefault(); choose(+li.dataset.i); }
  });
  input.addEventListener("blur", () => setTimeout(close, 150));
}
setupSuggest($("route-from"));
setupSuggest($("route-to"));

async function reverseName(lat, lon) {
  try {
    const r = await getJSON(
      `https://api-bdc.io/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=en`
    );
    return r.locality || r.city || r.principalSubdivision || "";
  } catch {
    return "";
  }
}

const selAlt = () => state.route?.alts[state.route.sel];

// Shortest distance (km) from a point to a route (thinned polyline).
function distToAlt(p, alt) {
  let best = Infinity;
  for (const q of alt.sampled) {
    const d = distanceKm(p, q);
    if (d < best) best = d;
  }
  return best;
}
function routeDistanceKm(p) {
  const alt = selAlt();
  return alt ? distToAlt(p, alt) : Infinity;
}

// n points evenly spaced by distance along the route, with their km position.
function pointsAlong(coords, n) {
  const cum = [0];
  for (let i = 1; i < coords.length; i++) {
    cum.push(cum[i - 1] + distanceKm({ lat: coords[i - 1][0], lon: coords[i - 1][1] }, { lat: coords[i][0], lon: coords[i][1] }));
  }
  const total = cum[cum.length - 1];
  const out = [];
  let j = 0;
  for (let k = 0; k < n; k++) {
    const target = (total * k) / (n - 1);
    while (j < cum.length - 1 && cum[j] < target) j++;
    // Driving direction here, measured over a stretch of road so small bends don't matter.
    const s = 15, a = coords[Math.max(0, j - s)], b = coords[Math.min(coords.length - 1, j + s)];
    const heading = bearing({ lat: a[0], lon: a[1] }, { lat: b[0], lon: b[1] });
    out.push({ lat: coords[j][0], lon: coords[j][1], km: cum[j], frac: total ? cum[j] / total : 0, heading });
  }
  return out;
}

// ---------- Weather, air, floods ----------
const HOURLY = "temperature_2m,weather_code,precipitation,precipitation_probability,wind_speed_10m,wind_gusts_10m,wind_direction_10m,visibility," +
  "wind_speed_700hPa,wind_direction_700hPa";
const coordParams = (points) =>
  `latitude=${points.map((p) => p.lat.toFixed(4)).join(",")}&longitude=${points.map((p) => p.lon.toFixed(4)).join(",")}`;
const asList = (d) => (Array.isArray(d) ? d : [d]);

async function weatherFor(points, hours = 48) {
  const data = await getJSON(
    `https://api.open-meteo.com/v1/forecast?${coordParams(points)}` +
    `&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,precipitation,wind_speed_10m,wind_gusts_10m,wind_direction_10m,wind_speed_700hPa,wind_direction_700hPa` +
    `&hourly=${HOURLY}&forecast_hours=${Math.min(hours, 384)}&timeformat=unixtime&timezone=GMT`
  );
  return asList(data);
}

// Returns null on failure so the rest still works.
async function airFor(points, hours = 48) {
  try {
    const data = await getJSON(
      `https://air-quality-api.open-meteo.com/v1/air-quality?${coordParams(points)}` +
      `&current=us_aqi,pm2_5,pm10&hourly=us_aqi,pm2_5&forecast_hours=${Math.min(hours, 96)}` +
      `&timeformat=unixtime&timezone=GMT`
    );
    return asList(data);
  } catch {
    return null;
  }
}

// River flow forecast compared with the past year at the same spot.
// Per point: null (no significant river) or { river, p95, max, days:[{date, q, level}] }.
async function floodFor(points) {
  try {
    const data = asList(await getJSON(
      `https://flood-api.open-meteo.com/v1/flood?${coordParams(points)}` +
      `&daily=river_discharge&past_days=365&forecast_days=16`
    ));
    const today = new Date().toISOString().slice(0, 10);
    return data.map((d) => {
      const t = d.daily?.time || [], q = d.daily?.river_discharge || [];
      const hist = q.filter((v, i) => t[i] < today && v != null).sort((a, b) => a - b);
      if (hist.length < 100) return null;
      const median = hist[Math.floor(hist.length / 2)];
      if (median < 20) return null; // only rivers with meaningful flow (m³/s)
      const p95 = hist[Math.floor(hist.length * 0.95)];
      const max = hist[hist.length - 1];
      const days = t
        .map((date, i) => ({ date, q: q[i] }))
        .filter((x) => x.date >= today && x.q != null)
        .map((x) => ({ ...x, level: x.q >= max ? 2 : x.q >= p95 ? 1 : 0 }));
      return { median, p95, max, days };
    });
  } catch {
    return null;
  }
}

function floodOn(fl, ms) {
  if (!fl) return null;
  const date = new Date(ms).toISOString().slice(0, 10);
  return fl.days.find((d) => d.date === date) || null;
}

function floodText(day) {
  return day.level === 2 ? "Very high river flow (above last year's peak)" : "High river flow (top 5% of last year)";
}

// US AQI bands → [label, color]
function aqiInfo(aqi) {
  if (aqi == null) return ["n/a", "var(--muted)"];
  if (aqi <= 50) return ["Good", "#12b76a"];
  if (aqi <= 100) return ["Moderate", "#eaaa08"];
  if (aqi <= 150) return ["Unhealthy for sensitive groups", "#f79009"];
  if (aqi <= 200) return ["Unhealthy", "#d92d20"];
  if (aqi <= 300) return ["Very unhealthy", "#8e24aa"];
  return ["Hazardous", "#7a0019"];
}

// Hourly values nearest to a time (ms); null if the forecast doesn't reach that far.
function hourAt(w, ms, keys = HOURLY.split(",")) {
  const t = w?.hourly?.time;
  if (!t?.length) return null;
  let i = 0, best = Infinity;
  t.forEach((s, k) => {
    const d = Math.abs(s * 1000 - ms);
    if (d < best) { best = d; i = k; }
  });
  if (best > 2 * 3600e3) return null;
  const h = {};
  for (const key of keys) h[key] = w.hourly[key][i];
  return h;
}

// How the wind hits a car driving toward `heading` (degrees).
// → { kind: "headwind" | "tailwind" | "crosswind", side: "left" | "right", cross: sideways share 0..1 }
function windRelation(fromDeg, heading) {
  const rel = (((fromDeg - heading) % 360) + 360) % 360; // 0 = wind straight from ahead
  const cross = Math.abs(Math.sin((rel * Math.PI) / 180));
  const kind = cross > 0.7 ? "crosswind" : rel < 90 || rel > 270 ? "headwind" : "tailwind";
  return { kind, side: rel < 180 ? "right" : "left", cross };
}

// Short wind description: arrow, speed, where it comes from, and (on a route) how it hits the car.
function windHTML(h, heading) {
  if (h.wind_direction_10m == null) return `💨 ${Math.round(h.wind_speed_10m)} km/h`;
  const rel = heading != null ? windRelation(h.wind_direction_10m, heading) : null;
  return `<span class="wind" title="Wind from ${compass(h.wind_direction_10m)} (${Math.round(h.wind_direction_10m)}°), blowing toward ${compass(h.wind_direction_10m + 180)}">` +
    `${windArrow(h.wind_direction_10m, 13)} ${Math.round(h.wind_speed_10m)} km/h from ${compass(h.wind_direction_10m)}</span>` +
    (rel ? ` <span class="sub">(${rel.kind === "crosswind" ? `crosswind from ${rel.side}` : rel.kind})</span>` : "");
}

// Rain clouds and storms roughly drift with the wind about 3 km up (700 hPa).
function driftHTML(h) {
  if (h.wind_direction_700hPa == null || h.wind_speed_700hPa == null) return "";
  if (h.wind_speed_700hPa < 5) return `Weather drift: <b>almost stationary</b>`;
  const toward = h.wind_direction_700hPa + 180;
  return `Weather moving toward <b>${dirArrow(toward, 13)} ${compass(toward)}</b> at ~${Math.round(h.wind_speed_700hPa)} km/h`;
}

// Hazards at one place/time → [{ t: text, w: risk weight }]
function hazardsOf(h, flood, heading) {
  const list = [];
  if (heading != null && h.wind_direction_10m != null && h.wind_gusts_10m != null) {
    const rel = windRelation(h.wind_direction_10m, heading);
    const crossGust = h.wind_gusts_10m * rel.cross;
    if (crossGust >= 45) list.push({ t: `Strong crosswind from the ${rel.side} (gusts ${Math.round(crossGust)} km/h)`, w: 5 });
  }
  const [label, , weight] = wmo(h.weather_code);
  if (weight) list.push({ t: label, w: weight });
  if (h.wind_gusts_10m >= 90) list.push({ t: `Storm-force gusts ${Math.round(h.wind_gusts_10m)} km/h`, w: 12 });
  else if (h.wind_gusts_10m >= 60) list.push({ t: `Gusts ${Math.round(h.wind_gusts_10m)} km/h`, w: 6 });
  if (h.precipitation >= 5 && !weight) list.push({ t: `Heavy rain ${h.precipitation} mm/h`, w: 5 });
  if (h.visibility != null && h.visibility < 1000 && !/fog/i.test(label)) list.push({ t: `Low visibility ${Math.round(h.visibility)} m`, w: 4 });
  if (h.temperature_2m >= 40) list.push({ t: "Extreme heat", w: 4 });
  if (h.temperature_2m <= -10) list.push({ t: "Extreme cold", w: 4 });
  if (h.us_aqi > 200) list.push({ t: `Very unhealthy air (AQI ${h.us_aqi})`, w: 8 });
  else if (h.us_aqi > 150) list.push({ t: `Unhealthy air (AQI ${h.us_aqi})`, w: 4 });
  if (flood?.level) list.push({ t: floodText(flood), w: flood.level === 2 ? 12 : 6 });
  return list;
}

const riskLabel = (score) =>
  score < 5 ? ["Low", sevColor(0)] : score < 20 ? ["Medium", sevColor(1)] : score < 50 ? ["High", sevColor(2)] : ["Very high", sevColor(3)];

// ---------- Point weather (map click + alert details) ----------
async function pointWeatherHTML(lat, lon) {
  try {
    const pt = [{ lat, lon }];
    const [[w], air, fl] = await Promise.all([weatherFor(pt, 24), airFor(pt, 24), floodFor(pt)]);
    const c = w.current;
    const [label, emoji] = wmo(c.weather_code);
    const aq = air?.[0]?.current;
    const [aqLabel, aqColor] = aqiInfo(aq?.us_aqi);
    const next = w.hourly.time
      .map((_, i) => i)
      .filter((i) => i % 3 === 0)
      .slice(0, 6)
      .map((i) => {
        const [l, e] = wmo(w.hourly.weather_code[i]);
        const t = new Date(w.hourly.time[i] * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
        return `<span title="${esc(l)}">${t} ${e} ${Math.round(w.hourly.temperature_2m[i])}°</span>`;
      })
      .join(" · ");
    const river = fl?.[0];
    const peak = river?.days.reduce((a, b) => (b.q > a.q ? b : a), river.days[0]);
    const riverLine = river && peak
      ? `<div>River flow (7-day peak): <b style="color:${peak.level ? sevColor(peak.level + 1) : "inherit"}">
           ${Math.round(peak.q).toLocaleString()} m³/s on ${new Date(peak.date).toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" })}</b>
           <span class="muted">(normal ≈ ${Math.round(river.median).toLocaleString()})</span>
           ${peak.level ? `<br><span class="error">⚠ ${floodText(peak)}</span>` : ""}</div>`
      : "";
    const haz = hazardsOf({ ...c, visibility: null, us_aqi: aq?.us_aqi });
    return `
      <div><b>${emoji} ${label}, ${Math.round(c.temperature_2m)}°C</b>
        <span class="muted">(feels ${Math.round(c.apparent_temperature)}°C)</span></div>
      <div>Wind: ${windHTML(c)} <span class="muted">· gusts ${Math.round(c.wind_gusts_10m)} km/h</span></div>
      ${driftHTML(c) ? `<div>🧭 ${driftHTML(c)}</div>` : ""}
      <div class="muted">Rain ${c.precipitation} mm · Humidity ${c.relative_humidity_2m}%</div>
      ${aq ? `<div>Air quality: <b style="color:${aqColor}">AQI ${aq.us_aqi} · ${aqLabel}</b>
        <span class="muted">PM2.5 ${aq.pm2_5} µg/m³ · PM10 ${aq.pm10} µg/m³</span></div>` : ""}
      ${riverLine}
      ${haz.length ? `<div class="error">⚠ ${esc(haz.map((x) => x.t).join(", "))}</div>` : ""}
      <div class="muted" style="margin-top:4px;font-size:12px">${next}</div>`;
  } catch (e) {
    return `<span class="error">Weather unavailable: ${esc(e.message)}</span>`;
  }
}

map.on("click", async (e) => {
  const popup = L.popup().setLatLng(e.latlng).setContent("Loading weather…").openOn(map);
  const [html, name] = await Promise.all([pointWeatherHTML(e.latlng.lat, e.latlng.lng), reverseName(e.latlng.lat, e.latlng.lng)]);
  popup.setContent(`${name ? `<b>${esc(name)}</b><br>` : ""}${html}`);
});

// ---------- Route evaluation ----------
// Conditions along one route for a departure `departH` hours from now.
function evaluate(alt, departH) {
  const departMs = state.route.fetchedAt + departH * 3600e3;
  let covered = true;
  const checkpoints = alt.pts.map((p, i) => {
    const eta = departMs + p.frac * alt.hours * 3600e3;
    const h = hourAt(alt.wx[i], eta);
    if (!h) { covered = false; return { ...p, name: alt.names[i], eta, h: null, hazards: [] }; }
    const a = alt.air?.[i] ? hourAt(alt.air[i], eta, ["us_aqi", "pm2_5"]) : null;
    if (a) Object.assign(h, a);
    const flood = floodOn(alt.flood?.[i], eta);
    return { ...p, name: alt.names[i], eta, h, flood, hazards: hazardsOf(h, flood, p.heading) };
  });
  const nearKm = Number($("near-route-km").value);
  const alerts = state.alerts
    .map((a) => ({ a, d: distToAlt(a, alt) }))
    .filter((x) => x.d <= nearKm)
    .sort((x, y) => y.a.severity - x.a.severity);
  const wxScore = checkpoints.reduce((s, c) => s + c.hazards.reduce((t, h) => t + h.w, 0), 0);
  const alertScore = alerts.reduce((s, x) => s + ALERT_WEIGHT[x.a.severity], 0);
  return {
    departH, departMs, covered, checkpoints, alerts,
    warnings: checkpoints.filter((c) => c.hazards.length).length,
    floods: checkpoints.filter((c) => c.flood?.level).length,
    score: wxScore + alertScore,
  };
}

// ---------- Route planning ----------
async function planRoute(fromQ, toQ, departH) {
  loading("Finding places…");
  const [from, to] = await Promise.all([geocode(fromQ), geocode(toQ)]);

  loading("Calculating routes…");
  const r = await getJSON(
    `https://router.project-osrm.org/route/v1/driving/${from.lon},${from.lat};${to.lon},${to.lat}` +
    `?overview=full&geometries=geojson&alternatives=3`
  );
  if (r.code !== "Ok" || !r.routes?.length) throw new Error("No driving route found between these places.");

  const alts = r.routes.slice(0, 3).map((route, k) => {
    const coords = route.geometry.coordinates.map(([lon, lat]) => [lat, lon]);
    const km = route.distance / 1000;
    const step = Math.max(1, Math.floor(coords.length / 400));
    const n = Math.min(10, Math.max(3, Math.round(km / 60) + 1));
    return {
      k, coords, km,
      hours: route.duration / 3600,
      sampled: coords.filter((_, i) => i % step === 0).map(([lat, lon]) => ({ lat, lon })),
      pts: pointsAlong(coords, n),
    };
  });

  // One request per data type covers every checkpoint of every route.
  loading(`Checking weather, air quality and rivers on ${alts.length} route${alts.length > 1 ? "s" : ""}…`);
  const allPts = alts.flatMap((a) => a.pts);
  // Enough forecast for the chosen departure, the later options compared with it, and the drive.
  const hours = Math.ceil(departH + Math.max(...DEPARTURES) + Math.max(...alts.map((a) => a.hours))) + 3;
  const [wx, air, flood, names] = await Promise.all([
    weatherFor(allPts, hours),
    airFor(allPts, hours),
    floodFor(allPts),
    Promise.all(allPts.map((p) => reverseName(p.lat, p.lon))),
  ]);
  let o = 0;
  for (const a of alts) {
    const n = a.pts.length;
    a.wx = wx.slice(o, o + n);
    a.air = air?.slice(o, o + n);
    a.flood = flood?.slice(o, o + n);
    a.names = names.slice(o, o + n).map((nm, i) => nm || `km ${Math.round(a.pts[i].km)}`);
    a.names[0] = from.name;
    a.names[n - 1] = to.name;
    o += n;
  }

  state.route = { from, to, alts, sel: 0, depart: departH, base: departH, fetchedAt: Date.now() };
  // Start on the safest route for the chosen departure time.
  state.route.sel = safestIndex(departH);
  $("near-route-wrap").classList.remove("hidden");
  drawRoute(true);
  render();
  renderRouteResult();
}

function safestIndex(departH) {
  const evals = state.route.alts.map((a) => evaluate(a, departH));
  let best = 0;
  evals.forEach((e, i) => {
    const b = evals[best];
    if (e.score < b.score || (e.score === b.score && state.route.alts[i].hours < state.route.alts[best].hours)) best = i;
  });
  return best;
}

function drawRoute(fit = false) {
  const R = state.route;
  routeLayer.clearLayers();
  R.alts.forEach((a, i) => {
    if (i === R.sel) return;
    L.polyline(a.coords, { color: ROUTE_COLORS[i], weight: 5, opacity: 0.55, dashArray: "10 8", bubblingMouseEvents: false })
      .bindTooltip(`Route ${i + 1} – click to select`, { sticky: true })
      .on("click", () => selectAlt(i))
      .addTo(routeLayer);
  });
  const alt = selAlt();
  const line = L.polyline(alt.coords, { color: ROUTE_COLORS[R.sel], weight: 6, opacity: 0.9 }).addTo(routeLayer);
  L.circleMarker([R.from.lat, R.from.lon], { radius: 7, color: "#fff", weight: 2, fillColor: "#12b76a", fillOpacity: 1 })
    .bindTooltip(`Start: ${R.from.name}`).addTo(routeLayer);
  L.circleMarker([R.to.lat, R.to.lon], { radius: 7, color: "#fff", weight: 2, fillColor: "#d92d20", fillOpacity: 1 })
    .bindTooltip(`Destination: ${R.to.name}`).addTo(routeLayer);

  evaluate(alt, R.depart).checkpoints.forEach((c) => {
    if (!c.h) return;
    const [label, emoji] = wmo(c.h.weather_code);
    const icon = L.divIcon({
      className: "",
      html: `<div class="wx-marker ${c.hazards.length ? "hazard" : ""}">${c.flood?.level ? "🌊" : emoji}` +
        (c.h.wind_direction_10m != null ? `<span class="wind-badge" title="Wind from ${compass(c.h.wind_direction_10m)}">${windArrow(c.h.wind_direction_10m, 12)}</span>` : "") + `</div>`,
      iconSize: [32, 32],
    });
    L.marker([c.lat, c.lon], { icon, zIndexOffset: 5000 })
      .bindPopup(
        `<b>${esc(c.name)}</b> · km ${Math.round(c.km)}<br>` +
        `ETA ${new Date(c.eta).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" })}<br>` +
        `${emoji} ${label}, ${Math.round(c.h.temperature_2m)}°C<br>` +
        `Rain ${c.h.precipitation} mm/h (${c.h.precipitation_probability ?? "–"}%)<br>` +
        `Wind ${windHTML(c.h, c.heading)} · gusts ${Math.round(c.h.wind_gusts_10m)} km/h` +
        (driftHTML(c.h) ? `<br>🧭 ${driftHTML(c.h)}` : "") +
        (c.h.us_aqi != null ? `<br>Air: AQI ${c.h.us_aqi} (${aqiInfo(c.h.us_aqi)[0]}) · PM2.5 ${c.h.pm2_5} µg/m³` : "") +
        (c.flood ? `<br>River: ${Math.round(c.flood.q).toLocaleString()} m³/s` : "") +
        (c.hazards.length ? `<br><b style="color:#d92d20">⚠ ${esc(c.hazards.map((h) => h.t).join(", "))}</b>` : "")
      )
      .addTo(routeLayer);
  });
  if (fit) map.fitBounds(L.featureGroup(R.alts.map((a) => L.polyline(a.coords))).getBounds(), { padding: [40, 40] });
  else line.bringToFront();
}

function selectAlt(i) {
  state.route.sel = i;
  drawRoute();
  render();
  renderRouteResult();
}

function setDeparture(h) {
  state.route.depart = h;
  $("route-depart").value = h > 0 ? toLocalInput(state.route.fetchedAt + h * 3600e3) : "";
  updateWhenHint();
  saveToURL();
  drawRoute();
  renderRouteResult();
}

// Weekday and time; the date is added when it is more than 6 days away, where a weekday alone is ambiguous.
const fmtTime = (ms) => new Date(ms).toLocaleString([], {
  weekday: "short", hour: "2-digit", minute: "2-digit",
  ...(Math.abs(ms - Date.now()) > 6 * 864e5 ? { day: "numeric", month: "short" } : {}),
});
const fmtDur = (h) => `${Math.floor(h)} h ${Math.round((h % 1) * 60)} min`;

function renderRouteResult() {
  const R = state.route;
  if (!R) return;
  const alt = selAlt();
  const ev = evaluate(alt, R.depart);

  // Compare routes (same departure) and departure times (same route).
  const routeEvals = R.alts.map((a) => evaluate(a, R.depart));
  const safest = safestIndex(R.depart);
  const fastest = R.alts.reduce((b, a, i) => (a.hours < R.alts[b].hours ? i : b), 0);
  const departEvals = DEPARTURES.map((h) => evaluate(alt, R.base + h)).filter((e) => e.covered);
  const farAhead = R.depart > 72;
  const bestDep = departEvals.reduce((b, e) => (e.score < b.score ? e : b), departEvals[0]);

  const worstAlert = ev.alerts.length ? ev.alerts[0].a.severity : -2;
  const [risk, riskColor] = riskLabel(ev.score);
  let level, head, text;
  if (worstAlert >= 3) { level = 3; head = "⛔ Serious alert nearby"; text = "Check official sources before travelling."; }
  else if (ev.score >= 20) { level = 2; head = "⚠️ Travel with caution"; text = "There are hazards on this route."; }
  else if (ev.score >= 5) { level = 1; head = "🟡 Mostly fine"; text = "Some weather or alerts to watch along the way."; }
  else { level = 0; head = "✅ Good to go"; text = "No major hazards found along the route."; }
  const tips = [];
  if (safest !== R.sel) tips.push(`Route ${safest + 1} is safer (${riskLabel(routeEvals[safest].score)[0]} risk).`);
  if (bestDep && bestDep.departH !== R.depart && bestDep.score <= ev.score - 5)
    tips.push(`Leaving ${bestDep.departH ? `at ${fmtTime(bestDep.departMs)}` : "now"} lowers the risk to ${riskLabel(bestDep.score)[0]}.`);
  if (ev.floods) tips.push(`High river levels near ${ev.floods} point${ev.floods > 1 ? "s" : ""}. Watch for flooded roads.`);

  const nearKm = Number($("near-route-km").value);
  $("route-result").innerHTML = `
    <div class="verdict" style="--c:${sevColor(level)}">
      <div class="head">${head}</div>
      <div>${text}</div>
      ${tips.length ? `<ul>${tips.map((t) => `<li>💡 ${esc(t)}</li>`).join("")}</ul>` : ""}
    </div>
    <div class="route-summary">
      <div class="stat">Distance<b>${Math.round(alt.km).toLocaleString()} km</b></div>
      <div class="stat">Drive<b>${Math.floor(alt.hours)}h ${Math.round((alt.hours % 1) * 60)}m</b></div>
      <div class="stat">Risk<b style="color:${riskColor}">${risk}</b></div>
      <div class="stat link" id="stat-alerts" title="Show these alerts">Alerts ≤${nearKm} km<b>${ev.alerts.length}</b></div>
      <div class="stat">Warnings<b>${ev.warnings}</b></div>
    </div>
    <div class="share-row"><button type="button" id="btn-share">🔗 Share this route</button></div>

    ${R.alts.length > 1 ? `
    <h3 class="sub-h">Route options</h3>
    <div class="options" id="route-options">
      ${R.alts.map((a, i) => {
        const [rl, rc] = riskLabel(routeEvals[i].score);
        return `
        <button class="option ${i === R.sel ? "selected" : ""}" data-alt="${i}" style="--c:${ROUTE_COLORS[i]}">
          <span class="swatch"></span>
          <span><b>Route ${i + 1}</b> · ${Math.round(a.km)} km · ${fmtDur(a.hours)}<br>
            <span class="sub">Risk <b style="color:${rc}">${rl}</b> · ${routeEvals[i].warnings} warnings · ${routeEvals[i].alerts.length} alerts</span></span>
          <span class="tags">${i === safest ? `<i class="tag safe">Safest</i>` : ""}${i === fastest ? `<i class="tag">Fastest</i>` : ""}</span>
        </button>`;
      }).join("")}
    </div>` : ""}

    <h3 class="sub-h">${R.base ? "Your time and later options" : "Best time to leave"}</h3>
    <div class="options" id="depart-options">
      ${departEvals.map((e) => {
        const [rl, rc] = riskLabel(e.score);
        return `
        <button class="option compact ${e.departH === R.depart ? "selected" : ""}" data-dep="${e.departH}">
          <span><b>${e.departH ? `Leave ${fmtTime(e.departMs)}` : "Leave now"}</b>
            <span class="sub">→ arrive ${fmtTime(e.departMs + alt.hours * 3600e3)}</span></span>
          <span class="sub">${e.warnings} warn.</span>
          <span><b style="color:${rc}">${rl}</b>${e === bestDep ? ` <i class="tag safe">Best</i>` : ""}${R.base && e.departH === R.base ? ` <i class="tag">Your time</i>` : ""}</span>
        </button>`;
      }).join("")}
    </div>

    <h3 class="sub-h">Along the way</h3>
    <ul class="wx-list">
      ${ev.checkpoints.map((c, i) => {
        if (!c.h) return `<li data-i="${i}"><span class="emoji">❔</span><span><span class="where">${esc(c.name)}</span><br>
          <span class="sub">Forecast not available that far ahead</span></span><span></span></li>`;
        const [label, emoji] = wmo(c.h.weather_code);
        return `
        <li data-i="${i}" class="${c.hazards.length ? "hazard" : ""}">
          <span class="emoji">${emoji}</span>
          <span>
            <span class="where">${esc(c.name)}</span> <span class="sub">km ${Math.round(c.km)}</span><br>
            <span class="sub">ETA ${fmtTime(c.eta)} ·
              ${label} · 💧${c.h.precipitation_probability ?? "–"}%<br>${windHTML(c.h, c.heading)}${
              c.h.us_aqi != null ? ` · <span style="color:${aqiInfo(c.h.us_aqi)[1]}">AQI ${c.h.us_aqi}</span>` : ""}${
              c.flood ? ` · 🌊 ${Math.round(c.flood.q).toLocaleString()} m³/s` : ""}</span>
            ${c.hazards.length ? `<br><span class="error">⚠ ${esc(c.hazards.map((h) => h.t).join(", "))}</span>` : ""}
          </span>
          <span class="temp">${Math.round(c.h.temperature_2m)}°</span>
        </li>`;
      }).join("")}
    </ul>
    <p class="muted" style="font-size:12px">${farAhead ? "<b>This trip is more than 3 days away, so treat the forecast as a rough guide and check again closer to the day.</b> " : ""}Weather and air are forecasts for when you reach each point.
      River flow is compared with the past year at the same spot. Alerts near the route are listed below.</p>`;
}

// ---------- Wiring ----------
const EXAMPLES = [["Bangkok", "Chiang Mai"], ["Bangkok", "Pattaya"], ["Chiang Mai", "Phuket"]];
function showHint() {
  $("route-result").innerHTML = `<div class="route-hint">
    Enter where you're going. The app compares routes and departure times for
    <b>storms, floods, air quality</b> and <b>nearby alerts</b>, and recommends the safest option.
    <div class="examples">${EXAMPLES.map(([a, b], i) => `<a data-ex="${i}">${a} → ${b}</a>`).join("")}</div></div>`;
}
const loading = (msg) => ($("route-result").innerHTML = `<div class="loading"><i class="spinner"></i>${msg}</div>`);

function clearRoute() {
  state.route = null;
  routeLayer.clearLayers();
  $("near-route-wrap").classList.add("hidden");
  state.alerts.forEach((a) => delete a.routeDist);
  render();
}

// ---------- Departure date and time ----------
const MAX_AHEAD_DAYS = 14; // weather forecasts reach about 16 days
// Value for a datetime-local input, in the viewer's own time zone.
const toLocalInput = (ms) => new Date(ms - new Date(ms).getTimezoneOffset() * 60000).toISOString().slice(0, 16);

// Hours from now until the chosen departure. 0 means "leave now" (empty or past date).
function chosenDepartH() {
  const input = $("route-depart");
  const ms = input.value ? new Date(input.value).getTime() : NaN;
  if (Number.isNaN(ms) || ms <= Date.now() + 60000) {
    input.value = "";
    updateWhenHint();
    return 0;
  }
  const h = Math.min((ms - Date.now()) / 3600e3, MAX_AHEAD_DAYS * 24);
  if (h === MAX_AHEAD_DAYS * 24) input.value = toLocalInput(Date.now() + h * 3600e3);
  return h;
}

function updateWhenHint() {
  const input = $("route-depart");
  input.min = toLocalInput(Date.now());
  input.max = toLocalInput(Date.now() + MAX_AHEAD_DAYS * 864e5);
  const ms = input.value ? new Date(input.value).getTime() : NaN;
  const days = (ms - Date.now()) / 864e5;
  $("route-when-hint").textContent =
    Number.isNaN(ms) || days <= 0 ? "Leaving now. Pick a date and time to see the forecast for a later trip."
    : days > MAX_AHEAD_DAYS ? `Forecasts reach ${MAX_AHEAD_DAYS} days ahead, so the latest time is used.`
    : days > 3 ? `Leaving ${fmtTime(ms)}. Forecasts more than 3 days ahead are a rough guide.`
    : `Leaving ${fmtTime(ms)}.`;
  $("btn-depart-now").classList.toggle("active", Number.isNaN(ms) || days <= 0);
}

// The current route lives in the page URL, so it can be shared, bookmarked or reloaded.
function saveToURL() {
  // "My location" only means something on this device, so share its coordinates instead.
  const val = (id) => {
    const v = $(id).value.trim(), p = picked.get(v);
    return p && v.startsWith("📍") ? `${p.lat.toFixed(5)},${p.lon.toFixed(5)}` : v;
  };
  const p = new URLSearchParams({ from: val("route-from"), to: val("route-to"), dep: $("route-depart").value });
  if (!p.get("dep")) p.delete("dep");
  history.replaceState(null, "", `?${p}`);
}

async function runRoute() {
  const btn = document.querySelector("#route-form .primary-btn");
  btn.disabled = true;
  btn.textContent = "Checking…";
  try {
    await planRoute($("route-from").value, $("route-to").value, chosenDepartH());
    saveToURL();
  } catch (err) {
    clearRoute();
    const offline = err instanceof TypeError; // fetch network failure
    $("route-result").innerHTML = `<div class="verdict" style="--c:${sevColor(3)}">
      <div class="head">⚠ ${offline ? "Couldn't reach the route service" : esc(err.message)}</div>
      <div>${offline ? "Check your internet connection and try again." : "Check the spelling, or try a nearby city name."}</div></div>`;
  } finally {
    btn.disabled = false;
    btn.textContent = "Check route";
  }
}

$("route-form").addEventListener("submit", (e) => {
  e.preventDefault();
  runRoute();
});

$("route-result").addEventListener("click", async (e) => {
  const ex = e.target.closest("[data-ex]");
  if (ex) {
    [$("route-from").value, $("route-to").value] = EXAMPLES[+ex.dataset.ex];
    return runRoute();
  }
  if (e.target.closest("#btn-share")) {
    const btn = e.target.closest("#btn-share");
    try {
      await navigator.clipboard.writeText(location.href);
      btn.textContent = "✓ Link copied";
    } catch {
      prompt("Copy this link:", location.href);
    }
    setTimeout(() => (btn.textContent = "🔗 Share this route"), 2000);
  }
});

showHint();
updateWhenHint();
{
  const p = new URLSearchParams(location.search);
  if (p.get("from") && p.get("to")) {
    $("route-from").value = p.get("from");
    $("route-to").value = p.get("to");
    // A shared departure date and time is used only while it is still in the future.
    if (/^\d{4}-\d\d-\d\dT\d\d:\d\d/.test(p.get("dep") || "")) $("route-depart").value = p.get("dep");
    // Wait for alerts to load so the route check includes them.
    const wait = setInterval(() => {
      if (state.alerts.length || !state.firstLoad) { clearInterval(wait); runRoute(); }
    }, 300);
  }
}

// A new date or time needs a fresh forecast for that period, so the route is checked again.
$("route-depart").addEventListener("change", () => {
  updateWhenHint();
  if (state.route) runRoute();
});
$("btn-depart-now").addEventListener("click", () => {
  $("route-depart").value = "";
  updateWhenHint();
  if (state.route) runRoute();
});

$("btn-route-clear").addEventListener("click", () => {
  clearRoute();
  showHint();
  history.replaceState(null, "", location.pathname);
});

$("btn-swap").addEventListener("click", () => {
  [$("route-from").value, $("route-to").value] = [$("route-to").value, $("route-from").value];
});

$("route-result").addEventListener("click", (e) => {
  if (e.target.closest("#stat-alerts")) showTab("alerts");
});

$("btn-from-me").addEventListener("click", () => {
  navigator.geolocation?.getCurrentPosition(
    (p) => {
      const label = "📍 My location";
      picked.set(label, { lat: p.coords.latitude, lon: p.coords.longitude, name: "My location" });
      $("route-from").value = label;
      $("route-to").focus();
    },
    (err) => alert(`Location unavailable: ${err.message}`)
  );
});

["near-route", "near-route-km"].forEach((id) =>
  $(id).addEventListener("input", () => { render(); renderRouteResult(); })
);

$("route-result").addEventListener("click", (e) => {
  const altBtn = e.target.closest("[data-alt]");
  if (altBtn) return selectAlt(+altBtn.dataset.alt);
  const depBtn = e.target.closest("[data-dep]");
  if (depBtn) return setDeparture(+depBtn.dataset.dep);
  const li = e.target.closest("li[data-i]");
  if (li) {
    const c = selAlt().pts[+li.dataset.i];
    map.flyTo([c.lat, c.lon], 9, { duration: 0.8 });
  }
});
