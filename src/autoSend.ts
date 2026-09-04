import { promises as fs } from "node:fs";
import path from "node:path";
import { apiGet } from "./highlightly.ts";
import { extractMatchStats } from "./extractStats.ts";
import { readLink, sendScore } from "./fantasyBridge.ts";
import { getCachedMatch, saveMatch } from "./store.ts";

/**
 * Unattended refresh-and-push for a match in progress.
 *
 * The timer lives on the server rather than in the panel. A browser tab
 * can be closed, backgrounded or put to sleep with the laptop, and the
 * updates would stop with nobody realising — which is the one thing this
 * feature exists to prevent.
 *
 * Each cycle spends one Highlightly request. At ten-minute intervals
 * that's six an hour: roughly twenty for a T20, closer to fifty for a
 * full day of an ODI or Test. Worth knowing before leaving it running
 * on a single 100-request key.
 */

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(process.cwd(), "data"));
const STATE_FILE = path.join(DATA_DIR, "auto-send.json");

/** How often a cycle runs. */
export const AUTO_SEND_INTERVAL_MS = 10 * 60 * 1000;

/**
 * How long to keep going after a match finishes.
 *
 * The final scorecard is not always published the moment the state flips
 * to Finished, so stopping instantly can miss the last update.
 */
const STOP_AFTER_FINISH_MS = 15 * 60 * 1000;

export interface AutoSendEntry {
  matchId: string;
  enabledAt: string;
  lastRunAt: string | null;
  lastResult: string | null;
  /** Set when the match first reports as finished, to time the wind-down. */
  finishedSeenAt: string | null;
}

type AutoSendState = Record<string, AutoSendEntry>;

async function readState(): Promise<AutoSendState> {
  try {
    return JSON.parse(await fs.readFile(STATE_FILE, "utf8")) as AutoSendState;
  } catch {
    return {};
  }
}

async function writeState(state: AutoSendState) {
  await fs.mkdir(path.dirname(STATE_FILE), { recursive: true });
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
}

export async function getAutoSend(matchId: string): Promise<AutoSendEntry | null> {
  return (await readState())[matchId] ?? null;
}

export async function listAutoSend(): Promise<AutoSendEntry[]> {
  return Object.values(await readState());
}

export async function enableAutoSend(matchId: string): Promise<AutoSendEntry> {
  const state = await readState();

  const entry: AutoSendEntry = state[matchId] ?? {
    matchId,
    enabledAt: new Date().toISOString(),
    lastRunAt: null,
    lastResult: null,
    finishedSeenAt: null,
  };

  // Re-enabling after a wind-down starts the clock again.
  entry.finishedSeenAt = null;
  state[matchId] = entry;

  await writeState(state);
  return entry;
}

export async function disableAutoSend(matchId: string) {
  const state = await readState();
  delete state[matchId];
  await writeState(state);
}

async function recordRun(matchId: string, result: string, finishedSeenAt?: string | null) {
  const state = await readState();
  const entry = state[matchId];
  if (!entry) return;

  entry.lastRunAt = new Date().toISOString();
  entry.lastResult = result;
  if (finishedSeenAt !== undefined) entry.finishedSeenAt = finishedSeenAt;

  await writeState(state);
}

/** Highlightly's state strings that mean play is under way. */
function isLive(state: string): boolean {
  return /in play|innings break|drinks|lunch|tea|stumps|timeout/i.test(state);
}

function isFinished(state: string): boolean {
  return /finished|abandoned|cancelled/i.test(state);
}

/**
 * One cycle for one match: refresh from Highlightly, then push.
 *
 * The refresh comes first because pushing a cached scorecard that hasn't
 * moved would tell the fantasy side nothing new.
 */
async function runOne(entry: AutoSendEntry): Promise<void> {
  const link = await readLink(entry.matchId);
  if (!link) {
    await disableAutoSend(entry.matchId);
    return;
  }

  let match: any;
  try {
    const payload = await apiGet<any>(`/matches/${entry.matchId}`);
    match = Array.isArray(payload) ? payload[0] : payload;
    await saveMatch(entry.matchId, match);
  } catch (error) {
    // Out of quota, or Highlightly unreachable. Fall back to whatever is
    // cached rather than stopping: the next cycle may well succeed.
    const cached = await getCachedMatch<any>(entry.matchId);
    if (!cached) {
      await recordRun(entry.matchId, `Refresh failed: ${(error as Error).message}`);
      return;
    }
    match = cached.data;
    await recordRun(entry.matchId, `Refresh failed (${(error as Error).message}); sent cached data`);
  }

  const state = String(match?.state?.description ?? "");

  // Wind down once the match has been finished for a while.
  if (isFinished(state)) {
    const seenAt = entry.finishedSeenAt ?? new Date().toISOString();

    if (Date.now() - new Date(seenAt).getTime() >= STOP_AFTER_FINISH_MS) {
      await pushNow(entry.matchId, match, "Final send, auto-send switched off");
      await disableAutoSend(entry.matchId);
      return;
    }

    await recordRun(entry.matchId, "Match finished — one more cycle before stopping", seenAt);
  } else if (!isLive(state)) {
    // Scheduled or postponed: nothing to send, and nothing to stop for.
    await recordRun(entry.matchId, `Waiting — match is ${state || "not started"}`);
    return;
  }

  await pushNow(entry.matchId, match, null);
}

async function pushNow(matchId: string, match: any, overrideResult: string | null) {
  const extracted = extractMatchStats(match);

  if (extracted.players.length === 0) {
    await recordRun(matchId, "Nothing to send yet — scorecard is empty");
    return;
  }

  try {
    const result = await sendScore({
      matchId,
      innings: extracted.innings,
      players: extracted.players as unknown as ({ name: string } & Record<string, unknown>)[],
    });

    await recordRun(
      matchId,
      overrideResult ??
        `Sent ${result.playersUpdated} players` +
          (result.skippedNames.length > 0 ? `, skipped ${result.skippedNames.length}` : "") +
          (result.pointsCalculated ? ", points recalculated" : ", points NOT recalculated")
    );
  } catch (error) {
    await recordRun(matchId, `Send failed: ${(error as Error).message}`);
  }
}

let timer: ReturnType<typeof setInterval> | null = null;

/** Starts the loop. Safe to call once at boot. */
export function startAutoSendLoop() {
  if (timer) return;

  timer = setInterval(() => {
    void (async () => {
      const entries = await listAutoSend();

      // Sequential on purpose: two matches refreshing at once would
      // double the request rate in a burst, and there is no hurry.
      for (const entry of entries) {
        try {
          await runOne(entry);
        } catch (error) {
          console.error(`Auto-send failed for ${entry.matchId}:`, error);
        }
      }
    })();
  }, AUTO_SEND_INTERVAL_MS);

  // Node would otherwise keep the process alive purely for this timer,
  // which is fine for a server but noisy in tests.
  timer.unref?.();
}
