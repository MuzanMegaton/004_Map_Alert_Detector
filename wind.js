/* Direction of weather on the map:
 *   - Animated rain radar: the last ~2 hours of RainViewer frames, played in a loop,
 *     so you can see which way rain is moving.
 *   - Wind arrows: a grid of arrows showing where the wind is blowing, with the
 *     estimated drift of rain clouds and storms (wind ~3 km up).
 * Uses globals from app.js (map, layerControl, getJSON, esc, compass, windArrow, dirArrow).
 */

// ---------- Animated rain radar ----------
const radar = { group: L.layerGroup(), layers: [], frames: [], idx: 0, timer: null, playing: false };
const RADAR_ATTR = 'Radar &copy; <a href="https://www.rainviewer.com">RainViewer</a>';

async function loadRadarFrames() {
  try {
    const d = await getJSON("https://api.rainviewer.com/public/weather-maps.json");
    const past = d.radar.past || [];
    // Every other 10-minute frame: ~7 frames over 2 hours keeps it light but shows movement.
    const frames = past.filter((_, i) => (past.length - 1 - i) % 2 === 0);
    if (!frames.length) return;
    const wasOn = map.hasLayer(radar.group);
    radar.group.clearLayers();
    radar.frames = frames;
    radar.layers = frames.map((f) => {
      const layer = L.tileLayer(`${d.host}${f.path}/256/{z}/{x}/{y}/2/1_1.png`, {
        opacity: 0, maxNativeZoom: 7, maxZoom: 19, zIndex: 400, attribution: RADAR_ATTR,
      });
      radar.group.addLayer(layer);
      return layer;
    });
    $("radar-slider").max = frames.length - 1;
    showFrame(frames.length - 1);
    if (wasOn && radar.playing) play();
  } catch (e) {
    console.warn("Radar unavailable:", e.message);
  }
}

function showFrame(i) {
  radar.idx = i;
  radar.layers.forEach((l, k) => l.setOpacity(k === i ? 0.7 : 0));
  const f = radar.frames[i];
  if (!f) return;
  const t = new Date(f.time * 1000);
  const mins = Math.round((Date.now() - t) / 60000);
  $("radar-slider").value = i;
  $("radar-time").textContent =
    `${t.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · ` +
    (i === radar.frames.length - 1 ? "latest" : `${mins} min ago`);
}

function play() {
  clearInterval(radar.timer);
  radar.playing = true;
  $("radar-play").textContent = "⏸";
  radar.timer = setInterval(() => {
    // Hold a little longer on the latest frame before looping.
    if (radar.idx === radar.frames.length - 1 && !radar.hold) { radar.hold = true; return; }
    radar.hold = false;
    showFrame((radar.idx + 1) % radar.frames.length);
  }, 700);
}
function pause() {
  clearInterval(radar.timer);
  radar.playing = false;
  $("radar-play").textContent = "▶";
}

$("radar-play").addEventListener("click", () => (radar.playing ? pause() : play()));
$("radar-slider").addEventListener("input", (e) => { pause(); showFrame(+e.target.value); });

// ---------- Wind arrows ----------
const windLayer = L.layerGroup();
let windTimer, windSeq = 0;

// Color by wind speed (km/h).
const windColor = (v) => (v < 10 ? "#2e90fa" : v < 20 ? "#12b76a" : v < 35 ? "#eaaa08" : v < 50 ? "#f79009" : "#d92d20");

