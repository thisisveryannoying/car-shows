# DPIA_NOTE: under-13s and children's data

This is a short note explaining the decisions made about children and age. It is not a completed Data Protection Impact Assessment and it is not legal advice. Have a UK data protection adviser review it before launch.

Last reviewed: 10 November 2026.

## Why this matters

A car-show finder will attract some young people, so we treat it as a service children are likely to use. That means the ICO's Age Appropriate Design Code (the Children's code) applies as well as the UK GDPR. Under the UK GDPR, a child can give their own consent to an online service from age 13. Below 13, consent would need a parent or carer.

## Decisions

- **The app is for ages 13 and over.** This is the lowest age at which a child can consent for themselves, so we avoid needing parental consent.
- **Age is confirmed with a tick box, not a date of birth.** The first-run screen asks the user to tick "I am 13 or older and I agree to the Terms and Privacy Policy". Continue stays disabled until they do. We don't collect a birth date or any ID, because asking for more would mean collecting more children's data (data minimisation).
- **Nothing is collected from anyone who says they are under 13.** The screen tells under-13s not to use the app. Until the box is ticked, the app loads no features, asks for no location, starts no analytics and sends nothing to the postcode service.
- **Highest privacy by default.** Location and analytics are both off until the user turns them on. Neither is ever on for anyone who has not chosen it.
- **No accounts.** No name, email, password or profile is created, so there is nothing to attach to a child.
- **Minimal data.** Only a postcode, a search distance and display settings, all saved on the device. No location history.
- **No profiling, advertising or sharing for gain.** No personalised adverts, no sale of data, no nudges to share more. Sponsored listings are labelled and not targeted at the user.
- **Easy controls.** Plain-English settings, Export my data and Delete my data in the app, and a contact address.
- **Plain language.** The first-run screen and Settings are written in short, simple sentences so a 13-year-old can follow them.

## Risks and how they are handled

- **A child under 13 ticks the box anyway.** Likelihood: medium. Impact: low, because the data held is a postcode and settings on their own device. Handling: minimal data, no account, defaults off, a clear warning on the first screen, and we delete anything we learn is from an under-13.
- **A child turns on location.** Likelihood: low to medium. Impact: medium. Handling: it is off by default, the OS asks for permission, we use the position once, round it, and discard it. No history is kept.
- **A postcode reveals a home area.** Likelihood: medium. Impact: low to medium. Handling: it is stored only on the device, and only the postcode area is sent to the lookup provider. The app never publishes it.
- **Events that are not suitable for children, such as track days or auctions.** Likelihood: low. Impact: low. Handling: event details are the organiser's responsibility and the app tells users to check with the organiser.
- **Map tiles from a third party.** Likelihood: certain, as the map needs them. Impact: low. Handling: the map loads only after the age and terms screen is accepted, the tile servers receive the IP address and the area viewed but not the postcode, and this is disclosed in the Privacy Policy.
- **Third-party links and services.** Likelihood: medium. Impact: low. Handling: links open on the organiser's or Google's own site, with a note in the Privacy Policy.

Residual risk: low, provided the app stays within the limits above.

## What a tick box can and can't do

A tick box is a light check. It does not verify age, and the ICO expects the level of age assurance to match the risk. We think a tick box is proportionate while the app collects almost nothing and has no accounts, no communication between users and no targeted advertising. If any of the things in the next section are added, this decision must be reviewed.

## When to do a full DPIA

Do a full DPIA before adding any of the following:

- accounts or sign-in
- user submissions, comments or any chat between users
- advertising or sponsored content that is targeted using personal data
- an analytics or crash-reporting provider
- storing any location data, even for a short time
- any new use of data from users under 18

## Review

Review this note every 12 months, and whenever the app or its data use changes.
