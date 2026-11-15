# Uniformed Safe Rides status

The public status page for Uniformed Safe Rides: https://status.uniformedsaferides.org/

It lives on GitHub, not Cloudflare, so it keeps working when the rest of USR is down. The USR app
and website read `status.json` from here to show an outage banner or a notice.

## Post a notice (works from the GitHub phone app)

1. Open `NOTICE.md` and tap the pencil to edit.
2. Below the instructions box, write a short title on the first line and what people should do on the next lines.
3. Commit. The page and every app show it within about 5 minutes.

To clear it, delete your lines and commit again.

## What runs here

- `.github/workflows/check.yml` runs every 5 minutes. It checks the API and website from outside
  Cloudflare and writes `status.json` when something changes.
- It also copies every team's **public** ride line and backup numbers into `ride-lines.json` while
  the API is up, so people can find a number on this page during an outage.
- Nothing private is stored here. The source for these files is `ops/status-page/` in the main repository.

## Setup (once)

Settings, Pages, Source: Deploy from a branch, Branch: `main`, folder `/ (root)`. Custom domain `status.uniformedsaferides.org` (the `CNAME` file), DNS-only CNAME to `scheeljw.github.io` in Cloudflare (never proxied), Enforce HTTPS on. Apps fall back to `raw.githubusercontent.com/ScheelJW/usr-status/main/status.json` if Cloudflare DNS is down.
