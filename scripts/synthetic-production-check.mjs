#!/usr/bin/env node
/**
 * External IranPay synthetic runner. Read-only HTTP probes + optional HMAC ingest.
 * Exit 0 = required checks healthy (and ingest ok when required).
 * Never prints secrets, cookies, or response bodies.
 */
import { runAndMaybeIngest } from "./synthetic-production-check.lib.mjs";

function summarize(result) {
  return {
    runId: result.runId,
    runnerId: result.runnerId,
    requiredHealthy: result.requiredHealthy,
    ingest: result.ingest.skipped ? "skipped" : result.ingest.ok ? "ok" : `http_${result.ingest.status}`,
    checks: result.checks.map((c) => ({
      checkKey: c.checkKey,
      status: c.status,
      durationMs: c.durationMs,
      httpStatus: c.httpStatus,
      failureCode: c.failureCode,
    })),
  };
}

const result = await runAndMaybeIngest({ env: process.env });
process.stdout.write(`${JSON.stringify(summarize(result))}\n`);
if (!result.requiredHealthy) process.exit(1);
if (!result.ingest.skipped && !result.ingest.ok) process.exit(2);
process.exit(0);
