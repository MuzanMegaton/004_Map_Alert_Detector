/* Home page: the forecast for one place, laid out day by day and hour by hour,
 * with sunrise, sunset, UV, air quality and the alerts nearby, plus the way
 * into the three working modes: Route, Alerts and Weather map.
 * Uses globals from app.js, route.js and wind.js.
 */

const HOME_KEY = "mad.home";
const SAVED_KEY = "mad.locations";
const HOME_DEFAULT = { lat: 13.7563, lon: 100.5018, name: "Bangkok", label: "Bangkok, Thailand" };
const HOME_RADIUS_KM = 1000;
const FORECAST_DAYS = 14;
// From this day on (day 11), the forecast is shown as a lower-confidence outlook.
const OUTLOOK_FROM = 10;

const readJSON = (key, fallback) => {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
};
const writeJSON = (key, value) => {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
};
const homePlace = () => readJSON(HOME_KEY, HOME_DEFAULT);
const savedPlaces = () => readJSON(SAVED_KEY, []);
const samePlace = (a, b) => Math.abs(a.lat - b.lat) < 0.01 && Math.abs(a.lon - b.lon) < 0.01;

function setHomePlace(p) {
  writeJSON(HOME_KEY, { lat: p.lat, lon: p.lon, name: p.name, label: p.label && !p.label.startsWith("📍") ? p.label : p.name });
  home.day = 0;
  home.hour = null;
  renderHome();
}

// ---------- Page frame (built once, so the search box keeps its suggestion list) ----------
$("home").innerHTML = `
  <div class="fc-hero">
    <div class="fc-wrap">
      <div class="fc-search route-field">
        <input id="home-search" type="search" placeholder="Enter a city, landmark or address" aria-label="Search for a place" autocomplete="off" />
      </div>
      <div class="fc-title">
        <h2 id="home-place"></h2>
        <button type="button" id="home-save" class="fc-save"></button>
        <button type="button" id="home-me" class="fc-save">Use my location</button>
      </div>
      <div class="fc-saved" id="home-saved"></div>
    </div>
  </div>

  <div class="fc-wrap">
    <section aria-label="Day by day forecast">
      <div class="fc-days-wrap">
        <button type="button" class="fc-nav" data-scroll="days:-1" aria-label="Earlier days">‹</button>
        <div class="fc-days" id="home-days" role="tablist"></div>
        <button type="button" class="fc-nav" data-scroll="days:1" aria-label="Later days">›</button>
      </div>
    </section>

    <section class="fc-panel" aria-label="Hour by hour forecast">
      <div class="fc-hours-wrap">
        <button type="button" class="fc-nav" data-scroll="hours:-1" aria-label="Earlier hours">‹</button>
        <div class="fc-hours" id="home-hours"></div>
        <button type="button" class="fc-nav" data-scroll="hours:1" aria-label="Later hours">›</button>
      </div>
      <div class="fc-detail" id="home-detail" aria-live="polite"></div>
      <div class="fc-env" id="home-env"></div>
      <p class="fc-updated" id="home-updated"></p>
    </section>

    <div class="fc-grid">
      <section class="fc-card" id="home-alerts" aria-live="polite"></section>
      <section class="fc-card">
        <h3 class="fc-h">More for this place</h3>
        <div class="fc-links">
          <button type="button" data-home="map"><b>Weather map</b><span>Rain radar and wind around here</span></button>
          <button type="button" data-home="route"><b>Route to here</b><span>Check storms, floods and air on the way</span></button>
          <button type="button" data-go="alerts"><b>All alerts</b><span>Earthquakes, cyclones, floods, fires worldwide</span></button>
        </div>
      </section>
    </div>
    <p class="home-foot">Forecast: Open-Meteo. Alerts: USGS, GDACS, NASA EONET. A guide only; follow official warnings.</p>
  </div>`;

// ---------- Data ----------
const home = { key: "", at: 0, fc: null, air: null, day: 0, hour: null };

async function loadForecast(place) {
  const key = `${place.lat.toFixed(3)},${place.lon.toFixed(3)}`;
  if (home.key === key && home.fc && Date.now() - home.at < 10 * 60 * 1000) return;
  const [fc, air] = await Promise.all([
    getJSON(
      `https://api.open-meteo.com/v1/forecast?latitude=${place.lat.toFixed(4)}&longitude=${place.lon.toFixed(4)}` +
      `&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,is_day,wind_speed_10m,wind_direction_10m` +
      `&hourly=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,is_day,precipitation_probability,precipitation,` +
      `wind_speed_10m,wind_direction_10m,wind_gusts_10m,uv_index,visibility` +
      `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset,uv_index_max,wind_speed_10m_max` +
      `&forecast_days=${FORECAST_DAYS}&timezone=auto&timeformat=unixtime`,
      { timeout: 12000, ttl: 10 * 60 * 1000, staleIfError: true, source: "Weather" }
    ),
    airFor([place], 24),
  ]);
  Object.assign(home, { key, at: Date.now(), fc, air: air?.[0]?.current || null });
}

