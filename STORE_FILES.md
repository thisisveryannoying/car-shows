# STORE_FILES: notes for Apple and Google

Draft answers for the app stores. They come from the data list at the end of PRIVACY.md, so keep the two in step. Review before you submit.

## Public URLs

- Privacy policy: `https://[your domain]/privacy`
- Terms: `https://[your domain]/terms`

Both work already, because the app serves them at `/privacy` and `/terms`. Put the same two URLs in both store listings.

## Apple (iOS)

Add to `Info.plist` (only when you build a native iOS app; this project is a web app today):

```
<key>NSLocationWhenInUseUsageDescription</key>
<string>Turn this on to find car shows near where you are right now. We use your position once to work out your nearest postcode, then forget it. We never keep a location history.</string>
```

That is the same plain-English reason shown in Settings. Only request the permission after the user switches Use my location on.

App Privacy ("nutrition label") draft:

- Data used to track you: none.
- Data linked to you: none (no accounts).
- Data not linked to you: Coarse location (the postcode, used for app functionality), and Diagnostics only if you add a crash reporter and the user opts in.

## Google Play: Data safety draft

- Does the app collect or share required user data types? Yes (approximate location only).
- Is all data encrypted in transit? Yes (HTTPS only).
- Can users request that their data is deleted? Yes. In-app (Settings, Delete my data) and by email.
- Data types:
  - **Approximate location:** collected (postcode, and optional device location rounded to about 100 m). Shared with a service provider (postcodes.io) to return nearby places. Purpose: app functionality. Optional for the device location; the postcode is required to use the app. Not stored on our servers.
  - **App activity / diagnostics:** only if analytics and crash reports are switched on (off by default). Optional. Fill in once you choose a provider.
- **IP address and map area:** seen by OpenStreetMap's tile servers when the map is shown (shared with a service provider for app functionality). Not linked to an identity by us.
- Data not collected: name, email, user IDs, contacts, photos, files, financial info, health info, advertising ID.
- Target audience: 13 and over. Do not select the Families programme unless you redo the children's data work in DPIA_NOTE.md.

## Account deletion

There are no accounts, so no account-deletion page is needed today. If you add accounts, you must offer deletion inside the app and a web page for it, and Google Play needs a link to that page in the Data safety form.
