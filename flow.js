/* Forecast flow layers, in the style of animated weather maps:
 *   - Wind flow: colour-shaded wind speed with moving particles that trace the wind.
 *   - Temperature: colour-shaded air temperature, with the same wind particles on top.
 *   - A forecast timeline (now to +48 h) to scrub or play, with a colour scale.
 * Data: Open-Meteo hourly forecast on a coarse grid over the visible map, interpolated
 * smoothly between grid points. Uses globals from app.js (map, layerControl, getJSON, $).
 */

const FLOW_HOURS = 48;
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

// Colour scales: [value, [r, g, b]].
const FLOW_SCALES = {
  wind: {
    unit: "km/h", label: "Wind",
    stops: [[0, [56, 80, 170]], [8, [48, 140, 200]], [16, [50, 180, 140]], [26, [120, 200, 70]],
      [36, [235, 210, 60]], [50, [245, 140, 40]], [70, [220, 50, 50]], [100, [180, 40, 160]]],
    ticks: [0, 20, 40, 60, 80],
  },
  temp: {
    unit: "°C", label: "Temperature",
    stops: [[-20, [120, 60, 170]], [-5, [60, 90, 200]], [5, [60, 160, 220]], [15, [80, 190, 150]],
      [22, [150, 205, 80]], [27, [240, 210, 70]], [32, [245, 140, 40]], [38, [215, 50, 45]], [45, [150, 20, 60]]],
    ticks: [-10, 0, 10, 20, 30, 40],
  },
};

function scaleColor(stops, v) {
  if (v <= stops[0][0]) return stops[0][1];
  for (let i = 1; i < stops.length; i++) {
    if (v <= stops[i][0]) {
      const [a, ca] = stops[i - 1], [b, cb] = stops[i], t = (v - a) / (b - a);
      return [0, 1, 2].map((k) => ca[k] + (cb[k] - ca[k]) * t);
    }
  }
  return stops[stops.length - 1][1];
}

const flow = {
  mode: null,           // "wind" | "temp" while a flow layer is on
  grid: null,           // { s, n, w, e, rows, cols, times, u, v, spd, tmp } (per-hour arrays)
  hour: 0,              // index into grid.times
  field: null,          // per-pixel-cell vectors for the current view and hour
  particles: [],
  playing: false, playTimer: null, raf: 0, seq: 0, loadTimer: null,
};

// ---------- Canvas overlay ----------
const FlowCanvas = L.Layer.extend({
  onAdd(m) {
    this._shade = L.DomUtil.create("canvas", "flow-canvas flow-shade");
    this._trail = L.DomUtil.create("canvas", "flow-canvas flow-trail");
    const pane = m.getPane("overlayPane");
    pane.appendChild(this._shade);
    pane.appendChild(this._trail);
    m.on("movestart zoomstart", this._hide, this);
    m.on("moveend resize", this._reset, this);
    this._reset();
  },
  onRemove(m) {
    this._shade.remove();
    this._trail.remove();
    m.off("movestart zoomstart", this._hide, this);
    m.off("moveend resize", this._reset, this);
    cancelAnimationFrame(flow.raf);
  },
  _hide() {
    this._shade.style.opacity = 0;
    this._trail.style.opacity = 0;
    cancelAnimationFrame(flow.raf);
  },
  _reset() {
    const size = map.getSize();
    const topLeft = map.containerPointToLayerPoint([0, 0]);
    for (const c of [this._shade, this._trail]) {
      L.DomUtil.setPosition(c, topLeft);
      c.width = size.x;
      c.height = size.y;
      c.style.opacity = "";
    }
    flow.particles = []; // new view: start fresh trails
    redrawFlow();
  },
});
const flowCanvas = new FlowCanvas();

// Two overlay entries share one canvas; turning one on turns the other off.
const windFlowLayer = L.layerGroup();
const tempFlowLayer = L.layerGroup();
const FLOW_LAYERS = { wind: windFlowLayer, temp: tempFlowLayer };

// ---------- Data ----------
function flowGridSpec() {
  const b = map.getBounds().pad(0.15);
  const size = map.getSize();
  return {
    s: Math.max(b.getSouth(), -85), n: Math.min(b.getNorth(), 85),
    w: b.getWest(), e: b.getEast(),
    cols: Math.max(5, Math.min(11, Math.round(size.x / 120))),
    rows: Math.max(4, Math.min(8, Math.round(size.y / 120))),
  };
}

