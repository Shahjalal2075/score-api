/**
 * Turns a Highlightly match into the figures the fantasy service wants.
 *
 * Two things are worth knowing about the source data:
 *
 * 1. Nothing says which bowler took a wicket. The batsman's dismissal
 *    records how they went out, and the bowler's line records how many
 *    they took, but the two are never joined — so the bowled/LBW split
 *    per bowler can't be derived and is left for an admin to enter.
 *
 * 2. Fielding is not reported per player. It is reconstructed from the
 *    opposing batsmen's dismissals, which do name the fielders involved.
 */

/**
 * One player's figures for one innings.
 *
 * Every stat is optional and only present when this innings actually
 * says something about it. A bowler who didn't bat sends no batting
 * fields at all, rather than a row of zeroes — the receiving side merges
 * on what's present, and a zero would overwrite real figures recorded
 * elsewhere.
 */
export interface PlayerStats {
  name: string;
  inningsNumber: number;

  runs?: number;
  ballsFaced?: number;
  fours?: number;
  sixes?: number;
  isOut?: boolean;

  ballsBowled?: number;
  maidens?: number;
  runsConceded?: number;
  wickets?: number;

  catches?: number;
  stumpings?: number;
  runOutsDirect?: number;
  runOutsIndirect?: number;
}

export interface InningsTotal {
  inningsNumber: number;
  teamName: string;
  runs: number;
  wickets: number;
  /** Cricket notation: 19.4 is 19 overs and 4 balls. */
  overs: number;
}

export interface ExtractResult {
  innings: InningsTotal[];
  players: PlayerStats[];
  /** Every distinct player name seen, for the pairing step. */
  names: string[];
}

/** Cricket-notation overs (19.4) to a ball count (118). */
function oversToBalls(overs: number | null | undefined): number {
  if (!overs) return 0;
  const whole = Math.floor(overs);
  const fraction = Number((overs - whole).toFixed(2));
  return whole * 6 + Math.min(Math.round(fraction * 10), 5);
}

/** Ball count back to cricket notation, for the scoreboard line. */
function ballsToOvers(balls: number): number {
  return Math.floor(balls / 6) + (balls % 6) / 10;
}

function blank(name: string, inningsNumber: number): PlayerStats {
  return { name, inningsNumber };
}

export function extractMatchStats(match: any): ExtractResult {
  const raw: any[] = match?.statistics ?? [];

  /**
   * One entry per innings number, keeping the last seen.
   *
   * A live feed can repeat an innings — the same one twice in a payload,
   * or an in-progress innings alongside a completed copy of itself.
   * Batting and bowling figures are assigned, so a repeat is harmless
   * there. Fielding is not: it's accumulated from the opposing batsmen's
   * dismissals, so a duplicated innings credits every catch, stumping
   * and run out twice. Collapsing first makes extraction idempotent.
   */
  const byInnings = new Map<number, any>();
  for (const entry of raw) {
    if (!entry?.team) continue;
    byInnings.set(entry.inningNumber ?? 1, entry);
  }

  const statistics = [...byInnings.values()];

  const innings: InningsTotal[] = [];
  // Keyed by "inningsNumber|name" — a player has separate figures in
  // each innings, which is what Test scoring needs.
  const players = new Map<string, PlayerStats>();
  const names = new Set<string>();

  function get(name: string, inningsNumber: number): PlayerStats {
    const key = `${inningsNumber}|${name}`;
    let entry = players.get(key);
    if (!entry) {
      entry = blank(name, inningsNumber);
      players.set(key, entry);
    }
    names.add(name);
    return entry;
  }

  for (const entry of statistics) {
    const side = entry?.team;
    if (!side) continue;

    const inningsNumber = entry.inningNumber ?? 1;
    /** Last entry wins, for the same reason innings are collapsed above. */
    function dedupe(list: any[]): any[] {
      const byName = new Map<string, any>();
      for (const row of list ?? []) {
        const name = row?.player?.name;
        if (name) byName.set(name, row);
      }
      return [...byName.values()];
    }

    const batsmen: any[] = dedupe(side.inningBatsmen);
    const bowlers: any[] = dedupe(side.inningBowlers);

    // ---- Batting ----
    for (const batsman of batsmen) {
      const name = batsman?.player?.name;
      if (!name) continue;

      const stats = get(name, inningsNumber);

      // A player who hasn't batted comes back with nulls rather than
      // zeroes. Zero is the right value to send: they were in the XI
      // and scored nothing, which is different from "no data".
      stats.runs = batsman.runs ?? 0;
      stats.ballsFaced = batsman.balls ?? 0;
      stats.fours = batsman.fours ?? 0;
      stats.sixes = batsman.sixes ?? 0;
      stats.isOut = !!batsman.dismissalStatus && batsman.dismissalStatus !== "not out";
    }

    // ---- Bowling ----
    for (const bowler of bowlers) {
      const name = bowler?.player?.name;
      if (!name) continue;

      const stats = get(name, inningsNumber);
      stats.ballsBowled = oversToBalls(bowler.overs);
      stats.maidens = bowler.maidens ?? 0;
      stats.runsConceded = bowler.concededRuns ?? 0;
      stats.wickets = bowler.wickets ?? 0;
    }

    // ---- Fielding ----
    //
    // Credited to the side that was bowling, and recorded against the
    // innings in which the dismissal happened.
    for (const batsman of batsmen) {
      const status = String(batsman?.dismissalStatus ?? "").toLowerCase();
      const fielders: any[] = batsman?.dismissalFielders ?? [];
      if (!status || fielders.length === 0) continue;

      if (status.includes("stumped")) {
        for (const fielder of fielders) {
          if (!fielder?.name) continue;
          const stats = get(fielder.name, inningsNumber);
          stats.stumpings = (stats.stumpings ?? 0) + 1;
        }
        continue;
      }

      if (status.includes("run out")) {
        // One fielder involved is a direct hit; more than one means the
        // throw was relayed.
        const direct = fielders.length === 1;
        for (const fielder of fielders) {
          if (!fielder?.name) continue;
          const stats = get(fielder.name, inningsNumber);
          if (direct) stats.runOutsDirect = (stats.runOutsDirect ?? 0) + 1;
          else stats.runOutsIndirect = (stats.runOutsIndirect ?? 0) + 1;
        }
        continue;
      }

      if (status.includes("caught")) {
        for (const fielder of fielders) {
          if (!fielder?.name) continue;
          const stats = get(fielder.name, inningsNumber);
          stats.catches = (stats.catches ?? 0) + 1;
        }
      }
    }

    // ---- Scoreboard line ----
    //
    // Highlightly publishes no innings total, so it's summed: batters
    // plus extras for runs, dismissals for wickets, bowlers' overs for
    // the over count.
    const runs =
      batsmen.reduce((sum, b) => sum + (b.runs ?? 0), 0) + (side.extras ?? 0);

    const wickets = batsmen.filter(
      (b) => b.dismissalStatus && b.dismissalStatus !== "not out"
    ).length;

    const balls = bowlers.reduce((sum, b) => sum + oversToBalls(b.overs), 0);

    innings.push({
      inningsNumber,
      teamName: side.name ?? "",
      runs,
      wickets,
      overs: ballsToOvers(balls),
    });
  }

  // The squad names matter for pairing even when nobody has batted yet.
  for (const squad of match?.squad ?? []) {
    for (const player of squad?.players ?? []) {
      if (player?.name) names.add(player.name);
    }
  }

  return {
    innings: innings.sort((a, b) => a.inningsNumber - b.inningsNumber),
    players: [...players.values()],
    names: [...names],
  };
}
