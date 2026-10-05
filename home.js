/* Home page: an overview for one place (weather now, air quality, alerts nearby)
 * and the way into the three working modes: Route, Alerts and Weather map.
 * Uses globals from app.js, route.js and wind.js.
 */

const HOME_KEY = "mad.home";
const HOME_DEFAULT = { lat: 13.7563, lon: 100.5018, name: "Bangkok", label: "Bangkok, Thailand" };
const HOME_RADIUS_KM = 1000;

function homePlace() {
  try { return JSON.parse(localStorage.getItem(HOME_KEY)) || HOME_DEFAULT; } catch { return HOME_DEFAULT; }
}
function setHomePlace(p) {
  const place = { lat: p.lat, lon: p.lon, name: p.name, label: p.label && !p.label.startsWith("📍") ? p.label : p.name };
  try { localStorage.setItem(HOME_KEY, JSON.stringify(place)); } catch { /* storage unavailable */ }
  homeWx = null;
  renderHome();
}

// The page frame is built once, so the search box keeps its suggestion list between updates.
$("home").innerHTML = `
  <div class="home-inner">
    <header class="home-hero">
      <svg class="hero-art" viewBox="0 0 420 300" fill="none" stroke="currentColor" aria-hidden="true">
        <g class="contours" stroke-width="1">
          <path d="M40 220c30-70 90-40 120-90s80-70 140-50 90 70 80 120-70 80-150 80-210-10-190-60z"/>
          <path d="M78 214c24-50 72-30 98-70s64-54 110-40 70 52 62 90-56 60-118 60-168-6-152-40z"/>
          <path d="M118 206c18-32 54-20 74-48s46-38 80-28 50 36 44 62-40 42-86 42-124-4-112-28z"/>
          <path d="M160 198c12-18 34-12 48-28s30-24 52-18 32 22 28 38-26 26-56 26-80-2-72-18z"/>
          <path d="M206 190c6-8 16-6 24-12s14-10 24-8 14 10 12 16-12 10-26 10-38 0-34-6z"/>
        </g>
        <path class="trail" d="M56 252c40-10 60-60 104-66s52 34 96 20 50-78 108-96" stroke-width="2" stroke-dasharray="1 9" stroke-linecap="round"/>
        <circle class="node" cx="56" cy="252" r="5"/><circle class="node warn" cx="256" cy="206" r="5"/><circle class="node end" cx="364" cy="110" r="5"/>
        <circle class="pulse" cx="256" cy="206" r="12"/>
      </svg>
      <p class="eyebrow" id="home-date"></p>
      <h2>Know before you go.</h2>
      <p class="lede">Live alerts, weather, air quality and flood risk, for where you are and where you're heading.</p>
      <div class="home-search route-field">
        <input id="home-search" type="search" placeholder="Check a place: city, landmark or address" aria-label="Check a place" autocomplete="off" />
      </div>
    </header>

    <div class="home-grid">
      <section class="h-card" id="home-now" aria-live="polite"></section>
      <section class="h-card" id="home-alerts" aria-live="polite"></section>
    </div>

    <h3 class="sub-h">What do you want to do?</h3>
    <div class="home-modes">
      <button type="button" data-go="route">
        <svg class="m-ic" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="6" cy="18" r="2.2"/><circle cx="18" cy="6" r="2.2"/><path d="M8 17c5-1 2-9 8-10"/></svg>
        <b>Check a route</b>
        <span>Compare routes and departure times for storms, floods, wind and air quality.</span>
        <i>Route <span class="arr">→</span></i>
      </button>
      <button type="button" data-go="alerts">
        <svg class="m-ic" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3.5 2.8 19.5h18.4L12 3.5z"/><path d="M12 10v4.2M12 16.8v.2"/></svg>
        <b>Browse alerts</b>
        <span>Earthquakes, cyclones, floods, volcanoes and wildfires, worldwide and live.</span>
        <i>Alerts <span class="arr">→</span></i>
      </button>
      <button type="button" data-go="map">
        <svg class="m-ic" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 17a4 4 0 0 1-.6-7.96A5.5 5.5 0 0 1 17 9.5a3.75 3.75 0 0 1 .5 7.47"/><path d="M9 20l1-2M13 20l1-2M17 20l1-2"/></svg>
        <b>Explore the weather map</b>
        <span>Moving rain radar and wind direction. Tap anywhere for the local forecast.</span>
        <i>Weather map <span class="arr">→</span></i>
      </button>
    </div>

    <div id="home-recent"></div>
    <p class="home-foot">Data: USGS, GDACS, NASA EONET, Open-Meteo, RainViewer, OpenStreetMap. A guide only; follow official warnings.</p>
  </div>`;