async function loadFlow() {
  const my = ++flow.seq;
  const g = flowGridSpec();
  const lats = [], lons = [];
  for (let r = 0; r < g.rows; r++) {
    for (let c = 0; c < g.cols; c++) {
      lats.push((g.s + (r * (g.n - g.s)) / (g.rows - 1)).toFixed(2));
      const lon = g.w + (c * (g.e - g.w)) / (g.cols - 1);
      lons.push((((((lon + 180) % 360) + 360) % 360) - 180).toFixed(2)); // wrap for the API
    }
  }
  setFlowStatus("Loading forecast…");
  try {
    const data = await getJSON(
      `https://api.open-meteo.com/v1/forecast?latitude=${lats.join(",")}&longitude=${lons.join(",")}` +
      `&hourly=wind_speed_10m,wind_direction_10m,temperature_2m&forecast_hours=${FLOW_HOURS}&timeformat=unixtime`,
      { timeout: 15000, ttl: 30 * 60 * 1000, source: "Weather forecast" }
    );
    if (my !== flow.seq || !flow.mode) return;
    const pts = Array.isArray(data) ? data : [data];
    const times = pts[0]?.hourly?.time || [];
    const per = (fn) => times.map((_, h) => Float32Array.from(pts, (p) => fn(p.hourly, h)));
    const spd = per((x, h) => x.wind_speed_10m[h] ?? 0);
    const dir = per((x, h) => x.wind_direction_10m[h] ?? 0);
    // Direction is where the wind comes FROM; u points east, v points north.
    const u = spd.map((a, h) => a.map((s, i) => -s * Math.sin((dir[h][i] * Math.PI) / 180)));
    const v = spd.map((a, h) => a.map((s, i) => -s * Math.cos((dir[h][i] * Math.PI) / 180)));
    const tmp = per((x, h) => x.temperature_2m[h] ?? NaN);
    const prevTime = flow.grid?.times[flow.hour];
    flow.grid = { ...g, times, u, v, spd, tmp };
    // Keep the chosen hour when the map moves; otherwise start at the current hour.
    const now = Date.now() / 1000;
    const keep = prevTime ? times.indexOf(prevTime) : -1;
    flow.hour = keep >= 0 ? keep : Math.max(0, times.findIndex((t) => t + 3600 > now));
    $("flow-slider").max = Math.max(0, times.length - 1);
    setFlowStatus("");
    redrawFlow();
  } catch (e) {
    if (my !== flow.seq) return;
    setFlowStatus(errorText(e, "The weather forecast"));
    console.warn("Flow forecast unavailable:", e.message);
  }
}

// Value at a lat/lon from the grid, interpolated between the four nearest points.
function sampleGrid(arr, lat, lon) {
  const g = flow.grid;
  const y = ((lat - g.s) / (g.n - g.s)) * (g.rows - 1);
  const x = ((lon - g.w) / (g.e - g.w)) * (g.cols - 1);
  if (!(x >= 0 && y >= 0 && x <= g.cols - 1 && y <= g.rows - 1)) return NaN;
  const x0 = Math.min(Math.floor(x), g.cols - 2), y0 = Math.min(Math.floor(y), g.rows - 2);
  const fx = x - x0, fy = y - y0, i = y0 * g.cols + x0;
  return (arr[i] * (1 - fx) + arr[i + 1] * fx) * (1 - fy) + (arr[i + g.cols] * (1 - fx) + arr[i + g.cols + 1] * fx) * fy;
}

// ---------- Drawing ----------
const CELL = 8; // pixels per field cell

function redrawFlow() {
  cancelAnimationFrame(flow.raf);
  updateFlowBar();
  if (!flow.mode || !flow.grid || !flowCanvas._map) return;
  const g = flow.grid, h = flow.hour;
  const size = map.getSize();
  const cw = Math.ceil(size.x / CELL) + 1, ch = Math.ceil(size.y / CELL) + 1;
  const fu = new Float32Array(cw * ch), fv = new Float32Array(cw * ch), fs = new Float32Array(cw * ch);
  const scale = FLOW_SCALES[flow.mode];
  const valArr = flow.mode === "temp" ? g.tmp[h] : g.spd[h];
  const img = new ImageData(cw, ch);
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const ll = map.containerPointToLatLng([x * CELL, y * CELL]);
      const k = y * cw + x;
      const u = sampleGrid(g.u[h], ll.lat, ll.lng), v = sampleGrid(g.v[h], ll.lat, ll.lng);
      fu[k] = Number.isNaN(u) ? 0 : u;
      fv[k] = Number.isNaN(v) ? 0 : v;
      fs[k] = Math.hypot(fu[k], fv[k]);
      const val = sampleGrid(valArr, ll.lat, ll.lng);
      if (Number.isNaN(val)) continue;
      const [r, gg, b] = scaleColor(scale.stops, val);
      img.data.set([r, gg, b, 255], k * 4);
    }
  }
  flow.field = { cw, ch, fu, fv, fs };

  // Shade: the small field image scaled up smoothly.
  const shade = flowCanvas._shade, sc = shade.getContext("2d");
  const tmp = document.createElement("canvas");
  tmp.width = cw; tmp.height = ch;
  tmp.getContext("2d").putImageData(img, 0, 0);
  sc.clearRect(0, 0, shade.width, shade.height);
  sc.imageSmoothingEnabled = true;
  sc.drawImage(tmp, 0, 0, cw * CELL, ch * CELL);

  // A new forecast hour keeps the moving particles; a new view starts them afresh.
  const trail = flowCanvas._trail.getContext("2d");
  if (!flow.particles.length || reduceMotion) {
    seedParticles(size);
    trail.clearRect(0, 0, size.x, size.y);
  }
  if (reduceMotion) drawStaticStreaks(trail, size);
  else animateParticles();
}

