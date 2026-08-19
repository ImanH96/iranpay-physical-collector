/**
 * Persistent Bonbast collector for GitHub-hosted runners.
 * Fetches the public cash board and HMAC-posts it to IranPay.
 */
import { createHmac } from "node:crypto";

const BOARD = process.env.BONBAST_PUBLIC_URL || "https://www.bon-bast.com/";
const API_BASES = [
  process.env.IRANPAY_API_BASE,
  "https://iranpay-api.onrender.com/api/v1",
  "https://iran-pay.vercel.app/api/v1",
]
  .filter(Boolean)
  .map((s) => String(s).replace(/\/$/, ""))
  .filter((s, i, all) => all.indexOf(s) === i);
const SECRET = (process.env.PHYSICAL_COLLECTOR_SECRET || "").trim();
const INTERVAL_MS = Number(process.env.COLLECTOR_INTERVAL_MS || 30_000);
const DURATION_MS = Number(process.env.COLLECTOR_DURATION_MS || 18_600_000);
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

function extractBook(html) {
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
  for (const code of ["usd", "eur", "aed", "cny"]) {
    const chunk = html.split(new RegExp(`/chart/${code}"`, "i"))[1]?.slice(0, 3000) ?? "";
    const nums = [...chunk.matchAll(/<span>\s*([\d,]{3,})\s*<\/span>/g)].map((m) => m[1].replace(/,/g, ""));
    if (nums[0]) out[`${code}1`] = nums[0];
    if (nums[1]) out[`${code}2`] = nums[1];
  }
  const sym = html.match(/window\.SYMBOLS_DATA\s*=\s*(\{[\s\S]*?\})/);
  if (sym) {
    try {
      const data = JSON.parse(sym[1]);
      for (const code of ["usd", "eur", "aed", "cny"]) {
        if (!out[`${code}1`] && data[code] != null) out[`${code}1`] = String(data[code]).replace(/,/g, "");
      }
    } catch {
      /* ignore */
    }
  }
  return ["usd", "eur", "aed", "cny"].some((c) => out[`${c}1`] || out[`${c}2`]) ? out : null;
}

async function tick() {
  if (!SECRET) throw new Error("PHYSICAL_COLLECTOR_SECRET missing");
  const res = await fetch(`${BOARD}?_=${Date.now()}`, {
    cache: "no-store",
    headers: { Accept: "text/html", "Accept-Language": "en-US,en;q=0.9", "User-Agent": UA },
  });
  if (!res.ok) throw new Error(`BOARD_HTTP_${res.status}`);
  const html = await res.text();
  const book = extractBook(html);
  if (!book) throw new Error("BOARD_EMPTY");
  const fetchedAt = new Date().toISOString();
  const payload = JSON.stringify({ provider: "BONBAST", fetchedAt, book });
  const timestamp = String(Date.now());
  const signature = createHmac("sha256", SECRET).update(`${timestamp}.${payload}`).digest("hex");
  let lastErr = "NO_API_BASE";
  for (const base of API_BASES) {
    try {
      const ingest = await fetch(`${base}/internal/physical/cash-observations`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-IranPay-Timestamp": timestamp,
          "X-IranPay-Signature": signature,
        },
        body: payload,
      });
      const text = await ingest.text();
      if (!ingest.ok) {
        lastErr = `INGEST_HTTP_${ingest.status}:${text.slice(0, 180)}`;
        continue;
      }
      console.log(`bonbast ingest ok ${fetchedAt} last=${book.last_update ?? "?"} usd=${book.usd1}/${book.usd2}`);
      return;
    } catch (e) {
      lastErr = e.message || String(e);
    }
  }
  throw new Error(lastErr);
}

const started = Date.now();
let stop = false;
process.on("SIGTERM", () => {
  stop = true;
});
process.on("SIGINT", () => {
  stop = true;
});

while (!stop && Date.now() - started < DURATION_MS) {
  try {
    await tick();
  } catch (e) {
    console.error(`bonbast tick failed: ${e.message}`);
  }
  if (stop || Date.now() - started >= DURATION_MS) break;
  await new Promise((r) => setTimeout(r, INTERVAL_MS));
}
