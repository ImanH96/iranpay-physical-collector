/**
 * Bonbast collector helpers. Keep hijack protection: HTTP 200 without
 * accepted>0 is not success (onrender HTML / {ok:true} must not ingest).
 *
 * Board acquisition is tiered and budgeted:
 *   Tier 1 (hedged): JSON relay + Telegram
 *   Tier 2: IranPay HTML relay
 *   Tier 3: bon-bast.com origin (last resort, short timeout)
 * Ingest: GET /health (read-only wake, hedged) then one sequential POST.
 * A timed-out POST is ambiguous — no failover POST of the same payload.
 */
import { createHmac } from "node:crypto";

export const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const PHYSICAL = ["usd", "eur", "aed", "cny"];

/** Board + wake + one POST must fit inside the 45s workflow tick. */
export const COLLECT_ONCE_BUDGET_MS = 38_000;
export const TIER1_BUDGET_MS = 8_000;
export const TIER1_PER_SOURCE_MS = 7_000;
export const TIER2_BUDGET_MS = 6_000;
export const TIER2_PER_SOURCE_MS = 5_000;
export const TIER3_BUDGET_MS = 4_000;
export const TIER3_PER_SOURCE_MS = 3_500;
/** Confirmed write window after the ingest host has answered /health. */
export const INGEST_POST_MS = 8_000;
export const INGEST_PER_BASE_MS = INGEST_POST_MS;
export const WAKE_PER_HOST_MS = 20_000;
export const MIN_ATTEMPT_BUDGET_MS = 12_000;
export const MAX_COLLECT_ATTEMPTS = 2;

export class CollectorError extends Error {
  constructor(code, details = {}) {
    super(formatCollectorError(code, details));
    this.name = "CollectorError";
    this.code = code;
    this.details = details;
  }
}

export function formatCollectorError(code, details = {}) {
  const parts = Object.entries(details)
    .filter(([k, v]) => v != null && v !== "" && k !== "url" && k !== "secret")
    .map(([k, v]) => `${k}=${v}`);
  return parts.length ? `${code} ${parts.join(" ")}` : code;
}

export function isTimeoutError(err) {
  if (!err) return false;
  const name = err.name || "";
  const msg = String(err.message || err);
  return name === "TimeoutError" || name === "AbortError" || /aborted due to timeout/i.test(msg);
}

export function classifyBoardUrl(url) {
  const u = String(url);
  if (/bonbast-json/i.test(u)) return "json_relay";
  if (/t\.me\/s\/bonbast/i.test(u)) return "telegram";
  if (/bonbast-board/i.test(u)) return "html_relay";
  if (/bon-bast\.com/i.test(u)) return "origin";
  return "unknown_board";
}

export function classifyApiBase(url, env = process.env) {
  const u = String(url).replace(/\/$/, "");
  if (/iran-pay\.vercel\.app/i.test(u)) return "vercel_api";
  if (/onrender\.com/i.test(u)) return "render_api";
  const configured = String(env.IRANPAY_API_BASE || "").replace(/\/$/, "");
  if (configured && u === configured) return "configured_api";
  return "unknown_api";
}

export function remainingMs(deadlineMs, nowMs = Date.now()) {
  return Math.max(0, deadlineMs - nowMs);
}

function abortAfter(ms) {
  if (ms <= 0) {
    const c = new AbortController();
    c.abort();
    return c.signal;
  }
  return AbortSignal.timeout(ms);
}

export function uniqTrim(urls) {
  return urls
    .filter(Boolean)
    .map((s) => String(s).replace(/\/$/, ""))
    .filter((s, i, all) => all.indexOf(s) === i);
}

export function boardUrls(env = process.env) {
  return uniqTrim([
    env.BONBAST_JSON_RELAY_URL || "https://iran-pay.vercel.app/api/physical/bonbast-json",
    "https://t.me/s/bonbast",
    env.BONBAST_RELAY_URL || "https://iran-pay.vercel.app/api/physical/bonbast-board",
    env.BONBAST_PUBLIC_URL || "https://www.bon-bast.com/",
  ]);
}

