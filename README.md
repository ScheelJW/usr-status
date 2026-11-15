# Uniformed Safe Rides status

The public status page for Uniformed Safe Rides: https://status.uniformedsaferides.org/

It is hosted on GitHub, not Cloudflare, so it keeps working when the rest of USR is down. The USR
app and website read `status.json` from here to show the latest incident update in a banner.

## Post or update an incident (works from the GitHub phone app)

Each incident is one file in `incidents/`. Copy `incidents/_TEMPLATE.md` (it has the full how-to),
name the new file with the date, change the words and commit. To post an update, add a new
`## Identified` / `## Monitoring` / `## Resolved` section at the top of the file. Times are filled in
for you. `## Resolved` closes the incident.

Planned work uses `impact: maintenance` with `starts:` and `ends:` times (UTC).

## What happens automatically

`.github/workflows/check.yml` runs every 5 minutes from outside Cloudflare:

- Checks ride requests and the app (API), the website, the team console and team pages, and help and support.
- When a check starts failing it opens an incident ("Investigating") on its own, and adds a
  "Resolved" update with how long it lasted when the service answers again. Edit that file to add
  what happened.
- Records outages in `history.json` for the 90-day uptime bars.
- Builds `status.json` (for the app and website) and `incidents.json` (for this page).

Ride messages and notifications are not checked automatically; they change only through incidents.

## Setup (once)

Settings, Pages, Source: Deploy from a branch, Branch: `main`, folder `/ (root)`. Custom domain
`status.uniformedsaferides.org` (the `CNAME` file), DNS-only CNAME to `scheeljw.github.io` in
Cloudflare (never proxied), Enforce HTTPS on. Apps fall back to
`raw.githubusercontent.com/ScheelJW/usr-status/main/status.json` if Cloudflare DNS is down.

The source for these files is `ops/status-page/` in the main repository.
