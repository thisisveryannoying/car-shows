# DATA_SOURCES

Every outside source of data or assets this app uses, its licence, the attribution it needs, and the caching rules. The app must only load event data from sources listed here. Do not scrape any website without the owner's written permission. When you add a source, add it here first.

Last reviewed: 10 November 2026. Items marked **CONFIRM** I could not verify from the provider's own pages and you should check before launch.

## Rules for event data

- Store only: title, date, time, venue name, postcode and the organiser's link.
- Do not copy descriptions or images. Link to the organiser's page instead. The pictures shown on event cards are drawings made on the device from the event type, so no photo is copied. Showing a real photo would need the organiser's or photographer's written permission and a licence, and would break this rule unless you add it as a listed source.
- The app currently hides the time on screen (only the date is shown), but it is kept so the calendar file can have a start time.
- Each event shows "Check details with the organiser before attending."
- Paid or promoted listings must carry the label "Advert" or "Sponsored".
- Remove an event within [number of days, for example 2] of an organiser asking us to.
- Delete events from the cache one day after their date.

## Sources in use

### 1. postcodes.io, postcode lookup and nearby places

- **Used for:** turning a postcode into a town and coordinates, finding the nearest postcode to a position (only if the user switches location on), and finding nearby place names.
- **Endpoints:** `/postcodes/{postcode}`, `/outcodes/{outcode}`, `/outcodes?lat&lon&radius` and `/postcodes?lat&lon&limit=1`, all at https://api.postcodes.io.
- **Licence:** the postcodes.io software is MIT licensed (confirmed on its website and repository). Its data is the ONS Postcode Directory, Ordnance Survey Open Names and the Scottish Postcode Directory (confirmed on its repository).
- **Data licence:** these datasets are normally published under the Open Government Licence v3.0 and carry the notices below. **CONFIRM** the current wording and year with the ONS Postcode Directory licence and postcodes.io's documentation at postcodes.io/docs.
- **Attribution text (shown in Settings, About):**
  - Contains OS data © Crown copyright and database right [year].
  - Contains Royal Mail data © Royal Mail copyright and database right [year].
  - Contains National Statistics data © Crown copyright and database right [year].
  - Licensed under the Open Government Licence v3.0.
- **Caching rules:** none beyond memory. Results are held in memory while the app is open and discarded. Only the user's own postcode is saved, on their device. No coordinates or place lists are stored.
- **Usage limits:** I found no published rate limit or key requirement on its public pages. **CONFIRM** at postcodes.io/docs. One postcode lookup makes up to eight requests (one for the postcode and seven nearby-area searches). If the app grows, host the data yourself or use a paid provider.
- **Privacy:** the provider sees the visitor's IP address and what is requested. This is disclosed in the Privacy Policy.

### 2. OpenStreetMap map tiles

- **Used for:** the map pictures behind the pins. Requested from `https://tile.openstreetmap.org/{z}/{x}/{y}.png`, only while the map view is open and only after the user has accepted the terms. The page's Content Security Policy allows this one host for images.
- **Licence:** the map data is © OpenStreetMap contributors, under the Open Database Licence (ODbL). Attribution is shown on the map and in Settings, About: "© OpenStreetMap contributors", linked to https://www.openstreetmap.org/copyright.
- **Tile usage policy:** the OpenStreetMap Foundation's public tile servers are meant for light use, and its policy asks for a valid Referer or User-Agent that identifies the app, no bulk downloading or pre-fetching, and no heavy traffic. **CONFIRM** the current policy at https://operations.osmfoundation.org/policies/tiles/ before launch. I could not read it from here. The app sends the site's address as the Referer for tile requests only. If the app gets more than light traffic, switch to a commercial tile provider with an agreement. To switch, change `TILE` in `index.html` and the image host in the Content Security Policy.
- **Dark map:** the tiles are darkened in the browser with a CSS filter to match the app. Nothing is changed or copied. Set `--map-filter: none` in `index.html` for the normal light map.
- **Caching rules:** none of our own. The browser's normal HTTP cache is used. The app does not store, pre-fetch or copy tiles.
- **Privacy:** the tile servers see the visitor's IP address, the map area requested and the site address. This is disclosed in the Privacy Policy.

### 3. Leaflet (map software)

- **Used for:** drawing the map, the pins and the zoom buttons. Version 1.9.4, self-hosted from this site (`/vendor/leaflet.js`, `/vendor/leaflet.css`). No request goes to a CDN.
- **Licence:** BSD 2-Clause. The licence text is kept in `vendor/LEAFLET_LICENSE.txt`. Credit shown on the map and in Settings, About.

### 4. Inter font

- **Used for:** all text. Self-hosted from this site (`/fonts/inter-latin-wght-normal.woff2`). No request goes to Google or any other font service.
- **Licence:** SIL Open Font License 1.1. Credit shown in Settings, About.
- **Caching:** served by our own hosting. No rules needed.

### 5. Google Maps (link only)

- **Used for:** the Directions button opens `https://www.google.com/maps/search/{venue}` in a new tab when the user taps it.
- **Licence / terms:** it is a plain link. No Google Maps API, key, embed or data is used. Google's own terms and privacy policy apply once the user is on their site.
- **Caching:** none.

## Event listings

**No real event source is connected yet.** Events in this version are sample data generated in the app from the nearby places that postcodes.io returns, and the app says so on the main page and in Settings, About. Replace this before launch.

Add each real source below using this template:

- **Source name and URL:**
- **Permission or licence:** (paste the licence name and link, or attach the written permission)
- **Who gave permission and when:**
- **Fields we take:** title, date, time, venue name, postcode, organiser link (nothing else)
- **Attribution text (if required):**
- **How often we refresh it:** (for example once a day)
- **Cache rule:** (for example keep until one day after the event, then delete)
- **Takedown contact and how quickly we act:**
- **Date last checked:**
