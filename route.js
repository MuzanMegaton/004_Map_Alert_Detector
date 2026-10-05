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

// ---------- Place search ----------
// Places picked from a suggestion list (or "My location"), by the text shown in the box.
const picked = new Map();

// Recently used places, newest first, kept on this device.
const RECENT_KEY = "mad.recent-places";
function recentPlaces() {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY)) || []; } catch { return []; }
}
function rememberPlace(p) {
  if (!p?.label || p.label.startsWith("📍")) return;
  try {
    const { lat, lon, name, label, where = "", icon = "📍", kind = "" } = p;
    const list = [{ lat, lon, name, label, where, icon, kind }, ...recentPlaces().filter((r) => r.label !== label)];
    localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 8)));
  } catch { /* storage unavailable */ }
}

// What kind of place a result is: [icon, label], from the OpenStreetMap tags.
const PLACE_KINDS = [
  [/^aeroway:/, "✈️", "Airport"],
  [/^railway:|:station$|:bus_station$/, "🚉", "Station"],
  [/:hospital$|:clinic$/, "🏥", "Hospital"],
  [/:fuel$|:charging_station$/, "⛽", "Fuel"],
  [/^tourism:(hotel|hostel|guest_house|resort|motel)/, "🏨", "Hotel"],
  [/^tourism:|^historic:/, "📸", "Attraction"],
  [/^shop:|:marketplace$/, "🛍", "Shop"],
  [/:restaurant$|:cafe$|:fast_food$|:food_court$/, "🍜", "Food"],
  [/:university$|:school$|:college$/, "🎓", "School"],
  [/:place_of_worship$/, "🛕", "Temple"],
  [/^natural:|^leisure:(park|nature_reserve)|^boundary:national_park/, "🏞", "Nature"],
  [/^highway:/, "🛣", "Road"],
];
const PLACE_TYPES = {
  country: ["🌏", "Country"], state: ["🗺", "Province"], county: ["🗺", "District"], city: ["🏙", "City"],
  town: ["🏘", "Town"], village: ["🏡", "Village"], district: ["📍", "District"], locality: ["📍", "Area"],
  street: ["🛣", "Road"], house: ["🏢", "Place"],
};
function placeKind(key, value, type) {
  const tag = `${key || ""}:${value || ""}`;
  const hit = PLACE_KINDS.find(([re]) => re.test(tag));
  if (hit) return [hit[1], hit[2]];
  return PLACE_TYPES[type] || PLACE_TYPES[value] || ["📍", "Place"];
}

const hasThai = (s) => /[฀-๿]/.test(s);
const norm = (s) => String(s || "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").trim();

// Photon: OpenStreetMap search that allows search-as-you-type.
// `near` = true asks for places close to the map view; false asks for the best-known places anywhere.
async function photonSearch(q, limit, signal, near) {
  const c = map.getCenter();
  const z = Math.max(6, Math.min(12, Math.round(map.getZoom())));
  // Thai text gets names in the local language; otherwise English names where they exist.
  const r = await getJSON(
    `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=${limit + 4}&lang=${hasThai(q) ? "default" : "en"}` +
    (near ? `&lat=${c.lat.toFixed(1)}&lon=${c.lng.toFixed(1)}&zoom=${z}&location_bias_scale=0.3` : ""),
    { timeout: 12000, retries: 0, ttl: 864e5, signal, source: "Place search" }
  );
  return (r.features || []).map((f, i) => {
    const p = f.properties;
    const name = p.name || [p.housenumber, p.street].filter(Boolean).join(" ") || p.city || q;
    const where = [...new Set([p.district, p.city, p.county, p.state, p.country].filter((v) => v && v !== name))]
      .slice(-3).join(", ");
    const [icon, kind] = placeKind(p.osm_key, p.osm_value, p.type);
    return {
      lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0],
      name, where, icon, kind, label: where ? `${name}, ${where}` : name, cc: p.countrycode || "",
      // The unbiased list comes back with the best-known places first.
      rank: near ? 0 : Math.max(0, 2.5 - i * 0.3),
    };
  });
}

// Nominatim: the backup, used only for a full query (never while typing each letter).
async function nominatimSearch(q, limit, signal) {
  const r = await getJSON(
    `https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit=${limit}&q=${encodeURIComponent(q)}`,
    { timeout: 8000, retries: 1, ttl: 864e5, signal, source: "Place search" }
  );
  return r.map((x) => {
    const parts = x.display_name.split(",").map((s) => s.trim());
    const name = x.name || parts[0];
    const where = parts.filter((s) => s !== name && !/^\d+$/.test(s)).slice(-3).join(", ");
    const [icon, kind] = placeKind(x.category, x.type, x.addresstype);
    return {
      lat: +x.lat, lon: +x.lon, name, where, icon, kind,
      label: where ? `${name}, ${where}` : name, cc: (x.address?.country_code || "").toUpperCase(),
    };
  });
}

