/**
 * Persistent Bonbast collector for GitHub-hosted runners.
 * Fetches the public cash board and HMAC-posts it to IranPay.
 * A scheduled tick stops after the first confirmed ingest (accepted>0).
 */
import {
  collectOnce,
  collectorProcessExitCode,
  runCollectorLoop,
} from "./bonbast-collector.lib.mjs";

const INTERVAL_MS = Number(process.env.COLLECTOR_INTERVAL_MS || 30_000);
const DURATION_MS = Number(process.env.COLLECTOR_DURATION_MS || 18_600_000);

const { okCount, lastError } = await runCollectorLoop({
  collect: (opts) => collectOnce(opts),
  durationMs: DURATION_MS,
  intervalMs: INTERVAL_MS,
});

if (collectorProcessExitCode(okCount) !== 0) {
  console.error(`bonbast collector exited with no successful ingest (${lastError?.message ?? "unknown"})`);
  process.exit(1);
}
