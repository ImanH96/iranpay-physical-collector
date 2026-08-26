import { test } from "node:test";
import assert from "node:assert/strict";
import {
  apiBases,
  boardUrls,
  classifyIngestResponse,
  collectOnce,
  collectorProcessExitCode,
  extractBook,
  extractJsonBook,
  extractTelegramBook,
  physicalCurrenciesOnly,
} from "./bonbast-collector.lib.mjs";

const BOARD_HTML = `
<html><body>
<p><span class="text-gray-500">Last Update: </span><span class="text-indigo-600 font-bold">August 23, 2026 09:57 UTC</span></p>
<a href="/chart/usd">USD</a><span>199,200</span><span>199,300</span>
<a href="/chart/eur">EUR</a><span>232,820</span><span>233,000</span>
<a href="/chart/aed">AED</a><span>54,620</span><span>54,700</span>
<a href="/chart/cny">CNY</a><span>29,640</span><span>29,700</span>
<script>window.SYMBOLS_DATA = {"usd":"199200","eur":"232820","aed":"54620","cny":"29640","usdt":"999999"}</script>
</body></html>
`;

const TELEGRAM_HTML = `
<div class="tgme_widget_message">
<span datetime="2026-08-23T09:00:00+00:00"></span>
دلار آمریکا
خرید: 199,100 تومان
فروش: 199,200
یورو
خرید: 232,700 تومان
فروش: 232,820
درهم امارات
خرید: 54,600 تومان
فروش: 54,620
یوان چین
خرید: 29,600 تومان
فروش: 29,640
</div>
`;

test("parser reads USD/EUR/AED/CNY and ignores USDT symbols", () => {
  const book = extractBook(BOARD_HTML);
  assert.ok(book);
  assert.equal(book.usd1, "199200");
  assert.equal(book.usd2, "199300");
  assert.equal(book.eur1, "232820");
  assert.equal(book.aed1, "54620");
  assert.equal(book.cny1, "29640");
  assert.deepEqual(physicalCurrenciesOnly(book), ["USD", "EUR", "AED", "CNY"]);
  assert.equal(book.usdt1, undefined);
});

test("board order prefers JSON relay and Telegram before blocked origin", () => {
  const boards = boardUrls({});
  assert.ok(boards[0].includes("/api/physical/bonbast-json"));
  assert.equal(boards[1], "https://t.me/s/bonbast");
  assert.ok(boards[2].includes("/api/physical/bonbast-board"));
  assert.equal(boards[3], "https://www.bon-bast.com");
});

test("JSON relay book is accepted without HTML", () => {
  const book = extractJsonBook(
    JSON.stringify({
      ok: true,
      source: "BONBAST",
      acquisition: "json_handshake",
      book: { usd1: "199000", usd2: "198900", eur1: "232200", aed1: "53800", cny1: "29600" },
    }),
  );
  assert.equal(book.usd1, "199000");
  assert.equal(book._acquisition, "json_handshake");
});

test("ingest SUCCESS requires accepted>0", () => {
  assert.equal(classifyIngestResponse(200, { accepted: 4 }, '{"accepted":4}').kind, "success");
});

test("process exits 1 when no successful ingest", () => {
  assert.equal(collectorProcessExitCode(0), 1);
  assert.equal(collectorProcessExitCode(1), 0);
});

test("collectOnce accepts the JSON relay book", async () => {
  const r = await collectOnce({
    env: { PHYSICAL_COLLECTOR_SECRET: "x".repeat(32) },
    fetchImpl: async (url, init) => {
      if (init?.method === "POST") return { ok: true, status: 200, text: async () => JSON.stringify({ accepted: 4 }) };
      if (String(url).includes("bonbast-json")) {
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              ok: true,
              book: { usd1: "199000", usd2: "198900", eur1: "232200", aed1: "53800", cny1: "29600" },
            }),
        };
      }
      return { ok: false, status: 403, text: async () => "blocked" };
    },
  });
  assert.equal(r.accepted, 4);
  assert.ok(String(r.board).includes("bonbast-json"));
});

test("API bases prefer Vercel proxy before Render DNS", () => {
  const bases = apiBases({ IRANPAY_API_BASE: "https://custom.example/api/v1" });
  assert.equal(bases[0], "https://iran-pay.vercel.app/api/v1");
});

test("parser falls back to Telegram HTML", () => {
  const book = extractTelegramBook(TELEGRAM_HTML);
  assert.ok(book);
  assert.equal(book.usd1, "199200");
});