function fieldAt(x, y) {
  const f = flow.field;
  const i = Math.round(x / CELL), j = Math.round(y / CELL);
  if (i < 0 || j < 0 || i >= f.cw || j >= f.ch) return null;
  const k = j * f.cw + i;
  return [f.fu[k], f.fv[k], f.fs[k]];
}

function seedParticles(size) {
  const count = Math.round(Math.min(2500, (size.x * size.y) / 500));
  flow.particles = Array.from({ length: count }, () => newParticle(size));
}
function newParticle(size) {
  return { x: Math.random() * size.x, y: Math.random() * size.y, age: Math.floor(Math.random() * 80) };
}

const PX_PER_KMH = 0.045; // particle speed on screen per km/h of wind, per frame
function animateParticles() {
  const canvas = flowCanvas._trail, ctx = canvas.getContext("2d");
  const size = { x: canvas.width, y: canvas.height };
  const step = () => {
    // Fade the previous frame so moving particles leave short trails.
    ctx.globalCompositeOperation = "destination-in";
    ctx.fillStyle = "rgba(0, 0, 0, 0.9)";
    ctx.fillRect(0, 0, size.x, size.y);
    ctx.globalCompositeOperation = "source-over";
    ctx.strokeStyle = "rgba(255, 255, 255, 0.85)";
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    for (const p of flow.particles) {
      const f = fieldAt(p.x, p.y);
      if (!f || p.age++ > 90 || f[2] < 0.3) { Object.assign(p, newParticle(size), { age: 0 }); continue; }
      const nx = p.x + f[0] * PX_PER_KMH, ny = p.y - f[1] * PX_PER_KMH; // screen y grows downward
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(nx, ny);
      p.x = nx; p.y = ny;
    }
    ctx.stroke();
    flow.raf = requestAnimationFrame(step);
  };
  flow.raf = requestAnimationFrame(step);
}

// With reduced motion: short still streaks along the wind instead of moving particles.
function drawStaticStreaks(ctx, size) {
  ctx.strokeStyle = "rgba(255, 255, 255, 0.7)";
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  for (let y = 12; y < size.y; y += 24) {
    for (let x = 12; x < size.x; x += 24) {
      const f = fieldAt(x, y);
      if (!f || f[2] < 0.3) continue;
      const len = 4 + Math.min(f[2], 60) / 5;
      ctx.moveTo(x, y);
      ctx.lineTo(x + (f[0] / f[2]) * len, y - (f[1] / f[2]) * len);
    }
  }
  ctx.stroke();
}

// ---------- Timeline, scale and value under the pointer ----------
function setFlowStatus(text) {
  $("flow-status").textContent = text;
  $("flow-status").classList.toggle("hidden", !text);
}

function updateFlowBar() {
  const bar = $("flow-bar");
  bar.classList.toggle("hidden", !flow.mode);
  if (!flow.mode) return;
  const scale = FLOW_SCALES[flow.mode];
  const lo = scale.stops[0][0], hi = scale.stops[scale.stops.length - 1][0];
  const css = (v) => `rgb(${scaleColor(scale.stops, v).map(Math.round).join(",")})`;
  $("flow-scale").innerHTML =
    `<b>${scale.label}</b><i style="background:linear-gradient(90deg,${scale.stops.map(([v]) => `${css(v)} ${((v - lo) / (hi - lo)) * 100}%`).join(",")})"></i>` +
    `<span class="ticks">${scale.ticks.map((t) => `<em style="left:${((t - lo) / (hi - lo)) * 100}%">${t}</em>`).join("")}</span>` +
    `<small>${scale.unit}</small>`;
  const t = flow.grid?.times[flow.hour];
  if (t == null) { $("flow-time").textContent = "—"; return; }
  const d = new Date(t * 1000);
  const isNow = Math.abs(Date.now() / 1000 - t) < 3600;
  $("flow-slider").value = flow.hour;
  $("flow-time").textContent =
    `${d.toLocaleDateString([], { weekday: "short" })} ${d.getDate()} ` +
    d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) + (isNow ? " · now" : "");
  $("flow-now").disabled = isNow;
}

