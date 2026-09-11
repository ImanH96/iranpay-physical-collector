#!/usr/bin/env node
/**
 * Keep-alive synthetic session. GitHub cron cannot honor a 5-minute
 * schedule, so one public-repo job ticks the vendored runner every
 * SYNTHETIC_INTERVAL_MS until SYNTHETIC_DURATION_MS elapses.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const runner = path.join(here, "synthetic-production-check.mjs");
const intervalMs = Math.max(30_000, Number(process.env.SYNTHETIC_INTERVAL_MS || 300_000));
const durationMs = Math.max(intervalMs, Number(process.env.SYNTHETIC_DURATION_MS || 17_400_000));
const endAt = Date.now() + durationMs;

function runTick(tick) {
  return new Promise((resolve) => {
    const startedAt = new Date().toISOString();
    const child = spawn(process.execPath, [runner], {
      env: { ...process.env, SYNTHETIC_RUN_ID: process.env.SYNTHETIC_RUN_ID || `session-${startedAt}-${tick}` },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (buf) => {
      stdout += buf.toString("utf8");
    });
    child.stderr.on("data", (buf) => {
      stderr += buf.toString("utf8");
    });
    child.on("close", (code) => {
      process.stdout.write(
        `${JSON.stringify({
          tick,
          startedAt,
          finishedAt: new Date().toISOString(),
          exit: code,
          summary: stdout.trim() || null,
          stderr: stderr.trim() ? "present" : null,
        })}\n`,
      );
      resolve(code === 0);
    });
  });
}

let tick = 0;
let ok = 0;
while (Date.now() < endAt) {
  tick += 1;
  if (await runTick(tick)) ok += 1;
  const remaining = endAt - Date.now();
  if (remaining <= 0) break;
  await new Promise((r) => setTimeout(r, Math.min(intervalMs, remaining)));
}

process.stdout.write(
  `${JSON.stringify({
    sessionEnd: true,
    sessionTicks: tick,
    sessionOk: ok,
    intervalMs,
    durationMs,
    endedAt: new Date().toISOString(),
  })}\n`,
);
process.exit(ok > 0 ? 0 : 1);