let homeWx = null; // { key, at, w, air }

async function loadHomeWeather(place) {
  const key = `${place.lat.toFixed(3)},${place.lon.toFixed(3)}`;
  if (homeWx?.key === key && Date.now() - homeWx.at < 10 * 60 * 1000) return homeWx;
  const [[w], air] = await Promise.all([weatherFor([place], 24), airFor([place], 24)]);
  homeWx = { key, at: Date.now(), w, air: air?.[0]?.current || null };
  return homeWx;
}

function homeNowHTML(place, wx) {
  const c = wx.w.current;
  const [label, emoji] = wmo(c.weather_code);
  const [aqLabel, aqColor] = aqiInfo(wx.air?.us_aqi);
  const hz = hazardsOf({ ...c, visibility: null, us_aqi: wx.air?.us_aqi });
  const hours = wx.w.hourly.time
    .map((t, i) => i)
    .filter((i) => i > 0 && i % 3 === 0)
    .slice(0, 6)
    .map((i) => `
      <li><span>${new Date(wx.w.hourly.time[i] * 1000).toLocaleTimeString([], { hour: "numeric" })}</span>
        <span class="e" title="${esc(wmo(wx.w.hourly.weather_code[i])[0])}">${wmo(wx.w.hourly.weather_code[i])[1]}</span>
        <b>${Math.round(wx.w.hourly.temperature_2m[i])}°</b>
        <span class="muted">${wx.w.hourly.precipitation_probability[i] ?? "–"}%</span></li>`)
    .join("");
  return `
    <div class="h-head"><span class="eyebrow">Now in</span>
      <button type="button" class="link" id="home-me">Use my location</button></div>
    <h3 class="h-place">${esc(place.name)}</h3>
    <div class="now">
      <span class="now-emoji" aria-hidden="true">${emoji}</span>
      <span class="now-temp">${Math.round(c.temperature_2m)}°</span>
      <span class="now-text"><b>${label}</b><br><span class="muted">Feels ${Math.round(c.apparent_temperature)}° · Humidity ${c.relative_humidity_2m}%</span></span>
    </div>
    <dl class="facts">
      <div><dt>Wind</dt><dd>${windHTML(c)}</dd></div>
      <div><dt>Air quality</dt><dd>${wx.air ? `<b style="color:${aqColor}">AQI ${wx.air.us_aqi}</b> ${aqLabel}` : "Not available"}</dd></div>
      ${driftHTML(c) ? `<div><dt>Weather</dt><dd>${driftHTML(c).replace("Weather moving toward", "Moving toward")}</dd></div>` : ""}
    </dl>
    ${hz.length ? `<p class="h-warn">${esc(hz.map((x) => x.t).join(" · "))}</p>` : ""}
    ${tempTrendSVG(wx.w.hourly.temperature_2m)}
    <ul class="hours">${hours}</ul>
    <div class="h-actions">
      <button type="button" data-home="map">Open on map</button>
      <button type="button" data-home="route">Route to here</button>
    </div>`;
}

// Temperature over the next 24 hours as a small line, with the high and low marked.
function tempTrendSVG(temps) {
  const t = (temps || []).filter((v) => v != null);
  if (t.length < 4) return "";
  const W = 320, H = 46, pad = 6;
  const lo = Math.min(...t), hi = Math.max(...t), span = hi - lo || 1;
  const x = (i) => (i * W) / (t.length - 1);
  const y = (v) => pad + (H - 2 * pad) * (1 - (v - lo) / span);
  const line = t.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(" ");
  const iHi = t.indexOf(hi), iLo = t.indexOf(lo);
  return `
    <figure class="trend" aria-label="Temperature over the next 24 hours: high ${Math.round(hi)}°, low ${Math.round(lo)}°">
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
        <path class="area" d="${line} L${W} ${H} L0 ${H} Z"/>
        <path class="line" d="${line}"/>
        <circle cx="${x(iHi).toFixed(1)}" cy="${y(hi).toFixed(1)}" r="2.5"/>
        <circle cx="${x(iLo).toFixed(1)}" cy="${y(lo).toFixed(1)}" r="2.5"/>
      </svg>
      <figcaption><span>Next 24 hours</span><span>High <b>${Math.round(hi)}°</b> · Low <b>${Math.round(lo)}°</b></span></figcaption>
    </figure>`;
}

