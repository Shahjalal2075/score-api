import "dotenv/config";
import { apiGet, getQuota } from "./highlightly.ts";

/**
 * Prints exactly what Highlightly returns, so a missing scorecard can be
 * pinned on the API rather than guessed at.
 *
 *   npm run diagnose                  today, in your configured timezone
 *   npm run diagnose -- 2026-09-01    a specific date
 *   npm run diagnose -- 2026-09-01 48514657   and a specific match
 *
 * Costs 2 requests: one for the day's fixtures, one for a match.
 */

const TIMEZONE = process.env.TIMEZONE || "Asia/Dhaka";

function todayInZone(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function line(char = "─") {
  console.log(char.repeat(64));
}

/** Reports whether a field arrived, and how much of it. */
function report(label: string, value: unknown) {
  if (value === undefined || value === null) {
    console.log(`  ✗ ${label.padEnd(22)} missing`);
    return;
  }
  if (Array.isArray(value)) {
    console.log(`  ${value.length > 0 ? "✓" : "✗"} ${label.padEnd(22)} ${value.length} item(s)`);
    return;
  }
  if (typeof value === "object") {
    const keys = Object.keys(value as object);
    console.log(`  ✓ ${label.padEnd(22)} { ${keys.slice(0, 6).join(", ")}${keys.length > 6 ? ", …" : ""} }`);
    return;
  }
  console.log(`  ✓ ${label.padEnd(22)} ${String(value)}`);
}

async function main() {
  const [dateArg, matchIdArg] = process.argv.slice(2);
  const date = dateArg || todayInZone();

  line("═");
  console.log("HIGHLIGHTLY DIAGNOSTIC");
  line("═");

  console.log(`Base URL : ${process.env.HIGHLIGHTLY_BASE_URL || "https://cricket.highlightly.net"}`);
  console.log(`Timezone : ${TIMEZONE}`);
  console.log(`Date     : ${date}`);
  console.log(`Key set  : ${process.env.HIGHLIGHTLY_API_KEY ? "yes" : "NO — nothing will work"}`);

  const before = await getQuota();
  console.log(`Requests : ${before.used} used, ${before.remaining} left today`);

  // ---------- 1. Fixtures ----------
  line();
  console.log(`STEP 1  GET /matches?date=${date}`);
  line();

  let matches: any[] = [];
  try {
    const payload = await apiGet<any>("/matches", { date, timezone: TIMEZONE, limit: 100 });
    matches = payload?.data ?? [];

    console.log(`  Matches returned: ${matches.length}`);

    // The plan field is where the API admits to withholding data.
    if (payload?.plan) {
      console.log(`  Plan tier       : ${payload.plan.tier}`);
      if (payload.plan.message) console.log(`  Plan message    : ${payload.plan.message}`);
    }
    if (payload?.pagination) {
      console.log(`  Total available : ${payload.pagination.totalCount}`);
    }

    if (matches.length === 0) {
      console.log("\n  Nothing for this date. Either no cricket was played, or the");
      console.log("  free plan is hiding it. Try a date with a well-known fixture.");
    }

    const byState = new Map<string, number>();
    for (const match of matches) {
      const state = match.state?.description ?? "Unknown";
      byState.set(state, (byState.get(state) ?? 0) + 1);
    }
    console.log(
      `  States          : ${[...byState].map(([state, count]) => `${state} ×${count}`).join(", ")}`
    );

    for (const match of matches.slice(0, 12)) {
      const state = match.state?.description ?? "?";
      const home = match.state?.teams?.home?.score ?? "—";
      const away = match.state?.teams?.away?.score ?? "—";
      console.log(
        `   • [${String(match.id).padEnd(10)}] ${String(match.format).padEnd(5)} ` +
          `${state.padEnd(16)} ${match.homeTeam?.abbreviation ?? "?"} ${home} v ${away} ${match.awayTeam?.abbreviation ?? "?"}`
      );
    }
  } catch (error) {
    console.log(`  FAILED: ${(error as Error).message}`);
    return;
  }

  // ---------- 2. One match in detail ----------
  // Pick the most informative match rather than simply the first.
  //
  // A scheduled club fixture carries no squad and no scorecard, so
  // inspecting one tells you nothing about whether the API works — it
  // just looks broken. Prefer a game in progress, then a finished one,
  // and among those prefer a match that already reports a score.
  function rank(match: any): number {
    const state = String(match.state?.description ?? "").toLowerCase();
    const hasScore = !!(match.state?.teams?.home?.score || match.state?.teams?.away?.score);

    if (/in play|innings break|drinks|lunch|tea|stumps|timeout/.test(state)) return 0;
    if (/finished/.test(state)) return hasScore ? 1 : 2;
    return 3;
  }

  const best = [...matches].sort((a, b) => rank(a) - rank(b))[0];
  const targetId = matchIdArg || best?.id;

  if (!matchIdArg && best) {
    const state = best.state?.description ?? "?";
    console.log(`\n  Inspecting the most informative match: ${state}`);
    if (rank(best) === 3) {
      console.log("  NOTE: every match on this date is still scheduled. Squads and");
      console.log("  scorecards only appear near the start of play, so the section");
      console.log("  below will be mostly empty. Try a past date for a full picture.");
    }
  }
  if (!targetId) {
    console.log("\nNo match to inspect. Pass a match id as the second argument.");
    return;
  }

  line();
  console.log(`STEP 2  GET /matches/${targetId}`);
  line();

  try {
    const payload = await apiGet<any>(`/matches/${targetId}`);
    const match = Array.isArray(payload) ? payload[0] : payload;

    if (!match) {
      console.log("  Empty response — the API returned no match for this id.");
      return;
    }

    console.log(`  ${match.homeTeam?.name} vs ${match.awayTeam?.name}`);
    console.log(`  State: ${match.state?.description}`);
    console.log(`  Score: ${match.state?.teams?.home?.score} / ${match.state?.teams?.away?.score}`);
    console.log("\n  Which sections arrived:");

    report("venue", match.venue);
    report("squad", match.squad);
    report("statistics", match.statistics);
    report("inplayData", match.inplayData);
    report("inplayData.batsmen", match.inplayData?.batsmen);
    report("inplayData.bowlers", match.inplayData?.bowlers);
    report("bestBatsmen", match.bestBatsmen);
    report("bestBowlers", match.bestBowlers);
    report("predictions", match.predictions);

    const firstInnings = match.statistics?.[0];
    if (firstInnings) {
      console.log("\n  First innings contents:");
      report("inningBatsmen", firstInnings.inningBatsmen);
      report("inningBowlers", firstInnings.inningBowlers);
      report("fallOfWickets", firstInnings.fallOfWickets);
      console.log(`    extras: ${firstInnings.extras}, fours: ${firstInnings.fours}, sixes: ${firstInnings.sixes}`);
    }

    if (match.squad?.[0]) {
      console.log(`\n  Squad sample (${match.squad[0].team?.name}):`);
      for (const player of (match.squad[0].players ?? []).slice(0, 5)) {
        console.log(`    - ${player.name} [${(player.roles ?? []).join(", ") || "no role"}]`);
      }
    }

    console.log("\n  Top-level keys the API actually sent:");
    console.log(`    ${Object.keys(match).join(", ")}`);

    // The decisive part. The documented sample and the live response do
    // not always agree on field names, and a mismatch shows up as a
    // table with headers and no rows. Printing the real shape settles it.
    if (match.statistics?.[0]) {
      line();
      console.log("RAW  statistics[0] — the actual field names");
      line();
      console.log(`  keys: ${Object.keys(match.statistics[0]).join(", ")}`);
      console.log("");
      console.log(JSON.stringify(match.statistics[0], null, 2).slice(0, 2500));
    }

    if (match.squad?.[0]) {
      line();
      console.log("RAW  squad[0]");
      line();
      console.log(`  keys: ${Object.keys(match.squad[0]).join(", ")}`);
      console.log(JSON.stringify(match.squad[0], null, 2).slice(0, 1200));
    }
  } catch (error) {
    console.log(`  FAILED: ${(error as Error).message}`);
  }

  const after = await getQuota();
  line();
  console.log(`Requests now: ${after.used} used, ${after.remaining} left today`);
  line("═");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
