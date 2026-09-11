/**
 * Vendored from ImanH96/P2P-IranPay scripts/prod/synthetic-production-check.lib.mjs
 * Read-only production synthetic probes. Static allowlisted URLs only.
 * Never prints response bodies, cookies, or secrets.
 *
 * Do not fall back to GITHUB_SHA: this public repo's commit is not IranPay's
 * production SHA. Pin SYNTHETIC_EXPECTED_GIT_SHA to the live API gitSha.
 */
import { createHmac, randomUUID } from "node:crypto";

export const DEFAULT_API_BASE = "https://iranpay-api.onrender.com";
export const DEFAULT_WEB_BASE = "https://iran-pay.vercel.app";
export const REQUEST_TIMEOUT_MS = 20_000;
/** Render Free can sit cold; scheduled runs must survive the wake. */
export const API_WAKE_TIMEOUT_MS = 45_000;

export const ALLOWED_API_BASES = Object.freeze([
  "https://iranpay-api.onrender.com",
  "http://127.0.0.1:4200",
  "http://localhost:4200",
]);

export const ALLOWED_WEB_BASES = Object.freeze([
  "https://iran-pay.vercel.app",
  "http://127.0.0.1:4100",
  "http://localhost:4100",
]);

const VERCEL_ERROR_MARKERS = [
  "DEPLOYMENT_NOT_FOUND",
  "DEPLOYMENT_DISABLED",
  "This deployment",
  "NOT_FOUND",
  "Vercel Authentication",
];

const IRANPAY_MARKERS = ["ایران‌پی", "IranPay", "iran-pay"];
const LOGIN_MARKERS = ["ورود", "ایران‌پی", "IranPay"];

export function collectorSignature(secret, timestamp, rawBody) {
  return createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
}

export function resolveApiBase(env = process.env) {
  const raw = String(env.SYNTHETIC_API_BASE || env.IRANPAY_API_BASE || DEFAULT_API_BASE).replace(/\/+$/, "");
  if (!ALLOWED_API_BASES.includes(raw)) {
    throw new Error("SYNTHETIC_API_BASE_NOT_ALLOWLISTED");
  }
  return raw;
}

export function resolveWebBase(env = process.env) {
  const raw = String(env.SYNTHETIC_WEB_BASE || DEFAULT_WEB_BASE).replace(/\/+$/, "");
  if (!ALLOWED_WEB_BASES.includes(raw)) {
    throw new Error("SYNTHETIC_WEB_BASE_NOT_ALLOWLISTED");
  }
  return raw;
}

export function classifyFetchError(err) {
  const code = err && typeof err === "object" ? String(err.cause?.code || err.code || "") : "";
  const name = err && typeof err === "object" ? String(err.name || "") : "";
  const message = err instanceof Error ? err.message : String(err || "");
  if (name === "AbortError" || /aborted|timeout/i.test(message)) return "REQUEST_TIMEOUT";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN" || code === "EAI_FAIL") return "DNS_FAILURE";
  if (code === "ETIMEDOUT" || code === "ESOCKETTIMEDOUT") return "CONNECT_TIMEOUT";
  if (code === "ECONNREFUSED" || code === "ECONNRESET" || code === "EHOSTUNREACH") return "CONNECT_TIMEOUT";
  return "REQUEST_TIMEOUT";
}

function truncateMarker(text, max = 80_000) {
  return String(text || "").slice(0, max);
}

export function htmlLooksLikeIranPay(html) {
  const body = truncateMarker(html);
  if (VERCEL_ERROR_MARKERS.some((m) => body.includes(m) && !body.includes("ایران‌پی"))) {
    if (VERCEL_ERROR_MARKERS.some((m) => body.includes(m))) return false;
  }
  if (VERCEL_ERROR_MARKERS.some((m) => body.includes(m)) && !IRANPAY_MARKERS.some((m) => body.includes(m))) {
    return false;
  }
  return IRANPAY_MARKERS.some((m) => body.includes(m));
}