const SKELETON = `<div class="skel" style="width:40%"></div><div class="skel big"></div><div class="skel"></div><div class="skel" style="width:70%"></div>`;

function homeAlertsHTML(place) {
  if (state.firstLoad) return `<span class="eyebrow">Alerts</span>${SKELETON}`;
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
    <div class="h-head"><span class="eyebrow">Alerts within ${HOME_RADIUS_KM.toLocaleString()} km of ${esc(place.name)}</span></div>
    <h3 class="h-place" style="${worst >= 2 ? `color:${sevColor(worst)}` : ""}">${headline}</h3>
    ${near.length ? `<ul class="h-alerts">${near.slice(0, 4).map(({ a, d }) => `
      <li><button type="button" data-alert="${esc(a.id)}">
        <i class="dot sev-${a.severity === -1 ? "info" : a.severity}"></i>
        <span><b>${esc(a.title)}</b><br><span class="muted">${Math.round(d).toLocaleString()} km away · ${timeAgo(a.time)}</span></span>
      </button></li>`).join("")}</ul>`
      : `<p class="muted">No earthquakes, storms, floods or fires are reported in this area right now.</p>`}
    <div class="world">
      <span class="eyebrow">Worldwide now</span>
      <div class="world-row">
        <span><b style="color:${sevColor(3)}">${count(3)}</b> Red</span>
        <span><b style="color:${sevColor(2)}">${count(2)}</b> Orange</span>
        <span><b>${count(1)}</b> Yellow</span>
        <span><b>${state.alerts.length}</b> total</span>
      </div>
    </div>
    <div class="h-actions"><button type="button" data-go="alerts">See all alerts</button></div>`;
}

let homeSeq = 0;
async function renderHome() {
  const place = homePlace();
  const my = ++homeSeq;
  $("home-date").textContent = new Date().toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" });
  $("home-alerts").innerHTML = homeAlertsHTML(place);
  const recent = recentPlaces().slice(0, 6);
  $("home-recent").innerHTML = recent.length
    ? `<h3 class="sub-h">Recent places</h3><div class="examples">${recent.map((r, i) => `<a data-recent="${i}">${esc(r.name)}</a>`).join("")}</div>`
    : "";
  if (!homeWx || homeWx.key !== `${place.lat.toFixed(3)},${place.lon.toFixed(3)}`) {
    $("home-now").innerHTML = `<span class="eyebrow">Now in</span><h3 class="h-place">${esc(place.name)}</h3>${SKELETON}`;
  }
  try {
    const wx = await loadHomeWeather(place);
    if (my === homeSeq) $("home-now").innerHTML = homeNowHTML(place, wx);
  } catch (err) {
    if (my === homeSeq) {
      $("home-now").innerHTML = `<span class="eyebrow">Now in</span><h3 class="h-place">${esc(place.name)}</h3>
        <p class="error">${esc(errorText(err, "Weather"))}</p>
        <div class="h-actions"><button type="button" data-home="retry">Try again</button></div>`;
    }
  }
}
window.renderHome = renderHome;

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
      $("home-now").innerHTML = `<p class="error">${esc(err.kind === "notfound" ? err.message : errorText(err, "Place search"))}</p>`;
    }
  },
});

$("home").addEventListener("click", (e) => {
  const place = homePlace();
  const go = e.target.closest("[data-go]");
  if (go) return setMode(go.dataset.go);
  const alertBtn = e.target.closest("[data-alert]");
  if (alertBtn) {
    setMode("alerts");
    return setTimeout(() => select(alertBtn.dataset.alert), 60); // after the map has its new size
  }
  const rec = e.target.closest("[data-recent]");
  if (rec) return setHomePlace(recentPlaces()[+rec.dataset.recent]);
  if (e.target.closest("#home-me")) {
    return useMyLocation(async (p) => setHomePlace({ ...p, name: (await reverseName(p.lat, p.lon)) || "My location" }));
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
