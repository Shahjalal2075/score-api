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
const HOST = process.env.HIGHLIGHTLY_HOST || "";

/** Per-key daily allowance, not the total across all keys. */
const DAILY_LIMIT = Number(process.env.DAILY_REQUEST_LIMIT || 100);

/**
 * The API keys, in the order they get used.
 *
 * Each carries its own daily allowance, so three keys means three times
 * the requests. A key is only abandoned once it has actually run out —
 * either our own count for the day reaches the limit, or Highlightly
 * answers 429. Keys are never used in parallel or round-robin: the
 * first with room left is always chosen, so allowance two is untouched
 * until allowance one is genuinely spent.
 *
 * HIGHLIGHTLY_API_KEY holds the first; _2 and _3 are optional. A single
 * key with commas works too, for convenience.
 */
function loadKeys(): string[] {
  const raw = [
    process.env.HIGHLIGHTLY_API_KEY,
    process.env.HIGHLIGHTLY_API_KEY_2,
    process.env.HIGHLIGHTLY_API_KEY_3,
  ];

  const keys = raw
    .flatMap((value) => (value ?? "").split(","))
    .map((key) => key.trim())
    .filter(Boolean);

  // A key repeated across variables would look like extra allowance it
  // doesn't have.
  return [...new Set(keys)];
}

const API_KEYS = loadKeys();

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

export interface KeyQuota {
  /** 1-based, matching the environment variable it came from. */
  index: number;
  used: number;
  limit: number;
  remaining: number;
  /** What Highlightly itself last reported for this key. */
  remainingFromApi: number | null;
  /** True for the key the next request will use. */
  active: boolean;
}

export interface QuotaState {
  /** Totals across every configured key. */
  used: number;
  limit: number;
  remaining: number;
  remainingFromApi: number | null;
  resetsAt: string;
  keys: KeyQuota[];
  keyCount: number;
}

export async function getQuota(): Promise<QuotaState> {
  const log = await readRequestLog();
  const today = utcDayKey();
  const todaysCalls = log.filter((row) => row.at.slice(0, 10) === today);

  const resetsAt = new Date(`${today}T00:00:00.000Z`);
  resetsAt.setUTCDate(resetsAt.getUTCDate() + 1);

  const keys: KeyQuota[] = API_KEYS.map((_, position) => {
    const index = position + 1;

    // Entries written before multiple keys existed carry no index and
    // belong to the first key.
    const mine = todaysCalls.filter((row) => (row.keyIndex ?? 1) === index);
    const used = mine.length;

    // Highlightly's own figure beats our tally: a key shared with
    // another tool would make the local count read low.
    const latestWithHeader = [...mine].reverse().find((row) => row.remainingFromApi !== null);
    const remainingFromApi = latestWithHeader?.remainingFromApi ?? null;

    return {
      index,
      used,
      limit: DAILY_LIMIT,
      remaining: remainingFromApi ?? Math.max(DAILY_LIMIT - used, 0),
      remainingFromApi,
      active: false,
    };
  });

  // The first key with room left is the one in use.
  const activeKey = keys.find((key) => key.remaining > 0);
  if (activeKey) activeKey.active = true;

  const totalRemaining = keys.reduce((sum, key) => sum + key.remaining, 0);
  const anyApiFigure = keys.some((key) => key.remainingFromApi !== null);

  return {
    used: todaysCalls.length,
    limit: DAILY_LIMIT * Math.max(API_KEYS.length, 1),
    remaining: totalRemaining,
    remainingFromApi: anyApiFigure ? totalRemaining : null,
    resetsAt: resetsAt.toISOString(),
    keys,
    keyCount: API_KEYS.length,
  };
}

/**
 * Makes one counted request.
 *
 * Refuses to call out at all once the local tally hits the limit —
 * better to show stale data than to burn a request on a response that
 * will be rejected anyway.
 */
export async function apiGet<T>(
  endpoint: string,
  params: Record<string, string | number | undefined> = {}
): Promise<T> {
  if (API_KEYS.length === 0) throw new ApiKeyMissingError();

  const quota = await getQuota();
  if (quota.remaining <= 0) {
    throw new QuotaExhaustedError(quota.used, quota.limit);
  }

  const url = new URL(endpoint, BASE_URL);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
  }

  // Start at the first key with allowance left and walk forward. A key
  // that turns out to be exhausted — Highlightly answers 429 even though
  // our count said otherwise — is skipped and the next one tried, so a
  // stale tally costs one wasted call rather than a failed request.
  const startAt = quota.keys.findIndex((key) => key.remaining > 0);
  let lastError: Error | null = null;

  for (let position = Math.max(startAt, 0); position < API_KEYS.length; position += 1) {
    const keyIndex = position + 1;

    const headers: Record<string, string> = { "x-rapidapi-key": API_KEYS[position] };
    // Only RapidAPI needs the host header.
    if (HOST) headers["x-rapidapi-host"] = HOST;

    let response: Response;
    try {
      response = await fetch(url, { headers });
    } catch (error) {
      // Never reached Highlightly, so nothing was spent — but worth
      // recording, and not worth burning another key over.
      await appendRequestLog({
        at: new Date().toISOString(),
        endpoint,
        ok: false,
        status: 0,
        remainingFromApi: null,
        keyIndex,
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
      keyIndex,
    });

    if (response.ok) {
      return (await response.json()) as T;
    }

    if (response.status === 429) {
      // This key is spent. Try the next one rather than giving up.
      lastError = new UpstreamError(429, `Key ${keyIndex} has reached its daily limit.`);
      continue;
    }

    const body = await response.text().catch(() => "");
    throw new UpstreamError(
      response.status,
      `Highlightly returned ${response.status}. ${body.slice(0, 200)}`
    );
  }

  throw (
    lastError ??
    new QuotaExhaustedError(quota.used, quota.limit)
  );
}
