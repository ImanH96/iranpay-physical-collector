import { test } from "node:test";
import assert from "node:assert/strict";
import {
  apiBases,
  boardUrls,
  classifyApiBase,
  classifyBoardUrl,
  classifyIngestResponse,
  collectOnce,
  collectorProcessExitCode,
  CollectorError,
  extractBook,
  extractJsonBook,
  extractTelegramBook,
  fetchBoardBook,
  formatCollectorError,
  ingestBook,
  isValidPhysicalBook,
  physicalCurrenciesOnly,
  remainingMs,
  runCollectorLoop,
  COLLECT_ONCE_BUDGET_MS,
  MIN_ATTEMPT_BUDGET_MS,
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

const JSON_RELAY_BODY = JSON.stringify({
  ok: true,
  source: "BONBAST",
  acquisition: "json_handshake",
  health: "up",
  book: {
    _acquisition: "json_handshake",
    usd1: "199000",
    usd2: "198900",
    eur1: "232200",
    aed1: "53800",
    cny1: "29600",
    last_update: "2026-08-23T09:00:00.000Z",
  },
  currencies: ["USD", "EUR", "AED", "CNY"],
  missing: [],
  observedAt: "2026-08-23T09:00:00.000Z",
});

const SECRET = "x".repeat(32);

function hangingFetch(signal, hangMs = 60_000) {
  return new Promise((_, reject) => {
    const timer = setTimeout(() => {
      reject(Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }));
    }, hangMs);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }));
    });
  });
}

function jsonRelayOk() {
  return { ok: true, status: 200, text: async () => JSON_RELAY_BODY };
}
function telegramOk() {
  return { ok: true, status: 200, text: async () => TELEGRAM_HTML };
}
function htmlRelayOk() {
  return { ok: true, status: 200, text: async () => BOARD_HTML };
}
function ingestOk(accepted = 4) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ accepted: typeof accepted === "number" ? accepted : 4 }),
  };
}

function boardFetch(map, { ingest = ingestOk } = {}) {
  return async (url, init) => {
    if (init?.method === "POST") return ingest(url, init);
    if (String(url).includes("bonbast-json")) return map.json ? map.json(init) : { ok: false, status: 599, text: async () => "" };
    if (String(url).includes("t.me")) return map.telegram ? map.telegram(init) : { ok: false, status: 599, text: async () => "" };
    if (String(url).includes("bonbast-board")) return map.html ? map.html(init) : { ok: false, status: 599, text: async () => "" };
    if (String(url).includes("bon-bast.com")) return map.origin ? map.origin(init) : { ok: false, status: 403, text: async () => "blocked" };
    return { ok: false, status: 404, text: async () => "" };
  };
}

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
  const book = extractJsonBook(JSON_RELAY_BODY);
  assert.equal(book.usd1, "199000");
  assert.equal(book._acquisition, "json_handshake");
});

test("JSON relay HTTP success without book is not a valid book", () => {
  assert.equal(extractJsonBook(JSON.stringify({ ok: true, health: "up" })), null);
  assert.equal(isValidPhysicalBook({ ok: true }), false);
});

test("ingest SUCCESS requires accepted>0", () => {
  assert.equal(classifyIngestResponse(200, { accepted: 4 }, '{"accepted":4}').kind, "success");
  assert.equal(classifyIngestResponse(200, { accepted: 0 }, '{"accepted":0}').kind, "hijacked_or_invalid");
  assert.equal(classifyIngestResponse(200, { ok: true }, '{"ok":true}').kind, "hijacked_or_invalid");
  assert.equal(classifyIngestResponse(200, null, "<html>onrender</html>").kind, "hijacked_or_invalid");
});

test("process exits 1 when no successful ingest", () => {
  assert.equal(collectorProcessExitCode(0), 1);
  assert.equal(collectorProcessExitCode(1), 0);
});

test("collectOnce accepts the JSON relay book", async () => {
  const r = await collectOnce({
    env: { PHYSICAL_COLLECTOR_SECRET: SECRET },
    onEvent: () => {},
    fetchImpl: boardFetch({ json: jsonRelayOk }),
  });
  assert.equal(r.accepted, 4);
  assert.equal(r.source, "json_relay");
  assert.ok(String(r.board).includes("bonbast-json"));
});