export function apiBases(env = process.env) {
  return uniqTrim([
    "https://iran-pay.vercel.app/api/v1",
    env.IRANPAY_API_BASE,
    "https://iranpay-api.onrender.com/api/v1",
  ]);
}

export function extractTelegramBook(html) {
  if (!html || !html.includes("دلار آمریکا")) return null;
  const parts = html.split(/tgme_widget_message/);
  let best = null;
  for (let i = 0; i < parts.length; i++) {
    const part = `${parts[i - 1] ?? ""}${parts[i]}`;
    if (!/دلار آمریکا/.test(part) || !/درهم امارات/.test(part) || !/یوان چین/.test(part)) continue;
    const out = {};
    const grab = (label, code) => {
      const m = part.match(
        new RegExp(
          `${label}[\\s\\S]{0,500}?خرید:[\\s\\S]{0,120}?([\\d,]{3,})[\\s\\S]{0,80}?تومان[\\s\\S]{0,200}?فروش:[\\s\\S]{0,120}?([\\d,]{3,})`,
        ),
      );
      if (!m) return;
      out[`${code}2`] = m[1].replace(/,/g, "");
      out[`${code}1`] = m[2].replace(/,/g, "");
    };
    grab("دلار آمریکا", "usd");
    grab("یورو", "eur");
    grab("درهم امارات", "aed");
    grab("یوان چین", "cny");
    const time = part.match(/datetime="([^"]+)"/);
    if (time) {
      const ms = Date.parse(time[1]);
      if (Number.isFinite(ms)) out.last_update = new Date(ms).toISOString();
    }
    if (out.usd1 || out.usd2) best = out;
  }
  return best;
}

export function extractJsonBook(text) {
  if (!text || typeof text !== "string") return null;
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const data = JSON.parse(trimmed);
    const book = data && typeof data === "object" && data.book && typeof data.book === "object" ? data.book : data;
    if (!book || typeof book !== "object") return null;
    if (book.usd1 || book.usd2 || book.eur1 || book.aed1 || book.cny1) {
      if (!book._acquisition) book._acquisition = data.acquisition || "json_relay";
      if (!book.last_update && (data.observedAt || data.receivedAt)) {
        book.last_update = data.observedAt || data.receivedAt;
      }
      return book;
    }
  } catch {
    /* not JSON */
  }
  return null;
}

export function extractBook(html) {
  const json = extractJsonBook(html);
  if (json) return json;
  if (!html || html.length < 80) return null;
  const out = {};
  const last =
    html.match(/Last Update:\s*<\/span>\s*<span[^>]*>\s*([^<]+?)\s*<\/span>/i) ||
    html.match(/Last Update:\s*([A-Za-z]+ \d{1,2}, \d{4} \d{1,2}:\d{2}(?:\s*UTC)?)/i);
  if (last) {
    const raw = last[1].replace(/\s+/g, " ").trim();
    const ms = Date.parse(raw.endsWith("UTC") ? raw : `${raw} UTC`);
    out.last_update = Number.isFinite(ms) ? new Date(ms).toISOString() : raw;
  }
  for (const code of PHYSICAL) {
    const chunk = html.split(new RegExp(`/chart/${code}"`, "i"))[1]?.slice(0, 3000) ?? "";
    const nums = [...chunk.matchAll(/<span>\s*([\d,]{3,})\s*<\/span>/g)].map((m) => m[1].replace(/,/g, ""));
    if (nums[0]) out[`${code}1`] = nums[0];
    if (nums[1]) out[`${code}2`] = nums[1];
  }
  const sym = html.match(/window\.SYMBOLS_DATA\s*=\s*(\{[\s\S]*?\})/);
  if (sym) {
    try {
      const data = JSON.parse(sym[1]);
      for (const code of PHYSICAL) {
        if (!out[`${code}1`] && data[code] != null) out[`${code}1`] = String(data[code]).replace(/,/g, "");
      }
    } catch {
      /* ignore */
    }
  }
  if (PHYSICAL.some((c) => out[`${c}1`] || out[`${c}2`])) return out;
  return extractTelegramBook(html);
}

export function physicalCurrenciesOnly(book) {
  if (!book || typeof book !== "object") return [];
  return PHYSICAL.filter((c) => book[`${c}1`] || book[`${c}2`]).map((c) => c.toUpperCase());
}

