import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Storage for this service.
 *
 * Plain JSON files rather than a database: the whole dataset is a
 * handful of matches and a day's request log, and a file store means the
 * service runs anywhere with nothing to install or provision. It is also
 * completely separate from any other project's data.
 */

/**
 * Where the JSON store lives.
 *
 * Configurable because a hosted container's own filesystem is wiped on
 * every deploy and restart. On Render this points at a mounted disk
 * (/var/data), which is what keeps pairings, player codes and the
 * request counter alive across restarts — losing the counter would mean
 * silently blowing through the daily API allowance.
 */
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(process.cwd(), "data"));

async function ensureDir(dir: string) {
  await fs.mkdir(dir, { recursive: true });
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch {
    // Missing or corrupt: treated as "nothing cached" so a fresh fetch
    // repairs it rather than the request failing.
    return null;
  }
}

async function writeJson(file: string, value: unknown) {
  await ensureDir(path.dirname(file));
  // Written to a temp file and renamed, so a crash mid-write can't leave
  // a half-written file that then fails to parse forever.
  const temp = `${file}.tmp`;
  await fs.writeFile(temp, JSON.stringify(value, null, 2), "utf8");
  await fs.rename(temp, file);
}

// ---------- Cached API payloads ----------

export interface CachedEntry<T> {
  /** When this was fetched from Highlightly. */
  fetchedAt: string;
  data: T;
}

function matchListFile(date: string) {
  return path.join(DATA_DIR, "match-lists", `${date}.json`);
}

function matchFile(matchId: string) {
  return path.join(DATA_DIR, "matches", `${matchId}.json`);
}

export async function getCachedMatchList<T>(date: string) {
  return readJson<CachedEntry<T>>(matchListFile(date));
}

export async function saveMatchList(date: string, data: unknown) {
  await writeJson(matchListFile(date), { fetchedAt: new Date().toISOString(), data });
}

export async function getCachedMatch<T>(matchId: string) {
  return readJson<CachedEntry<T>>(matchFile(matchId));
}

export async function saveMatch(matchId: string, data: unknown) {
  await writeJson(matchFile(matchId), { fetchedAt: new Date().toISOString(), data });
}

/** Dates we hold a cached list for, newest first. */
export async function listCachedDates(): Promise<string[]> {
  try {
    const files = await fs.readdir(path.join(DATA_DIR, "match-lists"));
    return files
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.replace(/\.json$/, ""))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

function rosterFile(teamId: string) {
  return path.join(DATA_DIR, "rosters", `${teamId}.json`);
}

export async function getCachedRoster<T>(teamId: string) {
  return readJson<CachedEntry<T>>(rosterFile(teamId));
}

export async function saveRoster(teamId: string, data: unknown) {
  await writeJson(rosterFile(teamId), { fetchedAt: new Date().toISOString(), data });
}

// ---------- Request log ----------

export interface RequestLogEntry {
  at: string;
  endpoint: string;
  ok: boolean;
  status: number;
  /** Straight from Highlightly's response header, when it sends one. */
  remainingFromApi: number | null;
}

const LOG_FILE = path.join(DATA_DIR, "request-log.json");

export async function readRequestLog(): Promise<RequestLogEntry[]> {
  return (await readJson<RequestLogEntry[]>(LOG_FILE)) ?? [];
}

export async function appendRequestLog(entry: RequestLogEntry) {
  const log = await readRequestLog();
  log.push(entry);

  // Two days is enough to answer "how many left today" while keeping the
  // file small — older entries are of no use to anyone.
  const cutoff = Date.now() - 2 * 24 * 60 * 60 * 1000;
  const trimmed = log.filter((row) => new Date(row.at).getTime() >= cutoff);

  await writeJson(LOG_FILE, trimmed);
}