test("API bases prefer Vercel proxy before Render DNS", () => {
  const bases = apiBases({ IRANPAY_API_BASE: "https://custom.example/api/v1" });
  assert.equal(bases[0], "https://iran-pay.vercel.app/api/v1");
  assert.equal(classifyApiBase(bases[0]), "vercel_api");
  assert.equal(classifyApiBase(bases[2]), "render_api");
  assert.equal(classifyApiBase("https://custom.example/api/v1", { IRANPAY_API_BASE: "https://custom.example/api/v1" }), "configured_api");
});

test("parser falls back to Telegram HTML", () => {
  const book = extractTelegramBook(TELEGRAM_HTML);
  assert.ok(book);
  assert.equal(book.usd1, "199200");
  assert.ok(isValidPhysicalBook(book));
});

test("Telegram: no valid Bonbast message", () => {
  assert.equal(extractTelegramBook("<div class=tgme_widget_message>hello channel</div>"), null);
});

test("Telegram: malformed prices are not a book", () => {
  const html = `
<div class="tgme_widget_message">
دلار آمریکا خرید: abc تومان فروش: xyz
یورو خرید: -- تومان فروش: --
درهم امارات خرید: ?? تومان فروش: ??
یوان چین خرید: ?? تومان فروش: ??
</div>`;
  assert.equal(extractTelegramBook(html), null);
});

test("Telegram: page available but stale/non-board content", () => {
  const html = `
<div class="tgme_widget_message">کانال بن‌بست — اطلاعیه نگهداری</div>
<div class="tgme_widget_message">دلار آمریکا بدون قیمت معتبر</div>`;
  assert.equal(extractTelegramBook(html), null);
});

test("source names are logical not raw URLs", () => {
  assert.equal(classifyBoardUrl("https://iran-pay.vercel.app/api/physical/bonbast-json"), "json_relay");
  assert.equal(classifyBoardUrl("https://t.me/s/bonbast"), "telegram");
  assert.equal(classifyBoardUrl("https://iran-pay.vercel.app/api/physical/bonbast-board"), "html_relay");
  assert.equal(classifyBoardUrl("https://www.bon-bast.com/"), "origin");
});

test("JSON relay timeout + Telegram success", async () => {
  const r = await collectOnce({
    env: { PHYSICAL_COLLECTOR_SECRET: SECRET },
    onEvent: () => {},
    fetchImpl: boardFetch({
      json: (init) => hangingFetch(init?.signal),
      telegram: telegramOk,
    }),
  });
  assert.equal(r.source, "telegram");
  assert.equal(r.accepted, 4);
});

test("slow JSON relay does not block a fast Telegram winner", async () => {
  const t0 = Date.now();
  const fetched = await fetchBoardBook(
    boardFetch({
      json: (init) => hangingFetch(init?.signal, 20_000),
      telegram: async () => {
        await new Promise((r) => setTimeout(r, 20));
        return telegramOk();
      },
    }),
    boardUrls({}),
    { deadlineMs: Date.now() + 8_000, onEvent: () => {} },
  );
  const elapsed = Date.now() - t0;
  assert.equal(fetched.source, "telegram");
  assert.ok(isValidPhysicalBook(fetched.book));
  assert.ok(elapsed < 2_000, `hedge took ${elapsed}ms`);
});

test("Telegram timeout + HTML relay success", async () => {
  const r = await collectOnce({
    env: { PHYSICAL_COLLECTOR_SECRET: SECRET },
    onEvent: () => {},
    fetchImpl: boardFetch({
      json: (init) => hangingFetch(init?.signal),
      telegram: (init) => hangingFetch(init?.signal),
      html: htmlRelayOk,
    }),
  });
  assert.equal(r.source, "html_relay");
  assert.equal(r.accepted, 4);
});