export function bookHasUsdt(book) {
  if (!book || typeof book !== "object") return false;
  return Object.keys(book).some((k) => /^usdt/i.test(k));
}

export function isValidPhysicalBook(book) {
  if (!book || typeof book !== "object") return false;
  return PHYSICAL.some((c) => {
    const sell = String(book[`${c}1`] ?? "");
    const buy = String(book[`${c}2`] ?? "");
    return /^\d{3,}$/.test(sell) || /^\d{3,}$/.test(buy);
  });
}

export function classifyIngestResponse(status, json, text) {
  const ok = status >= 200 && status < 300;
  const accepted = json != null ? Number(json.accepted) : NaN;
  if (ok && Number.isFinite(accepted) && accepted > 0) {
    return { kind: "success", accepted };
  }
  if (ok) {
    return {
      kind: "hijacked_or_invalid",
      accepted: Number.isFinite(accepted) ? accepted : 0,
      snippet: String(text ?? "").slice(0, 180),
    };
  }
  if (status === 401 || status === 403) {
    return { kind: "auth_failure", status, snippet: String(text ?? "").slice(0, 180) };
  }
  return { kind: "api_failure", status, snippet: String(text ?? "").slice(0, 180) };
}

export function collectorProcessExitCode(okCount) {
  return okCount > 0 ? 0 : 1;
}

export function signCollectorPayload(secret, timestamp, payload) {
  return createHmac("sha256", secret).update(`${timestamp}.${payload}`).digest("hex");
}

async function fetchOneBoard(fetchImpl, board, { ua, timeoutMs, signal }) {
  const source = classifyBoardUrl(board);
  const started = Date.now();
  const join = board.includes("?") ? "&" : "?";
  const jsonish = source === "json_relay";
  const signals = [abortAfter(timeoutMs)];
  if (signal) signals.push(signal);
  const combined = signals.length === 1 ? signals[0] : AbortSignal.any(signals);
  try {
    const res = await fetchImpl(`${board}${join}_=${Date.now()}`, {
      cache: "no-store",
      signal: combined,
      headers: {
        Accept: jsonish ? "application/json, text/html;q=0.8" : "text/html",
        "Accept-Language": "en-US,en;q=0.9",
        "User-Agent": ua,
      },
    });
    const elapsedMs = Date.now() - started;
    if (!res.ok) {
      return {
        book: null,
        board,
        source,
        elapsedMs,
        error: new CollectorError("BOARD_HTTP", { source, status: res.status, elapsedMs }),
      };
    }
    const html = await res.text();
    const book = extractBook(html);
    if (book && isValidPhysicalBook(book)) {
      return { book, board, source, elapsedMs, error: null };
    }
    return {
      book: null,
      board,
      source,
      elapsedMs,
      error: new CollectorError("BOARD_EMPTY", { source, elapsedMs }),
    };
  } catch (e) {
    const elapsedMs = Date.now() - started;
    if (isTimeoutError(e)) {
      return {
        book: null,
        board,
        source,
        elapsedMs,
        error: new CollectorError("BOARD_TIMEOUT", { source, elapsedMs }),
      };
    }
    return {
      book: null,
      board,
      source,
      elapsedMs,
      error: new CollectorError("BOARD_ERROR", { source, elapsedMs, reason: e.message || String(e) }),
    };
  }
}

function boardsForTier(boards, names) {
  return boards.filter((b) => names.includes(classifyBoardUrl(b)));
}

async function raceTier(fetchImpl, boards, { ua, perSourceMs, budgetMs, deadlineMs }) {
  const cancel = new AbortController();
  const tierCap = Math.min(perSourceMs, budgetMs, remainingMs(deadlineMs));
  if (tierCap < 200 || boards.length === 0) {
    return { book: null, errors: [] };
  }
  const started = Date.now();
  const tasks = boards.map((board) =>
    fetchOneBoard(fetchImpl, board, { ua, timeoutMs: tierCap, signal: cancel.signal }).then((hit) => {
      if (hit.book) cancel.abort();
      return hit;
    }),
  );
  const hits = await Promise.all(tasks);
  const winner = hits.find((h) => h.book);
  if (winner) return { ...winner, errors: hits.filter((h) => h.error).map((h) => h.error) };
  return {
    book: null,
    errors: hits.map((h) => h.error).filter(Boolean),
    elapsedMs: Date.now() - started,
  };
}