// ---------- Formatting (times are shown in the place's own time zone) ----------
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const localDate = (sec) => new Date((sec + home.fc.utc_offset_seconds) * 1000); // read with getUTC*()
const hhmm = (sec) => { const d = localDate(sec); return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`; };
const windWord = (v) => (v < 12 ? "light winds" : v < 20 ? "a gentle breeze" : v < 30 ? "a moderate breeze" : v < 40 ? "a fresh breeze" : v < 62 ? "strong winds" : "gale-force winds");
const uvWord = (u) => (u == null ? "–" : u < 3 ? "Low" : u < 6 ? "Moderate" : u < 8 ? "High" : u < 11 ? "Very high" : "Extreme");
const uvColor = (u) => (u < 3 ? "var(--sev-0)" : u < 6 ? "var(--sev-1)" : u < 8 ? "var(--sev-2)" : "var(--sev-3)");
// Weather icon; clear and partly cloudy skies get a moon at night.
const wxIcon = (code, isDay) => (!isDay && code <= 1 ? "🌙" : !isDay && code === 2 ? "☁️" : wmo(code)[1]);
// Temperature colour: cold blue through warm yellow to hot red.
function tempStyle(t) {
  const hue = t <= 0 ? 210 : t <= 12 ? 210 - (t / 12) * 40 : t <= 22 ? 170 - ((t - 12) / 10) * 120 : t <= 34 ? 50 - ((t - 22) / 12) * 38 : Math.max(0, 12 - (t - 34) * 2);
  return `background:hsl(${hue.toFixed(0)} 85% ${t > 12 && t < 26 ? 62 : 58}%);color:#1a1a1a`;
}

// ---------- Rendering ----------
function renderDays() {
  const d = home.fc.daily, c = home.fc.current;
  const night = !c.is_day;
  $("home-days").innerHTML = d.time.map((t, i) => {
    const date = localDate(t);
    const icon = i === 0 ? wxIcon(c.weather_code, c.is_day) : wmo(d.weather_code[i])[1];
    const hi = Math.round(d.temperature_2m_max[i]), lo = Math.round(d.temperature_2m_min[i]);
    if (i === 0) {
      return `
      <button type="button" role="tab" class="fc-day today ${home.day === 0 ? "selected" : ""}" data-day="0" aria-selected="${home.day === 0}">
        <span class="d-name">${night ? "Tonight" : "Today"}</span>
        <span class="d-main">
          <span class="d-icon" aria-hidden="true">${icon}</span>
          <span class="d-now"><b>${Math.round(c.temperature_2m)}°</b><small>now</small></span>
          <span class="d-temps">${night ? "" : `<i class="t-chip" style="${tempStyle(hi)}">${hi}°</i>`}<i class="t-chip low">${lo}°</i></span>
          <span class="d-text">${wmo(c.weather_code)[0]} and ${windWord(c.wind_speed_10m)}<small>${d.precipitation_probability_max[0] ?? "–"}% chance of rain today</small></span>
        </span>
      </button>`;
    }
    return `
      <button type="button" role="tab" class="fc-day ${home.day === i ? "selected" : ""} ${i >= OUTLOOK_FROM ? "outlook" : ""}" data-day="${i}" aria-selected="${home.day === i}"
        title="${esc(wmo(d.weather_code[i])[0])}, rain chance ${d.precipitation_probability_max[i] ?? "–"}%">
        <span class="d-name">${DAY_NAMES[date.getUTCDay()]} <b>${date.getUTCDate()}</b></span>
        <span class="d-icon" aria-hidden="true">${icon}</span>
        <span class="d-temps"><i class="t-chip" style="${tempStyle(hi)}">${hi}°</i><i class="t-chip low">${lo}°</i></span>
        <span class="d-rain" title="Chance of rain that day"><i class="drop" aria-hidden="true"></i>${d.precipitation_probability_max[i] ?? "–"}%</span>
        ${i >= OUTLOOK_FROM ? `<span class="d-conf">less certain</span>` : ""}
      </button>`;
  }).join("");
}