async function loadWind() {
  const my = ++windSeq;
  const b = map.getBounds().pad(-0.04);
  const size = map.getSize();
  const cols = Math.max(3, Math.min(8, Math.round(size.x / 110)));
  const rows = Math.max(3, Math.min(7, Math.round(size.y / 110)));
  const s = Math.max(b.getSouth(), -80), n = Math.min(b.getNorth(), 80);
  const w = b.getWest(), e = b.getEast();
  const pts = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const lat = s + ((r + 0.5) * (n - s)) / rows;
      let lon = w + ((c + 0.5) * (e - w)) / cols;
      lon = ((((lon + 180) % 360) + 360) % 360) - 180; // wrap for the API
      pts.push({ lat, lon, mapLon: w + ((c + 0.5) * (e - w)) / cols });
    }
  }
  try {
    const data = await getJSON(
      `https://api.open-meteo.com/v1/forecast?latitude=${pts.map((p) => p.lat.toFixed(2)).join(",")}` +
      `&longitude=${pts.map((p) => p.lon.toFixed(2)).join(",")}` +
      `&current=wind_speed_10m,wind_direction_10m,wind_gusts_10m,wind_speed_700hPa,wind_direction_700hPa`
    );
    if (my !== windSeq || !map.hasLayer(windLayer)) return;
    windLayer.clearLayers();
    (Array.isArray(data) ? data : [data]).forEach((d, i) => {
      const c = d.current;
      if (c?.wind_direction_10m == null) return;
      const v = c.wind_speed_10m;
      const px = Math.round(22 + Math.min(v, 60) / 3); // longer arrow = stronger wind
      const icon = L.divIcon({
        className: "",
        html: `<div class="wind-pin">${windArrow(c.wind_direction_10m, px, windColor(v))}<span>${Math.round(v)}</span></div>`,
        iconSize: [44, 44],
      });
      const toward = c.wind_direction_700hPa + 180;
      L.marker([pts[i].lat, pts[i].mapLon], { icon, interactive: true, keyboard: false })
        .bindTooltip(
          `Wind ${Math.round(v)} km/h from ${compass(c.wind_direction_10m)} (${Math.round(c.wind_direction_10m)}°), ` +
          `gusts ${Math.round(c.wind_gusts_10m)} km/h<br>` +
          (c.wind_speed_700hPa != null
            ? `Weather moving toward ${compass(toward)} at ~${Math.round(c.wind_speed_700hPa)} km/h`
            : ""),
          { direction: "top" }
        )
        .addTo(windLayer);
    });
  } catch (e) {
    console.warn("Wind unavailable:", e.message);
  }
}

map.on("moveend resize", () => {
  if (!map.hasLayer(windLayer)) return;
  clearTimeout(windTimer);
  windTimer = setTimeout(loadWind, 500);
});

// ---------- Layer switcher + legend ----------
layerControl.addOverlay(radar.group, "Rain radar (moving, last 2 h)");
layerControl.addOverlay(windLayer, "Wind direction");

map.on("overlayadd", (e) => {
  if (e.layer === radar.group) {
    $("radar-player").classList.remove("hidden");
    $("map-hint").style.opacity = 0;
    play();
  }
  if (e.layer === windLayer) {
    $("wind-legend").classList.remove("hidden");
    loadWind();
  }
});
map.on("overlayremove", (e) => {
  if (e.layer === radar.group) { pause(); $("radar-player").classList.add("hidden"); }
  if (e.layer === windLayer) { windLayer.clearLayers(); $("wind-legend").classList.add("hidden"); }
});

$("wind-legend").innerHTML =
  `<b>Wind</b> ${[[5, "&lt;10"], [15, "10–20"], [27, "20–35"], [42, "35–50"], [60, "50+"]]
    .map(([v, t]) => `<span>${dirArrow(0, 12, windColor(v))}${t}</span>`).join("")} km/h`;

loadRadarFrames();
setInterval(loadRadarFrames, 10 * 60 * 1000);
setInterval(() => map.hasLayer(windLayer) && loadWind(), 15 * 60 * 1000);

// ---------- Quick layer buttons on the map ----------
const CHIP_LAYERS = { radar: radar.group, wind: windLayer };
function syncLayerChips() {
  document.querySelectorAll("#layer-chips [data-layer]").forEach((b) => {
    const on = map.hasLayer(CHIP_LAYERS[b.dataset.layer]);
    b.classList.toggle("active", on);
    b.setAttribute("aria-pressed", on);
  });
}
$("layer-chips").addEventListener("click", (e) => {
  const layer = CHIP_LAYERS[e.target.closest("[data-layer]")?.dataset.layer];
  if (!layer) return;
  if (map.hasLayer(layer)) map.removeLayer(layer);
  else map.addLayer(layer);
});
map.on("overlayadd overlayremove", syncLayerChips);
