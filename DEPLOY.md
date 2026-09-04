# Deploying: server on Render, panel on Netlify

Two separate deployments, as the two pieces are separate applications.
Neither shares anything with the fantasy platform beyond one HTTP call
and a shared key.

---

## Part 1 — Server on Render

### Why a disk is not optional

The server keeps everything in JSON files: cached matches, pairing codes
for every player, and the log of how many API requests today has used.

A container's own filesystem is wiped on every deploy and restart. Without
a mounted disk you would lose:

- **every pairing** — all player codes gone, re-pair from scratch
- **the request counter** — it restarts at zero, so the service would keep
  calling Highlightly past 100 and get rejected with no warning

Render's disk is roughly **$1/month for 1 GB**, which is far more than
this needs.

### Steps

1. Push `cricket-live-server` to a Git repository
2. Render → **New** → **Web Service** → connect the repo
3. Settings:

   | | |
   |---|---|
   | Runtime | Node |
   | Build command | `npm install` |
   | Start command | `npm start` |
   | Health check path | `/health` |

4. **Disks** → **Add disk**:

   | | |
   |---|---|
   | Name | `cricket-live-data` |
   | Mount path | `/var/data` |
   | Size | 1 GB |

5. **Environment** → add:

```
DATA_DIR              /var/data
HIGHLIGHTLY_API_KEY   your-key
HIGHLIGHTLY_BASE_URL  https://cricket.highlightly.net
TIMEZONE              Asia/Dhaka
DAILY_REQUEST_LIMIT   100

FANTASY_API_URL       https://your-fantasy-server.onrender.com
LIVE_SYNC_KEY         must match the fantasy backend exactly

CORS_ORIGIN           https://your-panel.netlify.app
```

> `render.yaml` in the repo sets the non-secret ones for you if you
> deploy as a Blueprint instead.

6. Deploy, then open `/health` (also available at `/api/health`). It should report:

```json
{ "ok": true, "dataDir": "/var/data", "bridgeConfigured": true, "apiKeys": 3 }
```

`apiKeys` is how many Highlightly keys were loaded — a missing second or
third key shows up here rather than as a surprise when the first runs out.

`dataDir` showing `./data` means the disk isn't mounted — fix that before
pairing anything.

### About the free plan

Render's free tier has **no persistent disk**, so the store would be lost
on every restart. It also sleeps after inactivity, which is survivable
here (nothing is scheduled), but the disk is not — use a paid instance,
or move storage to a database.

---

## Part 2 — Panel on Netlify

1. Push `cricket-live-panel` to a Git repository
2. Netlify → **Add new site** → **Import an existing project**
3. Build settings are read from `netlify.toml`:

   | | |
   |---|---|
   | Build command | `npm run build` |
   | Publish directory | `dist` |

4. **Site settings → Environment variables**:

```
VITE_API_URL   https://cricket-live-server.onrender.com
```

5. Deploy.

> `VITE_API_URL` is baked in at **build** time, not read at runtime.
> Changing it means triggering a redeploy — editing the variable alone
> does nothing.

### If the panel loads but every request fails

Almost always CORS. The browser calls Render directly, so Render has to
allow the Netlify origin:

```
CORS_ORIGIN = https://your-panel.netlify.app
```

Exactly as the browser sends it — `https://`, no trailing slash. Then
redeploy the server.

---

## Part 3 — Connecting to the fantasy platform

The two systems stay entirely separate: different hosts, different
databases, no shared code. The only link is one key.

**Fantasy backend** `.env`:
```
LIVE_SYNC_KEY="a long random string"
```

**Live server** environment:
```
FANTASY_API_URL="https://your-fantasy-server.onrender.com"
LIVE_SYNC_KEY="the same long random string"
```

Generate one with:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

If they don't match, the live server gets a 401 and nothing reaches the
fantasy database — which is the intended behaviour.

---

## Checklist

- [ ] Render disk mounted at `/var/data`, `DATA_DIR` set to match
- [ ] `/api/health` reports the right `dataDir`
- [ ] `HIGHLIGHTLY_API_KEY` set on Render
- [ ] `CORS_ORIGIN` set to the Netlify URL
- [ ] `VITE_API_URL` set on Netlify, then redeployed
- [ ] `LIVE_SYNC_KEY` identical on both servers
- [ ] Panel loads a date and the request counter shows a number