export async function fetchBoardBook(
  fetchImpl,
  boards,
  { ua = DEFAULT_UA, timeoutMs, deadlineMs = Date.now() + COLLECT_ONCE_BUDGET_MS, onEvent } = {},
) {
  const emit = (msg) => {
    if (typeof onEvent === "function") onEvent(msg);
    else console.log(msg);
  };
  const errors = [];
  const tryTier = async (label, urls, hedge, perSourceMs, budgetMs) => {
    if (!urls.length) return null;
    if (remainingMs(deadlineMs) < 200) return null;
    if (hedge && urls.length > 1) {
      const raced = await raceTier(fetchImpl, urls, { ua, perSourceMs, budgetMs, deadlineMs });
      errors.push(...(raced.errors || []));
      if (raced.book) {
        emit(`bonbast board ok source=${raced.source} elapsedMs=${raced.elapsedMs}`);
        return raced;
      }
      for (const err of raced.errors || []) emit(`source=${err.details?.source} failed reason=${err.code}`);
      return null;
    }
    for (const board of urls) {
      if (remainingMs(deadlineMs) < 200) break;
      const hit = await fetchOneBoard(fetchImpl, board, {
        ua,
        timeoutMs: Math.min(perSourceMs, timeoutMs || perSourceMs, remainingMs(deadlineMs)),
      });
      if (hit.error) {
        errors.push(hit.error);
        emit(`source=${hit.source} failed reason=${hit.error.code}`);
      }
      if (hit.book) {
        emit(`bonbast board ok source=${hit.source} elapsedMs=${hit.elapsedMs}`);
        return hit;
      }
    }
    return null;
  };

  const hit =
    (await tryTier("tier1", boardsForTier(boards, ["json_relay", "telegram"]), true, TIER1_PER_SOURCE_MS, TIER1_BUDGET_MS)) ||
    (await tryTier("tier2", boardsForTier(boards, ["html_relay"]), false, TIER2_PER_SOURCE_MS, TIER2_BUDGET_MS)) ||
    (await tryTier("tier3", boardsForTier(boards, ["origin"]), false, TIER3_PER_SOURCE_MS, TIER3_BUDGET_MS));

  if (hit?.book) return hit;
  const first = errors[0];
  return {
    book: null,
    board: null,
    source: null,
    lastBoardErr: first ? first.message : formatCollectorError("BOARD_EMPTY", { source: "all" }),
    errors,
  };
}

function preferRenderFirst(bases, env) {
  const unique = uniqTrim(bases);
  return [
    ...unique.filter((b) => classifyApiBase(b, env) === "render_api"),
    ...unique.filter((b) => classifyApiBase(b, env) !== "render_api"),
  ];
}

