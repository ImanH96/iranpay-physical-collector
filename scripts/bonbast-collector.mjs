/**
 * Persistent Bonbast collector for GitHub-hosted runners.
 * Fetches the public cash board and HMAC-posts it to IranPay.
 */
import { collectOnce, collectorProcessExitCode } from "./bonbast-collector.lib.mjs";

const INTERVAL_MS = Number(process.env.COLLECTOR_INTERVAL_MS || 30_000);
const DURATION_MS = Number(process.env.COLLECTOR_DURATION_MS || 18_600_000);

const started = Date.now();
let stop = false;
process.on("SIGTERM", () => {
  stop = true;
});
process.on("SIGINT", () => {
  stop = true;
});

let okCount = 0;
let lastError = null;
do {
  try {
    const r = await collectOnce();
    okCount += 1;
    lastError = null;
    console.log(
      `bonbast ingest ok ${r.fetchedAt} via=${r.base} last=${r.book.last_update ?? "?"} usd=${r.book.usd1}/${r.book.usd2} accepted=${r.accepted}`,
    );
  } catch (e) {
    lastError = e;
    console.error(`bonbast tick failed: ${e.message}`);
  }
  if (stop || Date.now() - started >= DURATION_MS) break;
  await new Promise((r) => setTimeout(r, INTERVAL_MS));
} while (!stop && Date.now() - started < DURATION_MS);

if (collectorProcessExitCode(okCount) !== 0) {
  console.error(`bonbast collector exited with no successful ingest (${lastError?.message ?? "unknown"})`);
  process.exit(1);
}