export function htmlLooksLikeLogin(html) {
  const body = truncateMarker(html);
  if (!htmlLooksLikeIranPay(body)) return false;
  return LOGIN_MARKERS.some((m) => body.includes(m));
}

export function validateHealthJson(json, nodeEnvRequired = true) {
  if (!json || typeof json !== "object") return { ok: false, code: "INVALID_RESPONSE" };
  if (json.ok !== true) return { ok: false, code: "CONTRACT_FAILURE" };
  const sha = typeof json.gitSha === "string" ? json.gitSha.trim() : "";
  if (!sha) return { ok: false, code: "CONTRACT_FAILURE" };
  if (nodeEnvRequired && json.nodeEnv && json.nodeEnv !== "production" && json.nodeEnv !== "non-production") {
    return { ok: false, code: "CONTRACT_FAILURE" };
  }
  return { ok: true, gitSha: sha, nodeEnv: json.nodeEnv ?? null };
}

export function validateMarketPayload(pairs, currencies) {
  if (!pairs || !Array.isArray(pairs.items) || !currencies || !Array.isArray(currencies.items)) {
    return { ok: false, code: "INVALID_RESPONSE" };
  }
  const pairCodes = pairs.items.map((p) => String(p?.pair || "")).filter(Boolean);
  const currencyCodes = currencies.items.map((c) => String(c?.code || "")).filter(Boolean);
  if (!pairCodes.includes("USDT/IRT")) return { ok: false, code: "CONTRACT_FAILURE" };
  if (!currencyCodes.includes("USDT") || !currencyCodes.includes("IRT")) {
    return { ok: false, code: "CONTRACT_FAILURE" };
  }
  const dump = JSON.stringify({ pairs: pairs.items, currencies: currencies.items });
  if (dump.includes("NaN") || dump.includes("null")) {
    const hasNullCorruption = pairs.items.some(
      (p) => p == null || p.pair == null || p.base == null || p.quote == null,
    ) || currencies.items.some((c) => c == null || c.code == null);
    if (hasNullCorruption) return { ok: false, code: "CONTRACT_FAILURE" };
  }
  return { ok: true };
}

export function classifyAuthBoundary(status) {
  if (status === 401 || status === 403) return { status: "PASS", failureCode: null };
  if (status === 200) return { status: "FAIL", failureCode: "AUTH_BOUNDARY_FAILURE" };
  if (status >= 500) return { status: "FAIL", failureCode: "HTTP_5XX" };
  return { status: "FAIL", failureCode: "UNEXPECTED_HTTP_STATUS" };
}

async function timedFetch(fetchImpl, url, init, timeoutMs = REQUEST_TIMEOUT_MS) {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { ...init, signal: ac.signal, redirect: init?.redirect ?? "follow" });
    const durationMs = Date.now() - t0;
    return { startedAt, durationMs, res, error: null };
  } catch (error) {
    return { startedAt, durationMs: Date.now() - t0, res: null, error };
  } finally {
    clearTimeout(timer);
  }
}

function fail(startedAt, durationMs, httpStatus, failureCode) {
  return { startedAt, durationMs, status: "FAIL", httpStatus, failureCode };
}

function pass(startedAt, durationMs, httpStatus) {
  return { startedAt, durationMs, status: "PASS", httpStatus, failureCode: null };
}