// Best matches first: how well the name fits what was typed, how well known the place is,
// towns over single buildings, and a small bonus for being close to the map view.
function rankPlaces(items, q) {
  const nq = norm(q), c = map.getCenter(), here = { lat: c.lat, lon: c.lng };
  const typeScore = { City: 3, Town: 2.5, Province: 2.5, Airport: 2.5, District: 2, Village: 1.5, Station: 1.5, Area: 1.5 };
  const d = (p) => distanceKm(here, p);
  const score = (p) => {
    const n = norm(p.name);
    return (n === nq ? 6 : n.startsWith(nq) ? 4 : n.split(/\s+/).some((w) => w.startsWith(nq)) ? 2.5 : n.includes(nq) ? 1.5 : 0) +
      (p.rank || 0) + (typeScore[p.kind] || 1) + (d(p) < 50 ? 1.5 : d(p) < 300 ? 1 : d(p) < 1500 ? 0.5 : 0);
  };
  const seen = new Set();
  return items
    .map((p) => ({ p, s: score(p) }))
    .sort((a, b) => b.s - a.s)
    .map((x) => x.p)
    .filter((p) => {
      // The same town from two services counts once (same name within about 10 km).
      const k = `${norm(p.name)}|${p.lat.toFixed(1)},${p.lon.toFixed(1)}`;
      return !seen.has(k) && seen.add(k);
    });
}