export async function wakeIngestHost(
  fetchImpl,
  bases,
  { deadlineMs = Date.now() + WAKE_PER_HOST_MS, timeoutMs = WAKE_PER_HOST_MS, onEvent, env = process.env } = {},
) {
  const emit = (msg) => {
    if (typeof onEvent === "function") onEvent(msg);
    else console.log(msg);
  };
  const ordered = preferRenderFirst(bases, env);
  if (!ordered.length) throw new CollectorError("INGEST_UNAVAILABLE", { reason: "no_base" });
  const budget = Math.min(timeoutMs, remainingMs(deadlineMs));
  if (budget < 200) throw new CollectorError("INGEST_UNAVAILABLE", { reason: "deadline" });

  const cancel = new AbortController();
  const tasks = ordered.map(async (base) => {
    const name = classifyApiBase(base, env);
    const started = Date.now();
    try {
      const res = await fetchImpl(`${base}/health?_=${Date.now()}`, {
        method: "GET",
        cache: "no-store",
        signal: AbortSignal.any([abortAfter(budget), cancel.signal]),
        headers: { Accept: "application/json" },
      });
      const elapsedMs = Date.now() - started;
      if (!res.ok) {
        return {
          ok: false,
          error: new CollectorError("INGEST_WAKE_HTTP", { base: name, status: res.status, elapsedMs }),
        };
      }
      const text = await res.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      if (json && typeof json === "object" && json.ok === false) {
        return {
          ok: false,
          error: new CollectorError("INGEST_WAKE_HTTP", { base: name, status: res.status, elapsedMs }),
        };
      }
      if (text && /<html/i.test(text) && !text.trim().startsWith("{")) {
        return {
          ok: false,
          error: new CollectorError("INGEST_WAKE_HTTP", { base: name, status: res.status, elapsedMs, kind: "hijacked_or_invalid" }),
        };
      }
      return { ok: true, base, baseName: name, elapsedMs, error: null };
    } catch (e) {
      const elapsedMs = Date.now() - started;
      if (cancel.signal.aborted && !/timeout/i.test(String(e.message || e))) {
        return { ok: false, error: null };
      }
      if (isTimeoutError(e)) {
        return { ok: false, error: new CollectorError("INGEST_WAKE_TIMEOUT", { base: name, elapsedMs }) };
      }
      return {
        ok: false,
        error: new CollectorError("INGEST_WAKE_ERROR", { base: name, elapsedMs, reason: e.message || String(e) }),
      };
    }
  });

  const hits = await Promise.all(
    tasks.map((p) =>
      p.then((hit) => {
        if (hit.ok) cancel.abort();
        return hit;
      }),
    ),
  );
  const winner = hits.find((h) => h.ok);
  if (winner) {
    emit(`bonbast ingest wake ok base=${winner.baseName} elapsedMs=${winner.elapsedMs}`);
    return winner;
  }
  const firstErr = hits.map((h) => h.error).find(Boolean);
  throw firstErr || new CollectorError("INGEST_UNAVAILABLE", { reason: "wake_failed" });
}

export async function ingestBook(
  fetchImpl,
  bases,
  { secret, book, timeoutMs = INGEST_PER_BASE_MS, nowMs = Date.now(), deadlineMs, env = process.env },
) {
  const fetchedAt = new Date(nowMs).toISOString();
  const payload = JSON.stringify({ provider: "BONBAST", fetchedAt, book });
  const timestamp = String(nowMs);
  const signature = signCollectorPayload(secret, timestamp, payload);
  let lastErr = formatCollectorError("INGEST_NO_BASE", {});
  for (const base of bases) {
    const name = classifyApiBase(base, env);
    const started = Date.now();
    const budget = deadlineMs != null ? remainingMs(deadlineMs) : timeoutMs;
    const wait = Math.min(timeoutMs, budget);
    if (wait < 50) {
      throw new CollectorError("INGEST_TIMEOUT", { base: name, elapsedMs: 0, reason: "deadline" });
    }
    try {
      const ingest = await fetchImpl(`${base}/internal/physical/cash-observations`, {
        method: "POST",
        signal: abortAfter(wait),
        headers: {
          "Content-Type": "application/json",
          "X-IranPay-Timestamp": timestamp,
          "X-IranPay-Signature": signature,
        },
        body: payload,
      });
      const elapsedMs = Date.now() - started;
      const text = await ingest.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      const classified = classifyIngestResponse(ingest.status, json, text);
      if (classified.kind === "success") {
        return { ok: true, base, baseName: name, classified, fetchedAt, book, lastErr: null, elapsedMs };
      }
      if (classified.kind === "auth_failure") {
        throw new CollectorError("INGEST_AUTH_FAILURE", { base: name, status: classified.status, elapsedMs });
      }
      lastErr = formatCollectorError("INGEST_HTTP", {
        base: name,
        status: ingest.status,
        elapsedMs,
        kind: classified.kind,
      });
      // Clear HTTP/hijack on this host: try the next sequential base only.
    } catch (e) {
      const elapsedMs = Date.now() - started;
      if (e instanceof CollectorError) throw e;
      if (isTimeoutError(e)) {
        // Request may have been processed. Do not POST the same observation again.
        throw new CollectorError("INGEST_TIMEOUT", { base: name, elapsedMs });
      }
      lastErr = formatCollectorError("INGEST_ERROR", { base: name, elapsedMs, reason: e.message || String(e) });
    }
  }
  return { ok: false, base: null, classified: null, fetchedAt, book, lastErr };
}

