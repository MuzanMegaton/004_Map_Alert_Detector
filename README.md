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

**Home** (the forecast for one place)
- Search any place, or use your location. **Add to your locations** keeps a list of saved places on your device.
- **Day by day**: 14 days with icon, high and low. Select a day to see it in detail.
- **Hour by hour** for the selected day: weather, colour-coded temperature, chance of rain and wind. Select an hour for feels-like, rain, humidity, gusts, visibility and UV.
- Sunrise, sunset, UV, air quality, rain chance and max wind for the day. Times are shown in the place's own time zone.
- Alerts within 1,000 km, and shortcuts to the Weather map, a route to the place, and all alerts.
- On phones the modes (Home, Route, Alerts, Weather map) are a bar at the bottom.

**Route check** (the Route mode)
- Search places by name as you type, in English or Thai: cities, districts, landmarks, malls, hotels. Suggestions show the place type, your recent places and **Use my location**. Use the arrow keys or click to pick one. You can also type `lat,lon` or tap an example route.
- The place the app actually used is written back into the box, so a wrong match is easy to spot.
- Up to 3 alternative routes are compared. The **safest** one is selected automatically, and the fastest is labeled.
- **Pick a departure date and time**, up to 14 days ahead, or leave now. The forecast follows the time you pick. Trips more than 3 days away are marked as a rough guide.
- **Best time to leave** compares your time with leaving 1, 2, 3, 6, 12 and 24 hours later. The best option is marked.
- At each checkpoint along the route, forecast for **the time you would arrive there**:
  - weather: thunderstorms, heavy rain or snow, fog, strong gusts, low visibility, extreme heat or cold
  - wind: arrow, speed and direction, whether it's a headwind, tailwind or crosswind for your car, and which way the weather is moving. Strong crosswinds are flagged.
  - air quality: US AQI and PM2.5
  - river flow: flagged when it's in the top 5% of the past year, or above last year's peak
- Alerts within 50–500 km of the route, plus an overall verdict and tips, such as "Leaving at 6 PM lowers the risk".
- **Share this route**: the route is stored in the page link, so you can send it or bookmark it.

**Alerts** (the Alerts mode)
- Earthquakes, tropical cyclones, floods, volcanoes, droughts, wildfires, severe storms and more.
  Markers are colored by severity, and red ones pulse. Alerts refresh every 5 minutes.
- Search, filter by source and severity, and sort by newest, severity or distance from you (**Near me**).
- Alert details: magnitude, depth, alert level and country; the weather, air quality and river flow there now;
  **Open in Google Maps**; and a link to the official report.
- **Notify**: sends a browser notification when a new Orange or Red alert appears.

**Weather map** (full-screen map)
- A search box on the map: fly to a place and see its weather.
- Click anywhere for the weather, air quality and river flow there, with **Route from here** and **Route to here**.
- **Rain radar** and **Wind** buttons on the map switch those layers on and off.
- **Weather direction** (layers button, top right):
  - **🌧 Rain radar (moving, last 2 h)**: plays the last 2 hours of radar in a loop, so you can see which way rain is moving. It has a play/pause button and a time slider.
  - **💨 Wind direction**: arrows show where the wind blows. Arrow color and length show the speed. Hover an arrow for details and the direction weather is drifting.
- Street, satellite and dark map styles.
- **Jump to** a region, such as Thailand.
- Works on phones: on small screens the map sits on top and alert details slide up from the bottom. It follows the light or dark theme of your device.

## How a route is rated

A route gets one of four levels, the same scheme weather services use (how likely × how bad):

| Level | Meaning |
|---|---|
| **Good to go** (green) | No severe weather or alerts found along the route |
| **Be aware** (yellow) | Some weather to keep an eye on |
| **Be prepared** (orange) | Hazards are expected: one severe hazard such as a likely thunderstorm, an Orange alert nearby, or several smaller ones |
| **Take action** (red) | A Red alert near the route, or many serious hazards |

The verdict then says **what to expect** (the worst hazards, with place and time) and **what to do**.
Rain-dependent hazards count for less when rain is unlikely in that hour, and are marked "possible" or "likely".
This is a guide, not an official warning. Always check local authorities in severe weather.

## Design principles (and where they come from)

- **Show uncertainty.** Days 11-14 are marked "less certain", and far-ahead hours carry a note. Peer-reviewed studies find weather apps imply more precision than forecasts have, and people report low confidence beyond 10 days (Zabini 2016; Vaughn et al. 2024, *Meteorological Applications*).
- **Chance of rain is a labelled percentage, with the amount in mm shown separately.** A Met Office experiment with over 8,000 people found explicit percentages gave the best decisions (Stephens et al. 2019, *Geoscience Communication*).
- **Say what the weather will do, and what to do.** Verdicts and alert details follow "what to expect / what to do" (WMO-No. 1150 impact-based warnings; UK Met Office warning format).
- **Never colour alone.** Severity is shown by colour, words and marker shape (ring, circle, square, diamond); routes carry numbers and line styles; map symbols have outlines for contrast (WCAG 2.2: 1.4.1, 1.4.11; W3C technique G111).
- **Touch targets** are at least 24 px everywhere and about 44 px for main controls on phones (WCAG 2.2: 2.5.8).

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
| Place search / names | Open-Meteo Geocoding and Photon (search-as-you-type), OpenStreetMap Nominatim (backup), BigDataCloud |
| Map tiles | OpenStreetMap, Esri satellite, CARTO dark |

Google Maps has no public alerts API, and its crisis alerts come from agencies like these.
The app links each alert to Google Maps.

## Files

- `index.html`: page layout
- `style.css`: styles, with light and dark themes and the phone layout
- `app.js`: alert sources, map, alert list, detail panel, tabs and notifications
- `route.js`: routes, weather, air quality, floods, risk scoring and recommendations
- `wind.js`: moving rain radar and wind-direction arrows
- `home.js`: the Home page
- `net.js`: shared request layer (timeouts, retries, cache)
- `serve.ps1`: tiny local web server
