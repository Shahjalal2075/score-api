import "dotenv/config";
import express from "express";
import cors from "cors";
import {
  apiGet,
  getQuota,
  ApiKeyMissingError,
  QuotaExhaustedError,
  UpstreamError,
} from "./highlightly.ts";
import { extractMatchStats } from "./extractStats.ts";
import {
  connectMatch,
  forgetLink,
  readLink,
  sendScore,
  setPlayerCode,
  BridgeNotConfiguredError,
} from "./fantasyBridge.ts";
import {
  getCachedMatch,
  getCachedMatchList,
  getCachedRoster,
  saveRoster,
  listCachedDates,
  readRequestLog,
  saveMatch,
  saveMatchList,
} from "./store.ts";

const app = express();

// The panel is served from a different origin in production (Netlify),
// so the allowed origins are configured rather than wide open.
// Comma-separated; unset means allow any, which is fine locally.
const allowedOrigins = (process.env.CORS_ORIGIN || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: allowedOrigins.length > 0 ? allowedOrigins : true,
  })
);
app.use(express.json());

const TIMEZONE = process.env.TIMEZONE || "Asia/Dhaka";

/** Today in the configured timezone, as YYYY-MM-DD. */
function today(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function sendError(res: express.Response, error: unknown) {
  if (error instanceof ApiKeyMissingError) {
    return res.status(500).json({ error: error.message, code: "NO_API_KEY" });
  }
  if (error instanceof QuotaExhaustedError) {
    return res.status(429).json({ error: error.message, code: "QUOTA_EXHAUSTED" });
  }
  if (error instanceof UpstreamError) {
    return res.status(502).json({ error: error.message, code: "UPSTREAM" });
  }
  console.error(error);
  return res.status(500).json({ error: "Something went wrong" });
}

// ---------- Quota ----------

// GET /api/quota — how many requests today's allowance has left.
app.get("/api/quota", async (_req, res) => {
  const quota = await getQuota();
  const log = await readRequestLog();

  const todayUtc = new Date().toISOString().slice(0, 10);

  return res.json({
    ...quota,
    // Newest first — the panel shows these as a short activity list.
    recent: log
      .filter((row) => row.at.slice(0, 10) === todayUtc)
      .slice(-20)
      .reverse(),
  });
});

// ---------- Matches ----------

/**
 * GET /api/matches?date=YYYY-MM-DD&refresh=1
 *
 * Served from cache unless `refresh` is set. The date defaults to today
 * in the configured timezone.
 *
 * One request per day per date is the intended usage: on the free plan
 * an accidental poll would exhaust the allowance in minutes.
 */
app.get("/api/matches", async (req, res) => {
  const date = typeof req.query.date === "string" && req.query.date ? req.query.date : today();
  const refresh = req.query.refresh === "1";

  try {
    const cached = await getCachedMatchList<any>(date);

    if (cached && !refresh) {
      return res.json({ date, fromCache: true, fetchedAt: cached.fetchedAt, ...cached.data });
    }

    const payload = await apiGet<any>("/matches", { date, timezone: TIMEZONE, limit: 100 });
    await saveMatchList(date, payload);

    return res.json({ date, fromCache: false, fetchedAt: new Date().toISOString(), ...payload });
  } catch (error) {
    // Falling back to stale data beats showing nothing — especially when
    // the reason is an exhausted quota.
    const cached = await getCachedMatchList<any>(date);
    if (cached) {
      return res.json({
        date,
        fromCache: true,
        stale: true,
        fetchedAt: cached.fetchedAt,
        warning: error instanceof Error ? error.message : "Refresh failed",
        ...cached.data,
      });
    }
    return sendError(res, error);
  }
});

/**
 * GET /api/matches/:id?refresh=1
 *
 * The detail payload carries everything the panel needs — squads, live
 * score, per-innings batting and bowling — so one request covers teams,
 * players and scorecard together.
 */
app.get("/api/matches/:id", async (req, res) => {
  const { id } = req.params;
  const refresh = req.query.refresh === "1";

  try {
    const cached = await getCachedMatch<any>(id);

    if (cached && !refresh) {
      return res.json({ fromCache: true, fetchedAt: cached.fetchedAt, match: cached.data });
    }

    const payload = await apiGet<any>(`/matches/${id}`);
    // This endpoint answers with a single-element array.
    const match = Array.isArray(payload) ? payload[0] : payload;

    await saveMatch(id, match);
    return res.json({ fromCache: false, fetchedAt: new Date().toISOString(), match });
  } catch (error) {
    const cached = await getCachedMatch<any>(id);
    if (cached) {
      return res.json({
        fromCache: true,
        stale: true,
        fetchedAt: cached.fetchedAt,
        warning: error instanceof Error ? error.message : "Refresh failed",
        match: cached.data,
      });
    }
    return sendError(res, error);
  }
});

/**
 * GET /api/teams/:teamId/players?refresh=1
 *
 * A team's full roster.
 *
 * Highlightly only attaches a `squad` to a match close to the toss, and
 * for many fixtures never at all — but this endpoint works at any time.
 * It is the fallback the panel offers when a match has no squad.
 *
 * Rosters change rarely (the API refreshes them once a day), so once
 * fetched a team is served from cache indefinitely unless refreshed.
 */
app.get("/api/teams/:teamId/players", async (req, res) => {
  const { teamId } = req.params;
  const refresh = req.query.refresh === "1";

  try {
    const cached = await getCachedRoster<any>(teamId);

    if (cached && !refresh) {
      return res.json({ fromCache: true, fetchedAt: cached.fetchedAt, ...cached.data });
    }

    const payload = await apiGet<any>("/players", { teamId, limit: 100 });
    await saveRoster(teamId, payload);

    return res.json({ fromCache: false, fetchedAt: new Date().toISOString(), ...payload });
  } catch (error) {
    const cached = await getCachedRoster<any>(teamId);
    if (cached) {
      return res.json({
        fromCache: true,
        stale: true,
        fetchedAt: cached.fetchedAt,
        warning: error instanceof Error ? error.message : "Refresh failed",
        ...cached.data,
      });
    }
    return sendError(res, error);
  }
});

// GET /api/cached-dates — dates already pulled, for the date picker.
app.get("/api/cached-dates", async (_req, res) => {
  return res.json({ dates: await listCachedDates(), today: today() });
});

/**
 * GET /api/link/:matchId
 *
 * Pairing state, plus what a push would contain. The panel uses the
 * counts to decide whether Send score is safe to press.
 */
app.get("/api/link/:matchId", async (req, res) => {
  const { matchId } = req.params;

  const [link, cached] = await Promise.all([readLink(matchId), getCachedMatch<any>(matchId)]);
  const extracted = cached ? extractMatchStats(cached.data) : null;

  const pairedNames = new Set(link?.players.map((p) => p.liveName) ?? []);
  const squadNames = extracted?.names ?? [];

  return res.json({
    link,
    connected: !!link,
    // Every name this match involves, and whether it has a code.
    players: squadNames.map((name) => {
      const paired = link?.players.find((p) => p.liveName === name);
      return {
        name,
        paired: !!paired,
        code: paired?.code ?? null,
        // Shown beside the live name so a wrong pairing is obvious at a
        // glance rather than only when the figures look wrong.
        fantasyName: paired?.fantasyName ?? null,
      };
    }),
    pairedCount: squadNames.filter((name) => pairedNames.has(name)).length,
    totalCount: squadNames.length,
  });
});

// POST /api/link/:matchId/connect   body: { code }
app.post("/api/link/:matchId/connect", async (req, res) => {
  const { matchId } = req.params;
  const code = typeof req.body?.code === "string" ? req.body.code : "";

  if (!code.trim()) return res.status(400).json({ error: "Enter the pairing code" });

  const cached = await getCachedMatch<any>(matchId);
  if (!cached) {
    return res.status(400).json({ error: "Open the match once before pairing it." });
  }

  const match = cached.data;
  const extracted = extractMatchStats(match);

  try {
    const result = await connectMatch({
      matchId,
      code,
      label: `${match?.homeTeam?.name ?? "?"} vs ${match?.awayTeam?.name ?? "?"}`,
      names: extracted.names,
    });
    return res.json(result);
  } catch (error) {
    if (error instanceof BridgeNotConfiguredError) {
      return res.status(503).json({ error: error.message });
    }
    return res.status(400).json({ error: (error as Error).message });
  }
});

/**
 * PUT /api/link/:matchId/player   body: { name, code }
 *
 * Pairs one player by hand, or repoints a wrong pairing. An empty code
 * unpairs them.
 */
app.put("/api/link/:matchId/player", async (req, res) => {
  const { matchId } = req.params;
  const name = typeof req.body?.name === "string" ? req.body.name : "";
  const code = typeof req.body?.code === "string" ? req.body.code : "";

  if (!name.trim()) return res.status(400).json({ error: "Which player?" });

  const cached = await getCachedMatch<any>(matchId);
  if (!cached) return res.status(400).json({ error: "Nothing cached for this match." });

  const match = cached.data;
  const extracted = extractMatchStats(match);

  try {
    const result = await setPlayerCode({
      matchId,
      liveName: name,
      code,
      names: extracted.names,
      label: `${match?.homeTeam?.name ?? "?"} vs ${match?.awayTeam?.name ?? "?"}`,
    });
    return res.json(result);
  } catch (error) {
    if (error instanceof BridgeNotConfiguredError) {
      return res.status(503).json({ error: error.message });
    }
    return res.status(400).json({ error: (error as Error).message });
  }
});

// DELETE /api/link/:matchId — forgets the pairing on this side only.
app.delete("/api/link/:matchId", async (req, res) => {
  await forgetLink(req.params.matchId);
  return res.json({ message: "Pairing removed" });
});

/**
 * POST /api/link/:matchId/send
 *
 * Pushes the current scorecard. Reads only from cache — sending must
 * never quietly spend an API request.
 */
app.post("/api/link/:matchId/send", async (req, res) => {
  const { matchId } = req.params;

  const cached = await getCachedMatch<any>(matchId);
  if (!cached) return res.status(400).json({ error: "Nothing cached for this match yet." });

  const extracted = extractMatchStats(cached.data);

  if (extracted.players.length === 0) {
    return res.status(400).json({
      error: "No figures to send yet — the scorecard is empty. Press Update score first.",
    });
  }

  try {
    const result = await sendScore({
      matchId,
      innings: extracted.innings,
      // PlayerStats is a fixed shape; the bridge only needs the name
      // plus whatever else is on it.
      players: extracted.players as unknown as ({ name: string } & Record<string, unknown>)[],
    });
    return res.json(result);
  } catch (error) {
    if (error instanceof BridgeNotConfiguredError) {
      return res.status(503).json({ error: error.message });
    }
    return res.status(400).json({ error: (error as Error).message });
  }
});

// Render pings this to decide whether the service is healthy.
app.get("/api/health", (_req, res) =>
  res.json({
    ok: true,
    timezone: TIMEZONE,
    // Handy after a deploy: confirms the disk is mounted where expected.
    dataDir: process.env.DATA_DIR || "./data",
    bridgeConfigured: !!(process.env.FANTASY_API_URL && process.env.LIVE_SYNC_KEY),
  })
);

const PORT = Number(process.env.PORT || 5100);
app.listen(PORT, () => {
  console.log(`Cricket live server on http://localhost:${PORT}`);
  if (!process.env.HIGHLIGHTLY_API_KEY) {
    console.warn("HIGHLIGHTLY_API_KEY is not set — requests will fail until it is.");
  }
});