export async function runS1ApiHealth(fetchImpl, apiBase, opts = {}) {
  const url = `${apiBase}/api/v1/health`;
  const got = await timedFetch(fetchImpl, url, { method: "GET" }, opts.timeoutMs ?? API_WAKE_TIMEOUT_MS);
  if (got.error) return { checkKey: "S1_API_HEALTH", ...fail(got.startedAt, got.durationMs, null, classifyFetchError(got.error)), gitSha: null };
  const httpStatus = got.res.status;
  if (httpStatus >= 500) {
    return { checkKey: "S1_API_HEALTH", ...fail(got.startedAt, got.durationMs, httpStatus, "HTTP_5XX"), gitSha: null };
  }
  if (httpStatus !== 200) {
    return { checkKey: "S1_API_HEALTH", ...fail(got.startedAt, got.durationMs, httpStatus, "UNEXPECTED_HTTP_STATUS"), gitSha: null };
  }
  let json;
  try {
    json = await got.res.json();
  } catch {
    return { checkKey: "S1_API_HEALTH", ...fail(got.startedAt, got.durationMs, httpStatus, "INVALID_RESPONSE"), gitSha: null };
  }
  const parsed = validateHealthJson(json, opts.requireProduction !== false);
  if (!parsed.ok) {
    return { checkKey: "S1_API_HEALTH", ...fail(got.startedAt, got.durationMs, httpStatus, parsed.code), gitSha: null };
  }
  if (opts.requireProduction !== false && parsed.nodeEnv && parsed.nodeEnv !== "production") {
    return { checkKey: "S1_API_HEALTH", ...fail(got.startedAt, got.durationMs, httpStatus, "CONTRACT_FAILURE"), gitSha: parsed.gitSha };
  }
  return { checkKey: "S1_API_HEALTH", ...pass(got.startedAt, got.durationMs, httpStatus), gitSha: parsed.gitSha };
}

export async function runS2WebRoot(fetchImpl, webBase, opts = {}) {
  const got = await timedFetch(fetchImpl, `${webBase}/`, { method: "GET" }, opts.timeoutMs);
  if (got.error) return { checkKey: "S2_WEB_ROOT", ...fail(got.startedAt, got.durationMs, null, classifyFetchError(got.error)) };
  const httpStatus = got.res.status;
  if (httpStatus >= 500) return { checkKey: "S2_WEB_ROOT", ...fail(got.startedAt, got.durationMs, httpStatus, "HTTP_5XX") };
  if (httpStatus !== 200) return { checkKey: "S2_WEB_ROOT", ...fail(got.startedAt, got.durationMs, httpStatus, "UNEXPECTED_HTTP_STATUS") };
  const text = await got.res.text().catch(() => "");
  if (!htmlLooksLikeIranPay(text)) {
    return { checkKey: "S2_WEB_ROOT", ...fail(got.startedAt, got.durationMs, httpStatus, "CONTRACT_FAILURE") };
  }
  return { checkKey: "S2_WEB_ROOT", ...pass(got.startedAt, got.durationMs, httpStatus) };
}

export async function runS3WebLogin(fetchImpl, webBase, opts = {}) {
  const got = await timedFetch(fetchImpl, `${webBase}/login`, { method: "GET" }, opts.timeoutMs);
  if (got.error) return { checkKey: "S3_WEB_LOGIN", ...fail(got.startedAt, got.durationMs, null, classifyFetchError(got.error)) };
  const httpStatus = got.res.status;
  if (httpStatus >= 500) return { checkKey: "S3_WEB_LOGIN", ...fail(got.startedAt, got.durationMs, httpStatus, "HTTP_5XX") };
  if (httpStatus !== 200) return { checkKey: "S3_WEB_LOGIN", ...fail(got.startedAt, got.durationMs, httpStatus, "UNEXPECTED_HTTP_STATUS") };
  const text = await got.res.text().catch(() => "");
  if (!htmlLooksLikeLogin(text)) {
    return { checkKey: "S3_WEB_LOGIN", ...fail(got.startedAt, got.durationMs, httpStatus, "CONTRACT_FAILURE") };
  }
  return { checkKey: "S3_WEB_LOGIN", ...pass(got.startedAt, got.durationMs, httpStatus) };
}