// Open-Meteo place search: cities, towns and airports. Fast, so its results are shown first.
async function cityNameSearch(q, limit, signal) {
  const r = await getJSON(
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=${limit + 4}&language=${hasThai(q) ? "th" : "en"}&format=json`,
    { timeout: 5000, retries: 1, ttl: 864e5, signal, source: "Place search" }
  );
  return (r.results || []).map((x) => {
    const code = x.feature_code || "";
    const [icon, kind] =
      code.startsWith("AIR") ? ["✈️", "Airport"]
      : code === "PCLI" ? PLACE_TYPES.country
      : code.startsWith("ADM1") ? PLACE_TYPES.state
      : code.startsWith("ADM") ? PLACE_TYPES.district
      : code.startsWith("PPL") ? ((x.population || 0) >= 50000 || /^PPL(C|A)$/.test(code) ? PLACE_TYPES.city : PLACE_TYPES.town)
      : ["📍", "Place"];
    const where = [...new Set([x.admin2, x.admin1, x.country].filter((v) => v && v !== x.name))].slice(-2).join(", ");
    return {
      lat: x.latitude, lon: x.longitude, name: x.name, where, icon, kind,
      label: where ? `${x.name}, ${where}` : x.name, cc: x.country_code || "",
      rank: Math.min(3, Math.log10((x.population || 0) + 10) / 2), // bigger towns first
    };
  });
}

// → { items, error }.
// `full` = the whole query was entered (Enter / Check route), so the slower backup may be used.
// `onPartial(items)` gets the first results as soon as the fastest service answers.
async function searchPlaces(q, { limit = 6, signal, full = false, onPartial } = {}) {
  let items = [], error = null;
  const top = () => rankPlaces(items, q).slice(0, limit);
  // Three views of the same search, merged as they arrive: cities and towns (fast),
  // well-known places anywhere, and places near the map (landmarks, shops, streets).
  const results = await Promise.allSettled(
    [cityNameSearch(q, limit, signal), photonSearch(q, limit, signal, false), photonSearch(q, limit, signal, true)]
      .map((job) => job.then((found) => {
        items = items.concat(found);
        if (found.length) onPartial?.(top());
      }))
  );
  if (signal?.aborted) throw new DOMException("The request was cancelled.", "AbortError");
  if (results.every((r) => r.status === "rejected")) error = results[0].reason;
  if (!items.length && (full || error)) {
    try {
      items = await nominatimSearch(q, limit, signal);
      error = null;
    } catch (err) {
      if (isAbort(err)) throw err;
      error = error || err;
    }
  }
  return { items: top(), error };
}

async function geocode(q) {
  q = q.trim();
  if (picked.has(q)) return picked.get(q);
  const m = q.match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);
  if (m) return { lat: +m[1], lon: +m[2], name: q, label: q };
  const { items, error } = await searchPlaces(q, { limit: 5, full: true });
  if (items.length) return items[0];
  if (error) throw error;
  const e = new Error(`Place not found: "${q}"`);
  e.kind = "notfound";
  throw e;
}

// Puts a place in a route box and remembers it.
function setRoutePlace(id, place) {
  picked.set(place.label, place);
  $(id).value = place.label;
  rememberPlace(place);
}

function useMyLocation(onDone) {
  if (!navigator.geolocation) return alert("Location is not supported by this browser.");
  navigator.geolocation.getCurrentPosition(
    (p) => onDone({ lat: p.coords.latitude, lon: p.coords.longitude, name: "My location", label: "📍 My location", where: "", icon: "📍", kind: "" }),
    (err) => alert(`Location unavailable: ${err.message}`),
    { enableHighAccuracy: false, timeout: 10000 }
  );
}

// Typed text shown in bold inside a result name.
function markMatch(name, q) {
  const i = name.toLowerCase().indexOf(q.toLowerCase());
  return i < 0 || !q ? esc(name) : `${esc(name.slice(0, i))}<mark>${esc(name.slice(i, i + q.length))}</mark>${esc(name.slice(i + q.length))}`;
}

// Suggestion list for a text box: recent places when empty, live results while typing.
// opts: onChoose(place), myLocation (offer "Use my location"), enterPicksFirst (Enter takes the top result)
let suggestCount = 0;
function setupSuggest(input, opts = {}) {
  const box = document.createElement("ul");
  const uid = `suggest-${++suggestCount}`;
  box.id = uid;
  box.className = "suggest hidden";
  box.setAttribute("role", "listbox");
  input.parentElement.appendChild(box);
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-controls", uid);
  input.setAttribute("aria-expanded", "false");
  let items = [], active = -1, timer, seq = 0, ctrl = null, query = "";

  const close = () => {
    seq++;
    ctrl?.abort();
    clearTimeout(timer);
    box.classList.add("hidden");
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
    active = -1;
  };
  const open = (html) => {
    box.innerHTML = html;
    box.classList.remove("hidden");
    input.setAttribute("aria-expanded", "true");
  };
  const choose = (i) => {
    const it = items[i];
    if (!it) return;
    close();
    if (it.action === "me") return useMyLocation((place) => opts.onChoose(place, input));
    opts.onChoose(it, input);
  };
  const row = (it, i) => `
    <li role="option" id="${uid}-${i}" data-i="${i}" class="${i === active ? "active" : ""}" aria-selected="${i === active}">
      <span class="ico" aria-hidden="true">${it.icon}</span>
      <span><b>${it.action ? esc(it.name) : markMatch(it.name, query)}</b>${it.kind ? ` <i class="kind">${esc(it.kind)}</i>` : ""}
        ${it.where ? `<br><small>${esc(it.where)}</small>` : ""}</span>
    </li>`;
  const paint = (head = "", empty = "No places found. Try another spelling, or add the province or country.") => {
    open((head ? `<li class="head">${head}</li>` : "") + (items.length ? items.map(row).join("") : `<li class="none">${empty}</li>`));
    if (active >= 0) {
      input.setAttribute("aria-activedescendant", `${uid}-${active}`);
      box.querySelector(".active")?.scrollIntoView({ block: "nearest" });
    } else input.removeAttribute("aria-activedescendant");
  };
  let head = "";
  const showRecent = () => {
    query = "";
    items = [
      ...(opts.myLocation ? [{ action: "me", name: "Use my location", icon: "📍", where: "", kind: "" }] : []),
      ...recentPlaces(),
    ];
    active = -1;
    head = items.length > (opts.myLocation ? 1 : 0) ? "Recent places" : "";
    if (items.length) paint(head);
  };

  input.addEventListener("focus", () => { if (!input.value.trim()) showRecent(); });
  input.addEventListener("input", () => {
    clearTimeout(timer);
    ctrl?.abort();
    const q = input.value.trim();
    if (!q) return showRecent();
    if (q.length < 2) return close();
    const my = ++seq;
    timer = setTimeout(async () => {
      ctrl = new AbortController();
      const more = `<li class="none more"><i class="spinner"></i>Searching…</li>`;
      // Results of the previous query stay visible while typing; recent places are replaced.
      if (box.classList.contains("hidden") || !items.length || !query) { items = []; open(more); }
      try {
        const res = await searchPlaces(q, {
          signal: ctrl.signal,
          // First results appear as soon as the fastest service answers; slower ones are added after.
          onPartial(found) {
            if (my !== seq || document.activeElement !== input || active >= 0) return;
            query = q;
            items = found;
            head = "";
            paint();
            box.insertAdjacentHTML("beforeend", more);
          },
        });
        if (my !== seq || document.activeElement !== input) return; // a newer search started, or the box was left
        query = q;
        if (active < 0) items = res.items; // don't reshuffle the list under the arrow keys
        head = "";
        paint("", res.error
          ? "Search is unavailable right now. Type the full name and press Enter to try again."
          : undefined);
      } catch { /* cancelled by a newer search */ }
    }, 220);
  });
  input.addEventListener("keydown", (e) => {
    const isOpen = !box.classList.contains("hidden") && items.length;
    if (e.key === "Escape") return close();
    if (e.key === "Enter") {
      if (isOpen && active >= 0) { e.preventDefault(); return choose(active); }
      if (opts.enterPicksFirst) {
        e.preventDefault();
        if (isOpen && query === input.value.trim()) return choose(0);
        return opts.onEnter?.(input.value.trim(), close);
      }
      return close();
    }
    if (!isOpen) return;
    if (e.key === "ArrowDown") { active = (active + 1) % items.length; paint(head); e.preventDefault(); }
    else if (e.key === "ArrowUp") { active = (active - 1 + items.length) % items.length; paint(head); e.preventDefault(); }
  });
  box.addEventListener("mousedown", (e) => {
    const li = e.target.closest("li[data-i]");
    e.preventDefault(); // keep focus in the box
    if (li) choose(+li.dataset.i);
  });
  input.addEventListener("blur", () => setTimeout(close, 150));
  return { close };
}

// Start and destination boxes: picking a place moves on, and runs the check once both are filled.
function chooseRoutePlace(place, input) {
  setRoutePlace(input.id, place);
  if (input.id === "route-from" && !$("route-to").value) $("route-to").focus();
  else if ($("route-from").value && $("route-to").value) runRoute();
}
setupSuggest($("route-from"), { onChoose: chooseRoutePlace, myLocation: true });
setupSuggest($("route-to"), { onChoose: chooseRoutePlace });

// Search box on the map: fly to a place and show its weather.
function goToPlace(place) {
  rememberPlace(place);
  $("map-search").value = place.label;
  $("map-search").blur();
  map.flyTo([place.lat, place.lon], Math.max(map.getZoom(), ["City", "Province", "Country"].includes(place.kind) ? 10 : 13), { duration: 0.8 });
  showWeatherPopup(L.latLng(place.lat, place.lon), place);
}
setupSuggest($("map-search"), {
  onChoose: goToPlace,
  myLocation: true,
  enterPicksFirst: true,
  async onEnter(q, close) {
    if (q.length < 2) return;
    close();
    try {
      goToPlace(await geocode(q));
    } catch (err) {
      L.popup().setLatLng(map.getCenter()).setContent(esc(err.kind === "notfound" ? err.message : errorText(err, "Place search"))).openOn(map);
    }
  },
});

// ---------- Geo helpers ----------

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

// Weather popup for a point (map click or a searched place), with shortcuts to route from or to it.
let popupPlace = null;
async function showWeatherPopup(latlng, place) {
  const popup = L.popup({ maxWidth: 320 }).setLatLng(latlng).setContent(`<i class="spinner"></i>Loading weather…`).openOn(map);
  const [html, name] = await Promise.all([
    pointWeatherHTML(latlng.lat, latlng.lng),
    place?.name || reverseName(latlng.lat, latlng.lng),
  ]);
  const title = name || `${latlng.lat.toFixed(3)}, ${latlng.lng.toFixed(3)}`;
  popupPlace = place?.label && !place.label.startsWith("📍") ? place
    : { lat: latlng.lat, lon: latlng.lng, name: title, label: name ? `${name} (${latlng.lat.toFixed(3)}, ${latlng.lng.toFixed(3)})` : title, where: "", icon: "📍", kind: "" };
  popup.setContent(
    `<b>${esc(title)}</b>${place?.where ? `<br><small class="muted">${esc(place.where)}</small>` : ""}<br>${html}` +
    `<div class="popup-actions"><button type="button" data-route="route-from">Route from here</button>` +
    `<button type="button" data-route="route-to">Route to here</button></div>`
  );
}
map.on("click", (e) => showWeatherPopup(e.latlng));

// "Route from/to here" in a weather popup.
// (Capture phase, because Leaflet stops clicks inside popups from bubbling.)
document.addEventListener("click", (e) => {
  const btn = e.target.closest?.("[data-route]");
  if (!btn || !popupPlace) return;
  setRoutePlace(btn.dataset.route, popupPlace);
  map.closePopup();
  showTab("route");
  if ($("route-from").value && $("route-to").value) runRoute();
  else $(btn.dataset.route === "route-from" ? "route-to" : "route-from").focus();
}, true);

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
  // Show which places were actually used, so a wrong match is easy to spot and fix.
  [["route-from", from], ["route-to", to]].forEach(([id, p]) => {
    if (p.label && !p.label.startsWith("📍")) setRoutePlace(id, p);
  });

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
  useMyLocation((place) => {
    setRoutePlace("route-from", place);
    $("route-to").focus();
  });
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
