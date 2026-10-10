# Craft web harness

A launcher and file-saving host for the [Craft apps](https://getartcraft.com/apps)
(PhotoCraft, VectorCraft, FilmCraft, LightCraft, PdfCraft, EffectCraft, DesignCraft), all Apache-2.0.

- **Launcher** at `/`: pick an app, see and manage its saved files.
- **Save to server**: a shim injected into each app turns Save/Export downloads into uploads, stored in `data/<app>/`.
- **Open from server**: the app's Open dialog first offers the files saved on the server, with
  "Browse this device" as a fallback.
- **Standalone web repos**: each app lives in its own repo (`CrankyVase/<app>-web`) containing only the
  released web bundle. A GitHub Action in each repo syncs it from upstream's latest release every 6 hours.
  This harness pulls those repos hourly (`scripts/update.mjs`, run by a systemd timer).

## Run

    ./install.sh        # pulls the apps, creates .env with a random login, starts the user services

Or by hand: `node scripts/update.mjs && node --env-file=.env server.js`. Requires Node 20+, git, no npm packages.

## Security

Sign in with the `.env` login (30-day signed cookie, 5 tries/minute/address). The file API only answers
same-origin requests that carry a token the server embedded in an app page, scoped to that app, so a
logged-in browser tab cannot be driven from another site and one app cannot read another's files.

`.env` sets `PORT`, `HOST`, `HARNESS_USER`, `HARNESS_PASS`. Always set the login if the port is reachable
from anywhere you don't trust: the file API reads and writes disk. Put it behind HTTPS (Caddy, Cloudflare
tunnel) so the apps get WebGPU and clipboard access, which browsers only allow on secure origins.

Adding an app: add an entry to `apps.json` and run `node scripts/update.mjs`.