export async function runS4MarketMeta(fetchImpl, apiBase, opts = {}) {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const pairsGot = await timedFetch(fetchImpl, `${apiBase}/api/v1/market/pairs`, { method: "GET" }, opts.timeoutMs);
  if (pairsGot.error) {
    return { checkKey: "S4_MARKET_META", ...fail(pairsGot.startedAt, pairsGot.durationMs, null, classifyFetchError(pairsGot.error)) };
  }
  const currGot = await timedFetch(fetchImpl, `${apiBase}/api/v1/market/currencies`, { method: "GET" }, opts.timeoutMs);
  const durationMs = Date.now() - t0;
  if (currGot.error) {
    return { checkKey: "S4_MARKET_META", ...fail(startedAt, durationMs, null, classifyFetchError(currGot.error)) };
  }
  if (pairsGot.res.status >= 500 || currGot.res.status >= 500) {
    return { checkKey: "S4_MARKET_META", ...fail(startedAt, durationMs, pairsGot.res.status, "HTTP_5XX") };
  }
  if (pairsGot.res.status !== 200 || currGot.res.status !== 200) {
    return { checkKey: "S4_MARKET_META", ...fail(startedAt, durationMs, pairsGot.res.status, "UNEXPECTED_HTTP_STATUS") };
  }
  let pairs;
  let currencies;
  try {
    pairs = await pairsGot.res.json();
    currencies = await currGot.res.json();
  } catch {
    return { checkKey: "S4_MARKET_META", ...fail(startedAt, durationMs, 200, "INVALID_RESPONSE") };
  }
  const parsed = validateMarketPayload(pairs, currencies);
  if (!parsed.ok) return { checkKey: "S4_MARKET_META", ...fail(startedAt, durationMs, 200, parsed.code) };
  return { checkKey: "S4_MARKET_META", ...pass(startedAt, durationMs, 200) };
}

export async function runS6AuthBoundary(fetchImpl, apiBase, opts = {}) {
  const paths = ["/api/v1/me", "/api/v1/admin/monitoring", "/api/v1/exchange/orders"];
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  let lastStatus = null;
  for (const path of paths) {
    const got = await timedFetch(fetchImpl, `${apiBase}${path}`, { method: "GET" }, opts.timeoutMs);
    if (got.error) {
      return { checkKey: "S6_AUTH_BOUNDARY", ...fail(got.startedAt, got.durationMs, null, classifyFetchError(got.error)) };
    }
    lastStatus = got.res.status;
    const classified = classifyAuthBoundary(got.res.status);
    if (classified.status === "FAIL") {
      return {
        checkKey: "S6_AUTH_BOUNDARY",
        ...fail(startedAt, Date.now() - t0, got.res.status, classified.failureCode),
      };
    }
  }
  return { checkKey: "S6_AUTH_BOUNDARY", ...pass(startedAt, Date.now() - t0, lastStatus) };
}

export function evaluateS7Deploy(observedGitSha, expectedGitSha) {
  const startedAt = new Date().toISOString();
  if (!expectedGitSha) {
    return { checkKey: "S7_DEPLOY_SHA", startedAt, durationMs: 0, status: "PASS", httpStatus: null, failureCode: null };
  }
  if (!observedGitSha) {
    return {
      checkKey: "S7_DEPLOY_SHA",
      startedAt,
      durationMs: 0,
      status: "FAIL",
      httpStatus: null,
      failureCode: "DEPLOYMENT_MISMATCH",
    };
  }
  if (observedGitSha.slice(0, 40) !== expectedGitSha.slice(0, 40)) {
    return {
      checkKey: "S7_DEPLOY_SHA",
      startedAt,
      durationMs: 0,
      status: "FAIL",
      httpStatus: null,
      failureCode: "DEPLOYMENT_MISMATCH",
    };
  }
  return { checkKey: "S7_DEPLOY_SHA", startedAt, durationMs: 0, status: "PASS", httpStatus: null, failureCode: null };
}

export function publicCheckRow(row) {
  return {
    checkKey: row.checkKey,
    startedAt: row.startedAt,
    durationMs: row.durationMs,
    status: row.status,
    httpStatus: row.httpStatus,
    failureCode: row.failureCode,
  };
}

function apiWakeTimeoutMs(env, timeoutMs) {
  const override = Number(env?.SYNTHETIC_API_WAKE_TIMEOUT_MS || "");
  if (Number.isFinite(override) && override > 0) return override;
  return Math.max(Number(timeoutMs) || 0, API_WAKE_TIMEOUT_MS);
}