// Indices of the hourly rows that belong to the selected day (today starts at the current hour).
function hoursOfDay(day) {
  const h = home.fc.hourly, d = home.fc.daily;
  const start = d.time[day], end = start + 86400;
  const from = day === 0 ? Math.floor(Date.now() / 3600e3) * 3600 : start;
  const idx = h.time.map((t, i) => i).filter((i) => h.time[i] >= from && h.time[i] < end);
  // Late in the evening, carry on into the next morning so the row is never nearly empty.
  if (day === 0 && idx.length < 12) {
    for (let i = (idx.at(-1) ?? h.time.findIndex((t) => t >= from) - 1) + 1; i < h.time.length && idx.length < 12; i++) idx.push(i);
  }
  return idx;
}

function renderHours() {
  const h = home.fc.hourly;
  const idx = hoursOfDay(home.day);
  if (home.hour == null || !idx.includes(home.hour)) home.hour = idx[0] ?? null;
  let lastDay = null;
  $("home-hours").innerHTML = idx.map((i) => {
    const date = localDate(h.time[i]);
    const newDay = lastDay != null && date.getUTCDate() !== lastDay;
    lastDay = date.getUTCDate();
    const pp = h.precipitation_probability[i];
    return `
      <button type="button" class="fc-hour ${i === home.hour ? "selected" : ""}" data-hour="${i}" aria-pressed="${i === home.hour}">
        <span class="h-time">${String(date.getUTCHours()).padStart(2, "0")}<small>00</small>${newDay ? `<em>${DAY_NAMES[date.getUTCDay()]}</em>` : ""}</span>
        <span class="h-icon" aria-hidden="true">${wxIcon(h.weather_code[i], h.is_day[i])}</span>
        <span class="t-chip" style="${tempStyle(h.temperature_2m[i])}">${Math.round(h.temperature_2m[i])}°</span>
        <span class="h-rain ${pp >= 50 ? "wet" : ""}" title="${pp ?? "–"}% chance of any rain in this hour"><i class="drop" aria-hidden="true"></i>${pp ?? "–"}%</span>
        <span class="h-wind" title="Wind from ${compass(h.wind_direction_10m[i])}">
          <i class="w-ring">${Math.round(h.wind_speed_10m[i])}</i>${windArrow(h.wind_direction_10m[i], 12)}
        </span>
      </button>`;
  }).join("");
  renderHourDetail();
}

function renderHourDetail() {
  const h = home.fc.hourly, i = home.hour;
  if (i == null) return ($("home-detail").innerHTML = "");
  const date = localDate(h.time[i]);
  const vis = h.visibility[i];
  $("home-detail").innerHTML = `
    <div class="fd-head"><b>${DAY_NAMES[date.getUTCDay()]} ${hhmm(h.time[i])}</b>
      <span>${wmo(h.weather_code[i])[0]} and ${windWord(h.wind_speed_10m[i])}</span></div>
    <dl class="fd-grid">
      <div><dt>Feels like</dt><dd>${Math.round(h.apparent_temperature[i])}°</dd></div>
      <div><dt title="Chance of any rain in this hour">Chance of rain</dt><dd>${h.precipitation_probability[i] ?? "–"}%</dd></div>
      <div><dt>Rain amount</dt><dd>${h.precipitation[i]} mm</dd></div>
      <div><dt>Humidity</dt><dd>${h.relative_humidity_2m[i]}%</dd></div>
      <div><dt>Wind</dt><dd>${Math.round(h.wind_speed_10m[i])} km/h from ${compass(h.wind_direction_10m[i])}</dd></div>
      <div><dt>Gusts</dt><dd>${Math.round(h.wind_gusts_10m[i])} km/h</dd></div>
      <div><dt>Visibility</dt><dd>${vis == null ? "–" : vis >= 10000 ? "Good" : vis >= 4000 ? "Moderate" : vis >= 1000 ? "Poor" : "Very poor"}</dd></div>
      <div><dt>UV</dt><dd>${h.uv_index[i] == null ? "–" : `${Math.round(h.uv_index[i])} ${uvWord(h.uv_index[i])}`}</dd></div>
    </dl>
    ${home.day >= OUTLOOK_FROM ? `<p class="fd-note">This is ${home.day + 1} days ahead, so treat it as an outlook. The general pattern for the day is more reliable than the hour-by-hour timing.</p>`
      : home.day >= 4 ? `<p class="fd-note">Forecasts this far ahead are less certain, especially the timing of rain.</p>` : ""}`;
}