test("primary sources timeout + origin success", async () => {
  const r = await collectOnce({
    env: { PHYSICAL_COLLECTOR_SECRET: SECRET },
    onEvent: () => {},
    fetchImpl: boardFetch({
      json: (init) => hangingFetch(init?.signal),
      telegram: (init) => hangingFetch(init?.signal),
      html: (init) => hangingFetch(init?.signal),
      origin: htmlRelayOk,
    }),
  });
  assert.equal(r.source, "origin");
  assert.equal(r.accepted, 4);
});

test("all sources timeout", async () => {
  await assert.rejects(
    () =>
      collectOnce({
        env: { PHYSICAL_COLLECTOR_SECRET: SECRET },
        deadlineMs: Date.now() + 1_200,
        onEvent: () => {},
        fetchImpl: boardFetch({
          json: (init) => hangingFetch(init?.signal),
          telegram: (init) => hangingFetch(init?.signal),
          html: (init) => hangingFetch(init?.signal),
          origin: (init) => hangingFetch(init?.signal),
        }),
      }),
    (e) => /BOARD_TIMEOUT/.test(e.message),
  );
});

test("all sources invalid", async () => {
  await assert.rejects(
    () =>
      collectOnce({
        env: { PHYSICAL_COLLECTOR_SECRET: SECRET },
        onEvent: () => {},
        fetchImpl: boardFetch({
          json: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) }),
          telegram: async () => ({ ok: true, status: 200, text: async () => "<html>no board</html>" }),
          html: async () => ({ ok: true, status: 200, text: async () => "<html>empty</html>" }),
          origin: async () => ({ ok: true, status: 200, text: async () => "<html>blocked skin</html>" }),
        }),
      }),
    (e) => /BOARD_EMPTY/.test(e.message),
  );
});

test("collectOnce respects overall deadline", async () => {
  const t0 = Date.now();
  await assert.rejects(
    () =>
      collectOnce({
        env: { PHYSICAL_COLLECTOR_SECRET: SECRET },
        deadlineMs: Date.now() + 400,
        onEvent: () => {},
        fetchImpl: boardFetch({
          json: (init) => hangingFetch(init?.signal),
          telegram: (init) => hangingFetch(init?.signal),
          html: (init) => hangingFetch(init?.signal),
          origin: (init) => hangingFetch(init?.signal),
        }),
      }),
    (e) => /BOARD_TIMEOUT/.test(e.message),
  );
  assert.ok(Date.now() - t0 < 2_500, "deadline leak");
});

test("outer loop does not start an impossible final retry", async () => {
  let calls = 0;
  const started = 0;
  let now = started;
  const r = await runCollectorLoop({
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
    durationMs: 45_000,
    intervalMs: 2_000,
    minAttemptBudgetMs: MIN_ATTEMPT_BUDGET_MS,
    collectOnceBudgetMs: COLLECT_ONCE_BUDGET_MS,
    log: { log() {}, error() {} },
    collect: async () => {
      calls += 1;
      now += 28_000;
      throw new CollectorError("BOARD_TIMEOUT", { source: "json_relay", elapsedMs: 28000 });
    },
  });
  assert.equal(calls, 1);
  assert.equal(r.okCount, 0);
  assert.equal(r.attempts, 1);
});

test("outer loop stops after first confirmed ingest", async () => {
  let calls = 0;
  const r = await runCollectorLoop({
    now: () => Date.now(),
    sleep: async () => {},
    durationMs: 45_000,
    intervalMs: 2_000,
    log: { log() {}, error() {} },
    collect: async () => {
      calls += 1;
      return {
        fetchedAt: "t",
        base: "https://iran-pay.vercel.app/api/v1",
        baseName: "vercel_api",
        source: "json_relay",
        book: { usd1: "1", usd2: "1" },
        accepted: 4,
      };
    },
  });
  assert.equal(calls, 1);
  assert.equal(r.okCount, 1);
});

test("board timeout identifies source", () => {
  const e = new CollectorError("BOARD_TIMEOUT", { source: "json_relay", elapsedMs: 7012 });
  assert.equal(e.message, "BOARD_TIMEOUT source=json_relay elapsedMs=7012");
  assert.doesNotMatch(e.message, /PHYSICAL_COLLECTOR_SECRET|hmac|signature/i);
});

