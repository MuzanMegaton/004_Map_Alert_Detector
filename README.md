# Map Alert Detector

A live map of disaster alerts worldwide, with a safe-route planner that checks weather, air quality,
river floods and nearby alerts, and recommends the safest route and the best time to leave.
It needs no API keys, no install and no build step, and every data source is free.

## Run on your computer

```
powershell -ExecutionPolicy Bypass -File serve.ps1
```

Then open http://localhost:8080.

## Put it online for free (GitHub Pages)

The app is plain HTML, CSS and JavaScript, so any free static host works. With GitHub Desktop:

1. **File → Add local repository** and choose this folder. It is already a Git repository.
2. Click **Publish repository**, and untick "Keep this code private". Free GitHub Pages needs a public repository.
3. On github.com, open the repository and go to **Settings → Pages**.
   Under "Build and deployment", pick **Deploy from a branch**, then **main** and **/ (root)**, and click **Save**.
4. After a minute the app is live at `https://<your-username>.github.io/<repository-name>/`.
   Open it on your phone and use **Add to Home screen**.

Place search and routing use free public demo servers (OpenStreetMap Nominatim and OSRM).
They're fine for personal use and sharing with friends. For heavy public traffic, move to your own server or a paid plan.

## Features

**Route check** (the Route check tab)
- Search places by name as you type, in English or Thai: cities, districts, landmarks, malls, hotels. Use the arrow keys or click to pick one. You can also use **My location**, type `lat,lon`, or tap an example route.
- Up to 3 alternative routes are compared. The **safest** one is selected automatically, and the fastest is labeled.
- **Best time to leave** compares leaving now, and in 1, 2, 3, 6, 12 and 24 hours. The best option is marked.
- At each checkpoint along the route, forecast for **the time you would arrive there**:
  - weather: thunderstorms, heavy rain or snow, fog, strong gusts, low visibility, extreme heat or cold
  - wind: arrow, speed and direction, whether it's a headwind, tailwind or crosswind for your car, and which way the weather is moving. Strong crosswinds are flagged.
  - air quality: US AQI and PM2.5
  - river flow: flagged when it's in the top 5% of the past year, or above last year's peak
- Alerts within 50–500 km of the route, plus an overall verdict and tips, such as "Leaving at 6 PM lowers the risk".
- **Share this route**: the route is stored in the page link, so you can send it or bookmark it.

**Alerts** (the Alerts tab and the map)
- Earthquakes, tropical cyclones, floods, volcanoes, droughts, wildfires, severe storms and more.
  Markers are colored by severity, and red ones pulse. Alerts refresh every 5 minutes.
- Search, filter by source and severity, and sort by newest, severity or distance from you (**Near me**).
- Alert details: magnitude, depth, alert level and country; the weather, air quality and river flow there now;
  **Open in Google Maps**; and a link to the official report.
- **Notify**: sends a browser notification when a new Orange or Red alert appears.

**Map**
- Click anywhere for the weather, air quality and river flow there.
- **Weather direction** (layers button, top right):
  - **🌧 Rain radar (moving, last 2 h)**: plays the last 2 hours of radar in a loop, so you can see which way rain is moving. It has a play/pause button and a time slider.
  - **💨 Wind direction**: arrows show where the wind blows. Arrow color and length show the speed. Hover an arrow for details and the direction weather is drifting.
- Street, satellite and dark map styles.
- **Jump to** a region, such as Thailand.
- Works on phones: on small screens the map sits on top and alert details slide up from the bottom. It follows the light or dark theme of your device.

## How the risk score works

Each route and departure time gets a score. The score adds up the hazards at every checkpoint, plus the alerts near the route:

| Item | Points |
|---|---|
| Thunderstorm (with hail) | 10 (12) |
| Heavy rain or showers, strong gusts ≥ 60 km/h | 6 |
| Strong crosswind (sideways gusts ≥ 45 km/h) | 5 |
| Heavy snow or freezing rain | 8–10 |
| Fog or low visibility | 4 |
| Unhealthy air (AQI > 150 / > 200) | 4 / 8 |
| High river flow / above last year's peak | 6 / 12 |
| Nearby alert: Red / Orange / Yellow / Green | 40 / 15 / 4 / 1 |

Risk levels: **Low** below 5, **Medium** below 20, **High** below 50, and **Very high** at 50 or more.
This is a guide, not an official warning. Always check local authorities in severe weather.

## Data sources (all free, no key)

| Data | Source |
|---|---|
| Earthquakes | USGS Earthquake Hazards Program |
| Global disaster alerts | GDACS (UN / European Commission) |
| Natural events (fires, storms, volcanoes, ice) | NASA EONET |
| Weather and forecasts | Open-Meteo |
| Air quality (AQI, PM2.5, PM10) | Open-Meteo Air Quality (CAMS) |
| River flood forecast | Open-Meteo Flood API (GloFAS) |
| Live rain radar | RainViewer |
| Routing | OSRM (OpenStreetMap) |
| Place search / names | Photon (search-as-you-type), OpenStreetMap Nominatim, BigDataCloud |
| Map tiles | OpenStreetMap, Esri satellite, CARTO dark |

Google Maps has no public alerts API, and its crisis alerts come from agencies like these.
The app links each alert to Google Maps.

## Files

- `index.html`: page layout
- `style.css`: styles, with light and dark themes and the phone layout
- `app.js`: alert sources, map, alert list, detail panel, tabs and notifications
- `route.js`: routes, weather, air quality, floods, risk scoring and recommendations
- `wind.js`: moving rain radar and wind-direction arrows
- `serve.ps1`: tiny local web server
