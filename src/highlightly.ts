import { appendRequestLog, readRequestLog } from "./store.ts";

/**
 * Thin client over the Highlightly Cricket API.
 *
 * Every call goes through here so that each one is counted. On the free
 * plan there are only 100 requests a day, which is why nothing in this
 * service polls: data is fetched when someone asks for it and cached
 * until they ask again.
 */

const BASE_URL = process.env.HIGHLIGHTLY_BASE_URL || "https://cricket.highlightly.net";
const API_KEY = process.env.HIGHLIGHTLY_API_KEY || "";
const HOST = process.env.HIGHLIGHTLY_HOST || "";
const DAILY_LIMIT = Number(process.env.DAILY_REQUEST_LIMIT || 100);

export class ApiKeyMissingError extends Error {
  constructor() {
    super("HIGHLIGHTLY_API_KEY is not set. Add it to your .env file.");
  }
}

export class QuotaExhaustedError extends Error {
  constructor(public used: number, public limit: number) {
    super(`Daily request limit reached (${used}/${limit}). It resets at midnight UTC.`);
  }
}

export class UpstreamError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** Highlightly's quota resets at midnight UTC, so the day is counted in UTC. */
function utcDayKey(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

export interface QuotaState {
  used: number;
  limit: number;
  remaining: number;
  /** What Highlightly itself last reported, which is authoritative. */
  remainingFromApi: number | null;
  resetsAt: string;
}

export async function getQuota(): Promise<QuotaState> {
  const log = await readRequestLog();
  const today = utcDayKey();

  const todaysCalls = log.filter((row) => row.at.slice(0, 10) === today);
  const used = todaysCalls.length;

  // The most recent header value beats our own count: a key shared with
  // another tool, or requests made before this service existed, would
  // make the local tally read low.
  const latestWithHeader = [...todaysCalls]
    .reverse()
    .find((row) => row.remainingFromApi !== null);

  const resetsAt = new Date(`${today}T00:00:00.000Z`);
  resetsAt.setUTCDate(resetsAt.getUTCDate() + 1);

  const remainingFromApi = latestWithHeader?.remainingFromApi ?? null;

  return {
    used,
    limit: DAILY_LIMIT,
    remaining: remainingFromApi ?? Math.max(DAILY_LIMIT - used, 0),
    remainingFromApi,
    resetsAt: resetsAt.toISOString(),
  };
}

/**
 * Makes one counted request.
 *
 * Refuses to call out at all once the local tally hits the limit —
 * better to show stale data than to burn a request on a response that
 * will be rejected anyway.
 */
export async function apiGet<T>(endpoint: string, params: Record<string, string | number | undefined> = {}): Promise<T> {
  if (!API_KEY) throw new ApiKeyMissingError();

  const quota = await getQuota();
  if (quota.remaining <= 0) {
    throw new QuotaExhaustedError(quota.used, quota.limit);
  }

  const url = new URL(endpoint, BASE_URL);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
  }

  const headers: Record<string, string> = { "x-rapidapi-key": API_KEY };
  // Only RapidAPI needs the host header; sending it to the direct host
  // is harmless but pointless.
  if (HOST) headers["x-rapidapi-host"] = HOST;

  let response: Response;
  try {
    response = await fetch(url, { headers });
  } catch (error) {
    // A network failure never reached Highlightly, so it doesn't count
    // against the quota — but it is worth recording.
    await appendRequestLog({
      at: new Date().toISOString(),
      endpoint,
      ok: false,
      status: 0,
      remainingFromApi: null,
    });
    throw new UpstreamError(0, `Could not reach Highlightly: ${(error as Error).message}`);
  }

  const remainingHeader = response.headers.get("x-ratelimit-requests-remaining");

  await appendRequestLog({
    at: new Date().toISOString(),
    endpoint,
    ok: response.ok,
    status: response.status,
    remainingFromApi: remainingHeader !== null ? Number(remainingHeader) : null,
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new UpstreamError(
      response.status,
      response.status === 429
        ? "Highlightly rejected the request: daily limit reached."
        : `Highlightly returned ${response.status}. ${body.slice(0, 200)}`
    );
  }

  return (await response.json()) as T;
}