test("ingest timeout identifies API base and does not failover", async () => {
  let posts = 0;
  await assert.rejects(
    () =>
      ingestBook(
        async (url, init) => {
          if (init?.method === "POST") {
            posts += 1;
            return hangingFetch(init.signal);
          }
          return { ok: false, status: 500, text: async () => "" };
        },
        apiBases({}),
        { secret: SECRET, book: { usd1: "199000", usd2: "198900" }, timeoutMs: 80, nowMs: 1 },
      ),
    (e) => e instanceof CollectorError && e.code === "INGEST_TIMEOUT" && e.details.base === "vercel_api",
  );
  assert.equal(posts, 1);
});

test("auth failure remains distinct and does not fan out", async () => {
  let posts = 0;
  await assert.rejects(
    () =>
      ingestBook(
        async (_url, init) => {
          if (init?.method === "POST") {
            posts += 1;
            return { ok: false, status: 401, text: async () => "nope" };
          }
          return { ok: false, status: 500, text: async () => "" };
        },
        apiBases({}),
        { secret: SECRET, book: { usd1: "199000" }, nowMs: 1 },
      ),
    (e) => e instanceof CollectorError && e.code === "INGEST_AUTH_FAILURE" && /status=401/.test(e.message),
  );
  assert.equal(posts, 1);
});

test("parser failure remains distinct from timeout", () => {
  assert.equal(formatCollectorError("BOARD_EMPTY", { source: "telegram", elapsedMs: 40 }), "BOARD_EMPTY source=telegram elapsedMs=40");
});

test("fail-closed: 200 + accepted=0 is failure", async () => {
  await assert.rejects(
    () =>
      collectOnce({
        env: { PHYSICAL_COLLECTOR_SECRET: SECRET },
        onEvent: () => {},
        fetchImpl: boardFetch(
          { json: jsonRelayOk },
          { ingest: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ accepted: 0 }) }) },
        ),
      }),
    (e) => /INGEST_HTTP/.test(e.message) && /kind=hijacked_or_invalid/.test(e.message),
  );
});

test("fail-closed: 200 HTML ingest is failure", async () => {
  await assert.rejects(
    () =>
      collectOnce({
        env: { PHYSICAL_COLLECTOR_SECRET: SECRET },
        onEvent: () => {},
        fetchImpl: boardFetch(
          { json: jsonRelayOk },
          { ingest: async () => ({ ok: true, status: 200, text: async () => "<html>Render</html>" }) },
        ),
      }),
    (e) => /INGEST_HTTP/.test(e.message),
  );
});

test("fail-closed: ingest unavailable", async () => {
  await assert.rejects(
    () =>
      collectOnce({
        env: { PHYSICAL_COLLECTOR_SECRET: SECRET },
        onEvent: () => {},
        fetchImpl: boardFetch(
          { json: jsonRelayOk },
          { ingest: async () => ({ ok: false, status: 503, text: async () => "down" }) },
        ),
      }),
    (e) => /INGEST_HTTP/.test(e.message) && /status=503/.test(e.message),
  );
});

test("ingest POSTs remain sequential", async () => {
  const inflight = { n: 0, max: 0 };
  await ingestBook(
    async (url, init) => {
      if (init?.method !== "POST") return { ok: false, status: 404, text: async () => "" };
      inflight.n += 1;
      inflight.max = Math.max(inflight.max, inflight.n);
      await new Promise((r) => setTimeout(r, 15));
      inflight.n -= 1;
      if (String(url).includes("onrender")) return ingestOk(4);
      return { ok: false, status: 503, text: async () => "try next" };
    },
    ["https://iran-pay.vercel.app/api/v1", "https://iranpay-api.onrender.com/api/v1"],
    { secret: SECRET, book: { usd1: "1", usd2: "2" }, nowMs: 1 },
  ).then((r) => {
    assert.equal(r.ok, true);
    assert.equal(r.baseName, "render_api");
  });
  assert.equal(inflight.max, 1);
});

test("remainingMs never goes negative", () => {
  assert.equal(remainingMs(10, 20), 0);
  assert.ok(remainingMs(Date.now() + 1000) > 0);
});