function renderEnv(place) {
  const d = home.fc.daily, i = home.day;
  const uv = d.uv_index_max[i];
  const [aqLabel, aqColor] = aqiInfo(home.air?.us_aqi);
  $("home-env").innerHTML = `
    <div><span class="env-ic" aria-hidden="true">🌅</span><span>Sunrise<b>${hhmm(d.sunrise[i])}</b></span></div>
    <div><span class="env-ic" aria-hidden="true">🌇</span><span>Sunset<b>${hhmm(d.sunset[i])}</b></span></div>
    <div><span class="env-badge" style="background:${uvColor(uv)}">UV</span><span>${uvWord(uv)}<b>${uv == null ? "–" : Math.round(uv)}</b></span></div>
    <div><span class="env-badge" style="background:${aqColor}">AQI</span><span>${home.air ? esc(aqLabel) : "Not available"}<b>${home.air ? home.air.us_aqi : "–"}</b></span></div>
    <div><span class="env-ic" aria-hidden="true">💧</span><span>Rain chance<b>${d.precipitation_probability_max[i] ?? "–"}%</b></span></div>
    <div><span class="env-ic" aria-hidden="true">💨</span><span>Max wind<b>${Math.round(d.wind_speed_10m_max[i])} km/h</b></span></div>`;
  $("home-updated").textContent =
    `Last updated ${new Date(home.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}. ` +
    `All times are local to ${place.name} (${home.fc.timezone_abbreviation}).` +
    ` % is the chance of any rain in that hour; the amount in mm is shown in the hour details. Times and places are approximate.`;
}

function renderHeader(place) {
  $("home-place").textContent = place.name;
  const saved = savedPlaces();
  const isSaved = saved.some((s) => samePlace(s, place));
  $("home-save").textContent = isSaved ? "✓ Saved" : "+ Add to your locations";
  $("home-save").classList.toggle("on", isSaved);
  $("home-saved").innerHTML = saved.length
    ? `<span>Your locations</span>` + saved.map((s, i) =>
        `<button type="button" data-saved="${i}" class="${samePlace(s, place) ? "on" : ""}">${esc(s.name)}</button>`).join("")
    : "";
}

function homeAlertsHTML(place) {
  if (state.firstLoad) return `<h3 class="fc-h">Alerts nearby</h3><div class="skel"></div><div class="skel" style="width:70%"></div>`;
  const count = (s) => state.alerts.filter((a) => a.severity === s).length;
  const near = state.alerts
    .map((a) => ({ a, d: distanceKm(place, a) }))
    .filter((x) => x.d <= HOME_RADIUS_KM)
    .sort((x, y) => y.a.severity - x.a.severity || x.d - y.d);
  const worst = near.length ? near[0].a.severity : -1;
  const headline =
    !near.length ? "All clear nearby"
    : worst >= 3 ? "Serious alert nearby"
    : worst === 2 ? "Significant alert nearby"
    : `${near.length} alert${near.length > 1 ? "s" : ""} nearby`;
  return `
    <h3 class="fc-h">Alerts within ${HOME_RADIUS_KM.toLocaleString()} km</h3>
    <p class="fc-big" style="${worst >= 2 ? `color:${sevColor(worst)}` : ""}">${headline}</p>
    ${near.length ? `<ul class="h-alerts">${near.slice(0, 4).map(({ a, d }) => `
      <li><button type="button" data-alert="${esc(a.id)}">
        <i class="dot sev-${a.severity === -1 ? "info" : a.severity}"></i>
        <span><b>${esc(a.title)}</b><br><span class="muted">${SEVERITY_NAMES[a.severity]} · ${Math.round(d).toLocaleString()} km away · ${timeAgo(a.time)}</span></span>
      </button></li>`).join("")}</ul>`
      : `<p class="muted">No earthquakes, storms, floods or fires are reported in this area right now.</p>`}
    <div class="world-row">
      <span><b style="color:${sevColor(3)}">${count(3)}</b> Red</span>
      <span><b style="color:${sevColor(2)}">${count(2)}</b> Orange</span>
      <span><b>${count(1)}</b> Yellow</span>
      <span><b>${state.alerts.length}</b> worldwide</span>
    </div>`;
}