export async function runSyntheticChecks({ fetchImpl, env = process.env, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const apiBase = resolveApiBase(env);
  const webBase = resolveWebBase(env);
  const fetchFn = fetchImpl || fetch;
  const s1 = await runS1ApiHealth(fetchFn, apiBase, {
    timeoutMs: apiWakeTimeoutMs(env, timeoutMs),
    requireProduction: env.SYNTHETIC_REQUIRE_PRODUCTION !== "0",
  });
  const [s2, s3, s4, s6] = await Promise.all([
    runS2WebRoot(fetchFn, webBase, { timeoutMs }),
    runS3WebLogin(fetchFn, webBase, { timeoutMs }),
    runS4MarketMeta(fetchFn, apiBase, { timeoutMs }),
    runS6AuthBoundary(fetchFn, apiBase, { timeoutMs }),
  ]);
  const expected = String(env.SYNTHETIC_EXPECTED_GIT_SHA || "").trim() || null;
  const s7 = evaluateS7Deploy(s1.gitSha ?? null, expected);
  const checks = [s1, s2, s3, s4, s6, s7].map(publicCheckRow);
  const requiredFailed = checks.some(
    (c) => ["S1_API_HEALTH", "S2_WEB_ROOT", "S3_WEB_LOGIN", "S4_MARKET_META", "S6_AUTH_BOUNDARY"].includes(c.checkKey) && c.status === "FAIL",
  );
  return {
    apiBase,
    webBase,
    observedGitSha: s1.gitSha ?? null,
    expectedGitSha: expected,
    checks,
    requiredHealthy: !requiredFailed,
  };
}

export function buildIngestBody({ runId, runnerId, startedAt, expectedGitSha, checks }) {
  return {
    runId,
    runnerId,
    startedAt,
    expectedGitSha: expectedGitSha || null,
    checks: checks.map(publicCheckRow),
  };
}

export async function ingestSyntheticResults({ fetchImpl, env = process.env, body, timeoutMs = REQUEST_TIMEOUT_MS }) {
  const secret = String(env.SYNTHETIC_INGEST_SECRET || "").trim();
  if (!secret) throw new Error("SYNTHETIC_INGEST_SECRET missing");
  const apiBase = resolveApiBase(env);
  const rawBody = JSON.stringify(body);
  const timestamp = String(Date.now());
  const signature = collectorSignature(secret, timestamp, rawBody);
  const fetchFn = fetchImpl || fetch;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetchFn(`${apiBase}/api/v1/internal/ops/synthetic-results`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-iranpay-timestamp": timestamp,
        "x-iranpay-signature": signature,
      },
      body: rawBody,
      signal: ac.signal,
    });
    return { status: res.status, ok: res.status >= 200 && res.status < 300 };
  } catch {
    return { status: null, ok: false };
  } finally {
    clearTimeout(timer);
  }
}

export async function runAndMaybeIngest({ fetchImpl, env = process.env } = {}) {
  const startedAt = new Date().toISOString();
  const runId = String(env.SYNTHETIC_RUN_ID || randomUUID());
  const runnerId = String(env.SYNTHETIC_RUNNER_ID || (env.GITHUB_ACTIONS ? "github-actions" : "local"));
  const result = await runSyntheticChecks({ fetchImpl, env });
  const payload = buildIngestBody({
    runId,
    runnerId,
    startedAt,
    expectedGitSha: result.expectedGitSha,
    checks: result.checks,
  });
  const requireIngest = env.SYNTHETIC_REQUIRE_INGEST === "1" || !!env.GITHUB_ACTIONS;
  let ingest = { skipped: true, status: null, ok: true };
  if (requireIngest || env.SYNTHETIC_INGEST_SECRET) {
    if (!env.SYNTHETIC_INGEST_SECRET) {
      throw new Error("SYNTHETIC_INGEST_SECRET missing");
    }
    ingest = { skipped: false, ...(await ingestSyntheticResults({ fetchImpl, env, body: payload })) };
  }
  return { ...result, runId, runnerId, startedAt, ingest, payload };
}
