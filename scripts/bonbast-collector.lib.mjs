/**
 * Bonbast collector helpers. Keep hijack protection: HTTP 200 without
 * accepted>0 is not success (onrender HTML / {ok:true} must not ingest).
 */
import { createHmac } from "node:crypto";

export const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const PHYSICAL = ["usd", "eur", "aed", "cny"];

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

async function fetchOneBoard(fetchImpl, board, { ua, timeoutMs }) {
  const join = board.includes("?") ? "&" : "?";
  const jsonish = /bonbast-json|application\/json/.test(board);
  const res = await fetchImpl(`${board}${join}_=${Date.now()}`, {
    cache: "no-store",
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      Accept: jsonish ? "application/json, text/html;q=0.8" : "text/html",
      "Accept-Language": "en-US,en;q=0.9",
      "User-Agent": ua,
    },
  });
  if (!res.ok) return { book: null, board, lastBoardErr: `BOARD_HTTP_${res.status}` };
  const html = await res.text();
  const book = extractBook(html);
  if (book) return { book, board, lastBoardErr: null };
  return { book: null, board, lastBoardErr: "BOARD_EMPTY" };
}

export async function fetchBoardBook(fetchImpl, boards, { ua = DEFAULT_UA, timeoutMs = 12_000 } = {}) {
  const errs = [];
  for (const board of boards) {
    try {
      const hit = await fetchOneBoard(fetchImpl, board, { ua, timeoutMs });
      if (hit.book) return hit;
      if (hit.lastBoardErr) errs.push(hit.lastBoardErr);
    } catch (e) {
      errs.push(e.message || String(e));
    }
  }
  return { book: null, board: null, lastBoardErr: errs[0] || "BOARD_EMPTY" };
}

export async function ingestBook(fetchImpl, bases, { secret, book, timeoutMs = 12_000, nowMs = Date.now() }) {
  const fetchedAt = new Date(nowMs).toISOString();
  const payload = JSON.stringify({ provider: "BONBAST", fetchedAt, book });
  const timestamp = String(nowMs);
  const signature = signCollectorPayload(secret, timestamp, payload);
  let lastErr = "NO_API_BASE";
  for (const base of bases) {
    try {
      const ingest = await fetchImpl(`${base}/internal/physical/cash-observations`, {
        method: "POST",
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          "Content-Type": "application/json",
          "X-IranPay-Timestamp": timestamp,
          "X-IranPay-Signature": signature,
        },
        body: payload,
      });
      const text = await ingest.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      const classified = classifyIngestResponse(ingest.status, json, text);
      if (classified.kind === "success") {
        return { ok: true, base, classified, fetchedAt, book, lastErr: null };
      }
      lastErr = `INGEST_HTTP_${ingest.status}:${text.slice(0, 180)}`;
    } catch (e) {
      lastErr = e.message || String(e);
    }
  }
  return { ok: false, base: null, classified: null, fetchedAt, book, lastErr };
}

export async function collectOnce({ fetchImpl, env = process.env, nowMs = Date.now() } = {}) {
  const secret = String(env.PHYSICAL_COLLECTOR_SECRET || "").trim();
  if (!secret) throw new Error("PHYSICAL_COLLECTOR_SECRET missing");
  const fetchFn = fetchImpl || fetch;
  const boards = boardUrls(env);
  const bases = apiBases(env);
  const fetched = await fetchBoardBook(fetchFn, boards);
  if (!fetched.book) throw new Error(fetched.lastBoardErr);
  const ingested = await ingestBook(fetchFn, bases, { secret, book: fetched.book, nowMs });
  if (!ingested.ok) throw new Error(ingested.lastErr);
  return {
    fetchedAt: ingested.fetchedAt,
    base: ingested.base,
    board: fetched.board,
    book: fetched.book,
    accepted: ingested.classified.accepted,
  };
}