let homeSeq = 0;
async function renderHome() {
  const place = homePlace();
  const my = ++homeSeq;
  renderHeader(place);
  $("home-alerts").innerHTML = homeAlertsHTML(place);
  const key = `${place.lat.toFixed(3)},${place.lon.toFixed(3)}`;
  if (home.key !== key || !home.fc) {
    $("home-days").innerHTML = Array.from({ length: 8 }, (_, i) => `<div class="fc-day ${i ? "" : "today"} loading"><div class="skel"></div><div class="skel big"></div></div>`).join("");
    $("home-hours").innerHTML = Array.from({ length: 10 }, () => `<div class="fc-hour loading"><div class="skel"></div><div class="skel big"></div></div>`).join("");
    $("home-detail").innerHTML = $("home-env").innerHTML = "";
    $("home-updated").textContent = "";
  }
  try {
    await loadForecast(place);
    if (my !== homeSeq) return;
    renderDays();
    renderHours();
    renderEnv(place);
  } catch (err) {
    if (my !== homeSeq) return;
    $("home-days").innerHTML = "";
    $("home-hours").innerHTML = `<p class="fc-error">${esc(errorText(err, "Weather"))}
      <button type="button" data-home="retry">Try again</button></p>`;
  }
}
window.renderHome = renderHome;

// ---------- Interaction ----------
setupSuggest($("home-search"), {
  myLocation: true,
  enterPicksFirst: true,
  onChoose(place) {
    rememberPlace(place);
    $("home-search").value = "";
    $("home-search").blur();
    setHomePlace(place);
  },
  async onEnter(q, close) {
    if (q.length < 2) return;
    close();
    try {
      const place = await geocode(q);
      rememberPlace(place);
      $("home-search").value = "";
      setHomePlace(place);
    } catch (err) {
      $("home-hours").innerHTML = `<p class="fc-error">${esc(err.kind === "notfound" ? err.message : errorText(err, "Place search"))}</p>`;
    }
  },
});

$("home").addEventListener("click", (e) => {
  const place = homePlace();
  const go = e.target.closest("[data-go]");
  if (go) return setMode(go.dataset.go);

  const dayBtn = e.target.closest("[data-day]");
  if (dayBtn) {
    home.day = +dayBtn.dataset.day;
    home.hour = null;
    renderDays();
    renderHours();
    renderEnv(place);
    $("home-hours").scrollLeft = 0;
    return;
  }
  const hourBtn = e.target.closest("[data-hour]");
  if (hourBtn) {
    home.hour = +hourBtn.dataset.hour;
    document.querySelectorAll(".fc-hour").forEach((b) => {
      b.classList.toggle("selected", b === hourBtn);
      b.setAttribute("aria-pressed", b === hourBtn);
    });
    return renderHourDetail();
  }
  const scroll = e.target.closest("[data-scroll]");
  if (scroll) {
    const [which, dir] = scroll.dataset.scroll.split(":");
    const el = $(which === "days" ? "home-days" : "home-hours");
    return el.scrollBy({ left: +dir * el.clientWidth * 0.8, behavior: "smooth" });
  }

  if (e.target.closest("#home-save")) {
    const saved = savedPlaces();
    const i = saved.findIndex((s) => samePlace(s, place));
    if (i >= 0) saved.splice(i, 1);
    else saved.unshift(place);
    writeJSON(SAVED_KEY, saved.slice(0, 8));
    return renderHeader(place);
  }
  const savedBtn = e.target.closest("[data-saved]");
  if (savedBtn) return setHomePlace(savedPlaces()[+savedBtn.dataset.saved]);
  if (e.target.closest("#home-me")) {
    return useMyLocation(async (p) => setHomePlace({ ...p, name: (await reverseName(p.lat, p.lon)) || "My location" }));
  }

  const alertBtn = e.target.closest("[data-alert]");
  if (alertBtn) {
    setMode("alerts");
    return setTimeout(() => select(alertBtn.dataset.alert), 60); // after the map has its new size
  }
  const act = e.target.closest("[data-home]")?.dataset.home;
  if (act === "retry") return renderHome();
  if (act === "map") {
    setMode("map");
    return setTimeout(() => {
      map.setView([place.lat, place.lon], 10);
      showWeatherPopup(L.latLng(place.lat, place.lon), place);
    }, 60);
  }
  if (act === "route") {
    setRoutePlace("route-to", { ...place, where: "", icon: "📍", kind: "" });
    setMode("route");
    if ($("route-from").value.trim()) runRoute();
    else $("route-from").focus();
  }
});

// Starting mode: a shared route link opens the route; otherwise the #mode in the address, or Home.
window.addEventListener("hashchange", () => setMode(location.hash.slice(1), { push: false }));
setMode(new URLSearchParams(location.search).get("from") ? "route" : location.hash.slice(1) || "home", { push: false });