export async function collectOnce({
  fetchImpl,
  env = process.env,
  nowMs = Date.now(),
  deadlineMs,
  onEvent,
} = {}) {
  const secret = String(env.PHYSICAL_COLLECTOR_SECRET || "").trim();
  if (!secret) throw new Error("PHYSICAL_COLLECTOR_SECRET missing");
  const fetchFn = fetchImpl || fetch;
  const boards = boardUrls(env);
  const bases = apiBases(env);
  const hardDeadline = deadlineMs ?? nowMs + COLLECT_ONCE_BUDGET_MS;
  const fetched = await fetchBoardBook(fetchFn, boards, { deadlineMs: hardDeadline, onEvent });
  if (!fetched.book) throw new Error(fetched.lastBoardErr);
  const emit = (msg) => {
    if (typeof onEvent === "function") onEvent(msg);
    else console.log(msg);
  };
  let ingestBases = bases;
  const rem = remainingMs(hardDeadline);
  const postWait = Math.min(INGEST_POST_MS, Math.max(0, rem - 250));
  const wakeWait = Math.max(0, rem - postWait - 250);
  if (wakeWait >= 400) {
    const woke = await wakeIngestHost(fetchFn, bases, {
      deadlineMs: Date.now() + wakeWait,
      timeoutMs: wakeWait,
      onEvent,
      env,
    });
    ingestBases = uniqTrim([woke.base, ...bases]);
  }
  emit(`bonbast ingest start base=${classifyApiBase(ingestBases[0], env)} timeoutMs=${postWait}`);
  const ingested = await ingestBook(fetchFn, ingestBases, {
    secret,
    book: fetched.book,
    nowMs,
    timeoutMs: postWait,
    deadlineMs: hardDeadline,
    env,
  });
  if (!ingested.ok) throw new Error(ingested.lastErr);
  emit(`bonbast ingest ok base=${ingested.baseName} accepted=${ingested.classified.accepted} elapsedMs=${ingested.elapsedMs}`);
  return {
    fetchedAt: ingested.fetchedAt,
    base: ingested.base,
    baseName: ingested.baseName,
    board: fetched.board,
    source: fetched.source,
    book: fetched.book,
    accepted: ingested.classified.accepted,
  };
}

export async function runCollectorLoop({
  collect = collectOnce,
  now = () => Date.now(),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  durationMs,
  intervalMs,
  maxAttempts = MAX_COLLECT_ATTEMPTS,
  minAttemptBudgetMs = MIN_ATTEMPT_BUDGET_MS,
  collectOnceBudgetMs = COLLECT_ONCE_BUDGET_MS,
  log = console,
} = {}) {
  const started = now();
  let okCount = 0;
  let lastError = null;
  let attempts = 0;
  let lastResult = null;
  while (true) {
    const remaining = durationMs - (now() - started);
    if (okCount > 0) break;
    if (attempts >= maxAttempts) break;
    const need = attempts === 0 ? minAttemptBudgetMs : collectOnceBudgetMs;
    if (remaining < need) break;
    attempts += 1;
    const deadlineMs = now() + Math.min(collectOnceBudgetMs, Math.max(0, remaining - 250));
    try {
      lastResult = await collect({ deadlineMs });
      okCount += 1;
      lastError = null;
      log.log(
        `bonbast ingest ok ${lastResult.fetchedAt} via=${lastResult.baseName ?? lastResult.base} source=${lastResult.source ?? "?"} last=${lastResult.book?.last_update ?? "?"} usd=${lastResult.book?.usd1}/${lastResult.book?.usd2} accepted=${lastResult.accepted}`,
      );
      break;
    } catch (e) {
      lastError = e;
      log.error(`bonbast tick failed: ${e.message}`);
    }
    const rem = durationMs - (now() - started);
    if (okCount > 0 || rem < minAttemptBudgetMs || attempts >= maxAttempts) break;
    await sleep(Math.min(intervalMs, Math.max(0, rem - minAttemptBudgetMs)));
  }
  return { okCount, lastError, attempts, lastResult };
}