function setFlowHour(h) {
  if (!flow.grid) return;
  flow.hour = Math.max(0, Math.min(flow.grid.times.length - 1, h));
  redrawFlow();
}

function flowPlay() {
  clearInterval(flow.playTimer);
  flow.playing = true;
  $("flow-play").textContent = "⏸";
  $("flow-play").setAttribute("aria-label", "Pause forecast");
  flow.playTimer = setInterval(() => {
    if (!flow.grid) return;
    setFlowHour((flow.hour + 1) % flow.grid.times.length);
  }, 1200);
}
function flowPause() {
  clearInterval(flow.playTimer);
  flow.playing = false;
  $("flow-play").textContent = "▶";
  $("flow-play").setAttribute("aria-label", "Play forecast");
}

$("flow-play").addEventListener("click", () => (flow.playing ? flowPause() : flowPlay()));
$("flow-slider").addEventListener("input", (e) => { flowPause(); setFlowHour(+e.target.value); });
$("flow-now").addEventListener("click", () => {
  flowPause();
  const now = Date.now() / 1000;
  setFlowHour(Math.max(0, flow.grid?.times.findIndex((t) => t + 3600 > now) ?? 0));
});

// Value under the pointer, like a probe.
const flowProbe = $("flow-probe");
map.on("mousemove", (e) => {
  if (!flow.mode || !flow.grid) return flowProbe.classList.add("hidden");
  const h = flow.hour, { lat, lng } = e.latlng;
  const spd = sampleGrid(flow.grid.spd[h], lat, lng);
  if (Number.isNaN(spd)) return flowProbe.classList.add("hidden");
  const u = sampleGrid(flow.grid.u[h], lat, lng), v = sampleGrid(flow.grid.v[h], lat, lng);
  const from = (Math.atan2(-u, -v) * 180) / Math.PI;
  const tmp = sampleGrid(flow.grid.tmp[h], lat, lng);
  flowProbe.innerHTML =
    (flow.mode === "temp" ? `<b>${Math.round(tmp)}°C</b> · ` : "") +
    `<b>${Math.round(spd)} km/h</b> from ${compass(from)}` + (flow.mode === "wind" ? ` · ${Math.round(tmp)}°C` : "");
  flowProbe.style.transform = `translate(${e.containerPoint.x + 14}px, ${e.containerPoint.y + 14}px)`;
  flowProbe.classList.remove("hidden");
});
map.on("mouseout movestart", () => flowProbe.classList.add("hidden"));

// ---------- Turning the layers on and off ----------
layerControl.addOverlay(windFlowLayer, "Wind flow (forecast)");
layerControl.addOverlay(tempFlowLayer, "Temperature (forecast)");

map.on("overlayadd", (e) => {
  const mode = Object.keys(FLOW_LAYERS).find((k) => FLOW_LAYERS[k] === e.layer);
  if (!mode) return;
  // Only one shaded layer at a time.
  for (const [k, l] of Object.entries(FLOW_LAYERS)) if (k !== mode && map.hasLayer(l)) map.removeLayer(l);
  flow.mode = mode;
  $("map-hint").style.opacity = 0;
  if (!map.hasLayer(flowCanvas)) map.addLayer(flowCanvas);
  if (flow.grid) redrawFlow();
  loadFlow();
});
map.on("overlayremove", (e) => {
  const mode = Object.keys(FLOW_LAYERS).find((k) => FLOW_LAYERS[k] === e.layer);
  if (!mode || flow.mode !== mode) return;
  flow.mode = null;
  flow.seq++;
  flowPause();
  if (map.hasLayer(flowCanvas)) map.removeLayer(flowCanvas);
  flowProbe.classList.add("hidden");
  updateFlowBar();
});

map.on("moveend resize", () => {
  if (!flow.mode) return;
  clearTimeout(flow.loadTimer);
  flow.loadTimer = setTimeout(loadFlow, 600);
});
document.addEventListener("net:retry", () => flow.mode && loadFlow());

// Map chips: the flow layers join the existing radar and wind buttons.
Object.assign(CHIP_LAYERS, { flow: windFlowLayer, temp: tempFlowLayer });
syncLayerChips();
