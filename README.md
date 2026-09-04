# Cricket Live

A standalone dashboard for browsing cricket fixtures, squads and live
scores from the [Highlightly Cricket API](https://highlightly.net/cricket-api/documentation/).

Two pieces, both self-contained:

- **server/** — Node + Express. Talks to Highlightly, caches every
  response to disk, and counts requests.
- **panel/** — React + Vite. The dashboard itself.

This project shares nothing with any other application — no database, no
shared code, no shared config.

---

## The request budget

Highlightly's free plan allows **100 requests a day**. Everything here is
built around that:

- **Nothing polls.** No timers, no background refresh, no websockets.
- **Every response is cached** on disk. Re-opening a match or a date you
  already fetched costs nothing.
- **Refreshing is always a deliberate button press**, and each button
  says how many requests it will spend.
- **When the day's allowance is gone, the server stops calling out** and
  serves the cached copy instead, rather than burning a request on a
  response that would be rejected.

Two endpoints do all the work:

| What you get | Requests |
|---|---|
| Every fixture for a date | 1 |
| One match: squads, both scorecards, live batting and bowling | 1 |

So a normal day watching one match is roughly: 1 request for the
fixtures, then 1 per score update.

---

## Setup

### 1. Get an API key

Sign up at [highlightly.net](https://highlightly.net/login) (or via
RapidAPI) and copy your key.

### 2. Server

```bash
cd server
npm install
cp .env.example .env      # then paste your key into HIGHLIGHTLY_API_KEY
npm run dev
```

Runs on **http://localhost:5100**.

Using a **RapidAPI** key instead of a Highlightly one? Set both:

```bash
HIGHLIGHTLY_BASE_URL="https://cricket-highlights-api.p.rapidapi.com"
HIGHLIGHTLY_HOST="cricket-highlights-api.p.rapidapi.com"
```

### 3. Panel

```bash
cd panel
npm install
npm run dev
```

Opens on **http://localhost:5101** and proxies `/api` to the server, so
there's no key or URL in the browser bundle.

---

## Using it

**Pick a date** at the top. If that date has been fetched before it loads
straight from cache, free.

**Fetch from API (1 request)** pulls the fixtures for that date. Do this
once a day.

**Click a match** to open it — cached, free.

**Update score (1 request)** re-fetches that match. This is the button to
press while a game is in progress. One press gives you the current score,
both innings' scorecards, who's batting and bowling right now, and the
squads.

The counter in the top right shows what's left of today's allowance and
when it resets (midnight UTC). It turns red under 10.

> The counter prefers Highlightly's own figure over the local tally. If
> the same key is used by something else, the API's number is the honest
> one.

---

## Where data lives

```
server/data/
├── match-lists/2026-09-03.json    one file per date
├── matches/48514657.json          one file per match
└── request-log.json               today's and yesterday's calls
```

Plain JSON — no database to install. Delete a file to force a re-fetch,
or delete the whole `data` folder to start clean. Deleting
`request-log.json` resets the local counter, though not Highlightly's.

---

## Notes on the free tier

- Some results are hidden on the free plan; responses carry a `plan`
  field saying so.
- Odds and geo-restriction endpoints aren't available on free, and
  aren't used here.
- Detailed scorecards depend on coverage for that particular match. A
  fixture with no live coverage will show fixtures and squads but no
  ball-by-ball detail — that's the data, not a bug.
