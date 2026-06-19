const { Pool, types: pgTypes } = require("pg");
const {
  currentWeekStartKST,
  previousWeekStarts,
  ensureWeeklyReportsTable,
  generateSaveAndPostWeeklyReport,
} = require("../src/team-weekly-report");

pgTypes.setTypeParser(1082, (val) => val);

function parseArgs(argv) {
  const args = {
    weeks: 2,
    webhookUrl: process.env.TEAM_WEEKLY_WEBHOOK_URL || "",
    dryRun: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") {
      args.dryRun = true;
    } else if (arg === "--weeks") {
      args.weeks = Number(argv[++i] || args.weeks);
    } else if (arg === "--webhook") {
      args.webhookUrl = argv[++i] || "";
    }
  }
  if (!Number.isInteger(args.weeks) || args.weeks < 1) {
    throw new Error("--weeks must be a positive integer");
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required");
  }
  if (!args.dryRun && !args.webhookUrl) {
    throw new Error("TEAM_WEEKLY_WEBHOOK_URL or --webhook is required");
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await ensureWeeklyReportsTable(pool);
    const weekStarts = previousWeekStarts(args.weeks, currentWeekStartKST());
    for (const weekStart of weekStarts) {
      if (args.dryRun) {
        const { generateWeeklyReport, saveWeeklyReport } = require("../src/team-weekly-report");
        const report = await generateWeeklyReport(pool, weekStart);
        await saveWeeklyReport(pool, report);
        console.log(`Saved weekly report for ${report.weekStart} (${report.content.length} chars)`);
        console.log(report.content);
      } else {
        const report = await generateSaveAndPostWeeklyReport(pool, weekStart, args.webhookUrl);
        console.log(
          `Posted weekly report for ${report.weekStart} (${report.messageIds.length} Discord message(s))`
        );
      }
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
