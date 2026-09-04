import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Talks to the fantasy service.
 *
 * That system is a separate application with its own database on its own
 * host. Nothing is shared but these two HTTP calls and a key — this file
 * is the entire surface between them.
 */

const FANTASY_URL = process.env.FANTASY_API_URL || "";
const SYNC_KEY = process.env.LIVE_SYNC_KEY || "";

const DATA_DIR = path.resolve(process.cwd(), "data");

export class BridgeNotConfiguredError extends Error {
  constructor() {
    super("Set FANTASY_API_URL and LIVE_SYNC_KEY in .env to link with the fantasy service.");
  }
}

async function post<T>(endpoint: string, body: unknown): Promise<T> {
  if (!FANTASY_URL || !SYNC_KEY) throw new BridgeNotConfiguredError();

  const response = await fetch(new URL(endpoint, FANTASY_URL), {
    method: "POST",
    headers: { "content-type": "application/json", "x-live-sync-key": SYNC_KEY },
    body: JSON.stringify(body),
  });

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      (payload as { error?: string }).error ?? `Fantasy service returned ${response.status}`
    );
  }
  return payload as T;
}

// ---------- Local record of a pairing ----------

export interface PairedPlayer {
  /** The name as the live service knows it. */
  liveName: string;
  /** The code the fantasy service issued; this is the real identity. */
  code: string;
  fantasyName: string;
}

export interface MatchLink {
  /** Pairing code, generated in the fantasy admin panel. */
  code: string;
  fantasyMatchName: string;
  connectedAt: string;
  lastSentAt: string | null;
  players: PairedPlayer[];
  /** Live names with no counterpart on the fantasy side. */
  unmatched: string[];
}

function linkFile(matchId: string) {
  return path.join(DATA_DIR, "links", `${matchId}.json`);
}

export async function readLink(matchId: string): Promise<MatchLink | null> {
  try {
    return JSON.parse(await fs.readFile(linkFile(matchId), "utf8")) as MatchLink;
  } catch {
    return null;
  }
}

async function writeLink(matchId: string, link: MatchLink) {
  const file = linkFile(matchId);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(link, null, 2), "utf8");
}

export async function forgetLink(matchId: string) {
  try {
    await fs.unlink(linkFile(matchId));
  } catch {
    // Already gone.
  }
}

// ---------- The two calls ----------

interface ConnectResponse {
  matchId: string;
  matchName: string;
  connected: { code: string; liveName: string; fantasyName: string; automatic: boolean }[];
  unmatched: string[];
  missing: { matchPlayerId: string; name: string; code: string }[];
}

/**
 * Pairs this match with a fantasy fixture, and reconciles the squad.
 *
 * Safe to repeat: existing codes are reused, so re-running after a
 * refetch keeps every pairing intact and simply updates who is currently
 * in the squad.
 */
export async function connectMatch(input: {
  matchId: string;
  code: string;
  label: string;
  names: string[];
}) {
  const existing = await readLink(input.matchId);

  // Send back the codes we already hold. The fantasy side trusts a code
  // over a name, which is what survives a rename or a duplicate.
  const knownCodes = new Map(existing?.players.map((p) => [p.liveName, p.code]) ?? []);

  const result = await post<ConnectResponse>("/api/live-sync/connect", {
    code: input.code.trim().toUpperCase(),
    liveMatchId: input.matchId,
    liveLabel: input.label,
    players: input.names.map((name) => ({ name, code: knownCodes.get(name) })),
  });

  const link: MatchLink = {
    code: input.code.trim().toUpperCase(),
    fantasyMatchName: result.matchName,
    connectedAt: new Date().toISOString(),
    lastSentAt: existing?.lastSentAt ?? null,
    players: result.connected.map((row) => ({
      liveName: row.liveName,
      code: row.code,
      fantasyName: row.fantasyName,
    })),
    unmatched: result.unmatched,
  };

  await writeLink(input.matchId, link);
  return { link, missing: result.missing };
}

interface ScoreResponse {
  playersUpdated: number;
  inningsUpdated: number;
  skipped: string[];
  pointsCalculated: boolean;
  pointsError: string | null;
}

/** Pushes a scorecard. The fantasy side merges and recalculates points. */
export async function sendScore(input: {
  matchId: string;
  innings: unknown[];
  players: ({ name: string } & Record<string, unknown>)[];
}) {
  const link = await readLink(input.matchId);
  if (!link) throw new Error("This match isn't paired with a fantasy fixture.");

  const codeByName = new Map(link.players.map((p) => [p.liveName, p.code]));

  // Only paired players are sent; anyone unpaired is reported back so
  // the panel can name them rather than silently dropping them.
  const skippedNames: string[] = [];
  const players = input.players
    .map((player) => {
      const code = codeByName.get(player.name);
      if (!code) {
        if (!skippedNames.includes(player.name)) skippedNames.push(player.name);
        return null;
      }
      const { name, ...stats } = player;
      return { code, ...stats };
    })
    .filter(Boolean);

  const result = await post<ScoreResponse>("/api/live-sync/score", {
    code: link.code,
    innings: input.innings,
    players,
  });

  await writeLink(input.matchId, { ...link, lastSentAt: new Date().toISOString() });

  return { ...result, skippedNames, sentAt: new Date().toISOString() };
}

/**
 * Sets the code for one live player by hand.
 *
 * Two cases need this. A player whose name doesn't match anything on the
 * fantasy side has no code at all — an admin reads the right one out of
 * the fantasy panel and enters it here. And when automatic matching
 * pairs the wrong two people, which happens when a squad has two players
 * of the same name, correcting the code repoints it.
 *
 * The stored record is updated first, then the pairing is re-run so the
 * fantasy side binds the code to the same player. Codes always beat
 * names there, so this is what makes the correction stick.
 */
export async function setPlayerCode(input: {
  matchId: string;
  liveName: string;
  code: string;
  /** Every live name, so the reconcile step sees the whole squad. */
  names: string[];
  label: string;
}) {
  const link = await readLink(input.matchId);
  if (!link) throw new Error("This match isn't paired with a fantasy fixture.");

  const code = input.code.trim().toUpperCase();

  const clash = link.players.find(
    (player) => player.code === code && player.liveName !== input.liveName
  );
  if (code && clash) {
    throw new Error(`${clash.liveName} already uses that code. Codes must be unique per match.`);
  }

  const others = link.players.filter((player) => player.liveName !== input.liveName);

  await writeLink(input.matchId, {
    ...link,
    players: code
      ? [...others, { liveName: input.liveName, code, fantasyName: "" }]
      : others,
  });

  // Re-run the pairing so the fantasy side records the same binding.
  return connectMatch({
    matchId: input.matchId,
    code: link.code,
    label: input.label,
    names: input.names,
  });
}
