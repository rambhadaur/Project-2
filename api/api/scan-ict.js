/**
 * ICT Gold AI — 24/7 Multi-Strategy Scanner (Vercel Serverless + Cron)
 * QUALITY BALANCED: More high-accuracy signals without flooding low-quality setups
 *
 * PRIMARY ENTRY STRATEGIES
 *  1. Strict ICT / Market Maker   (weight 25)
 *  2. Silver Bullet               (weight 22)
 *  3. Turtle Soup                 (weight 19)
 *  4. Breaker Block               (weight 16)
 *  5. OTE Pullback                (weight 14)
 *
 * CONFIRMATION / FILTER STRATEGIES
 *  6. CISD                        (weight 10)
 *  7. Unicorn Model               (weight 7)
 *  8. Liquidity Sweep / Raid      (weight 6)
 *  9. Judas Swing                 (weight 3)
 * 10. London Reversal             (weight 2)
 * 11. FVG Continuation            (bonus max 2 — NEVER standalone signal)
 *
 * Flow: 4H → 1H → 15M → 5M → 1M
 * Confidence 0–100. Quality Balanced signals require ≥62. Auto execution remains ≥70.
 * Same market event is deduplicated into ONE signal with primary + confirmations.
 *
 * Env vars (recommended):
 *   TWELVE_DATA_KEY, TWELVE_DATA_KEY_2, TWELVE_DATA_KEY_3   (or TWELVE_DATA_KEYS=key1,key2,key3)
 *   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID,
 *   NTFY_TOPIC, FCM_SERVER_KEY, FIREBASE_RTDB_URL,
 *   MIN_SIGNAL_PROB (default 90 for strict),
 *   STRATEGY_MODE = "strict" | "multi" | "balanced" | "aggressive"  (default "balanced")
 *
 * Schedule: every 5 minutes via vercel.json crons
 *
 * Multi-key rotation: if one Twelve Data key fails (rate-limit, invalid, no data),
 * automatically tries the next available key.
 */
const FCM_SERVER_KEY = process.env.FCM_SERVER_KEY || "";
const RTDB =
  process.env.FIREBASE_RTDB_URL ||
  "https://ict-signal-default-rtdb.firebaseio.com";
const PAIR = "XAUUSD";
const LOOKBACK = 120;
const PIVOT = 2;

// Strategy mode: strict = original high-bar only | multi = all models | aggressive = lower thresholds
const STRATEGY_MODE = (process.env.STRATEGY_MODE || "balanced").toLowerCase();
const MIN_PROB_STRICT = Number(process.env.MIN_SIGNAL_PROB || 90);
const MIN_PROB_MULTI = Number(process.env.MIN_SIGNAL_PROB_MULTI || 50);
const MIN_PROB_BALANCED = Number(process.env.MIN_SIGNAL_PROB_BALANCED || 62);
const MIN_PROB_AGGRESSIVE = Number(process.env.MIN_SIGNAL_PROB_AGGRESSIVE || 50);

/** Collect up to 3+ Twelve Data API keys for automatic rotation */
function collectTdKeys(remote = {}) {
  const keys = [];
  const add = (k) => {
    const v = (k || "").trim();
    if (v && v.length > 8 && !keys.includes(v)) keys.push(v);
  };
  add(remote.twelveDataKey);
  add(remote.twelveDataKey2);
  add(remote.twelveDataKey3);
  add(remote.twelveDataKey4);
  add(remote.twelveDataKey5);
  add(remote.twelveDataKey6);
  add(remote.twelveDataKey7);
  add(remote.twelveDataKey8);
  add(remote.twelveDataKey9);
  add(remote.twelveDataKey10);
  if (remote.twelveDataKeys) {
    String(remote.twelveDataKeys).split(/[,;\s]+/).forEach(add);
  }
  add(process.env.TWELVE_DATA_KEY);
  add(process.env.TWELVE_DATA_KEY_2);
  add(process.env.TWELVE_DATA_KEY_3);
  add(process.env.TWELVE_DATA_KEY_4);
  add(process.env.TWELVE_DATA_KEY_5);
  add(process.env.TWELVE_DATA_KEY_6);
  add(process.env.TWELVE_DATA_KEY_7);
  add(process.env.TWELVE_DATA_KEY_8);
  add(process.env.TWELVE_DATA_KEY_9);
  add(process.env.TWELVE_DATA_KEY_10);
  add(process.env.TD_KEY);
  if (process.env.TWELVE_DATA_KEYS) {
    process.env.TWELVE_DATA_KEYS.split(/[,;\s]+/).forEach(add);
  }
  return keys;
}

async function getBlobStore() {
  // Netlify Blobs not available on Vercel — always null
  return null;
}

/** Load keys: RTDB → env vars (multi-key support) */
async function loadServerConfig() {
  let remote = {};
  try {
    const res = await fetch(RTDB.replace(/\/$/, "") + "/serverConfig.json", {
      headers: { Accept: "application/json" }
    });
    if (res.ok) {
      const data = await res.json();
      if (data && typeof data === "object") remote = data;
    }
  } catch (e) {}

  const tdKeys = collectTdKeys(remote);

  const kzRaw = (
    remote.killZoneFilter ||
    process.env.KILL_ZONE_FILTER ||
    "both"
  )
    .toString()
    .trim()
    .toLowerCase();
  const kzFilter =
    kzRaw === "inside" || kzRaw === "outside" || kzRaw === "both" ? kzRaw : "both";

  return {
    TD_KEYS: tdKeys,
    TD_KEY: tdKeys[0] || "", // primary for compatibility
    TG_TOKEN:
      (remote.telegramBotToken || "").trim() ||
      (process.env.TELEGRAM_BOT_TOKEN || "").trim(),
    TG_CHAT:
      (remote.telegramChatId || "").trim() ||
      (process.env.TELEGRAM_CHAT_ID || "").trim(),
    NTFY_TOPIC:
      (remote.ntfyTopic || "").trim() ||
      (process.env.NTFY_TOPIC || "").trim(),
    // Prefer UI-saved RTDB mode over env so Profile "Save" actually controls 24/7 scans
    MODE: (
      (remote.strategyMode && String(remote.strategyMode).trim()) ||
      STRATEGY_MODE ||
      "balanced"
    ).toLowerCase(),
    KZ_FILTER: kzFilter
  };
}

const TF_MAP = {
  h4: "4h",
  h1: "1h",
  m15: "15min",
  m5: "5min",
  m1: "1min"
};

/* ---------- helpers ---------- */
function bodySize(c) {
  return Math.abs(c.close - c.open);
}
function rangeSize(c) {
  return c.high - c.low;
}
function isBull(c) {
  return c.close > c.open;
}
function isBear(c) {
  return c.close < c.open;
}

function isDisplacement(candles, i, lookback) {
  if (i < 1) return false;
  const c = candles[i];
  const body = bodySize(c);
  const rng = rangeSize(c);
  if (rng <= 0 || body / rng < 0.55) return false;
  lookback = lookback || 14;
  let sum = 0,
    n = 0;
  for (let k = Math.max(0, i - lookback); k < i; k++) {
    sum += rangeSize(candles[k]);
    n++;
  }
  const avg = n ? sum / n : rng;
  return body >= avg * 1.35;
}

function pivots(candles, left, right) {
  left = left || PIVOT;
  right = right || PIVOT;
  const highs = [],
    lows = [];
  for (let i = left; i < candles.length - right; i++) {
    let hi = true,
      lo = true;
    for (let j = 1; j <= left; j++) {
      if (candles[i].high <= candles[i - j].high) hi = false;
      if (candles[i].low >= candles[i - j].low) lo = false;
    }
    for (let j = 1; j <= right; j++) {
      if (candles[i].high < candles[i + j].high) hi = false;
      if (candles[i].low > candles[i + j].low) lo = false;
    }
    if (hi) highs.push({ i, price: candles[i].high, time: candles[i].time });
    if (lo) lows.push({ i, price: candles[i].low, time: candles[i].time });
  }
  return { highs, lows };
}

function structure(candles) {
  const p = pivots(candles);
  const last = candles[candles.length - 1];
  const lastIdx = candles.length - 1;
  const sh = p.highs[p.highs.length - 1];
  const sl = p.lows[p.lows.length - 1];
  const prevH = p.highs[p.highs.length - 2];
  const prevL = p.lows[p.lows.length - 2];

  let swingTrend = "WAIT";
  if (sh && prevH && sl && prevL) {
    const hh = sh.price > prevH.price;
    const hl = sl.price > prevL.price;
    const lh = sh.price < prevH.price;
    const ll = sl.price < prevL.price;
    if (hh && hl) swingTrend = "BUY";
    else if (lh && ll) swingTrend = "SELL";
  }

  let bullDisp = false,
    bearDisp = false;
  for (let i = Math.max(1, lastIdx - 6); i <= lastIdx; i++) {
    if (isDisplacement(candles, i) && isBull(candles[i])) bullDisp = true;
    if (isDisplacement(candles, i) && isBear(candles[i])) bearDisp = true;
  }

  const bullishBOS = !!(sh && last.close > sh.price && bullDisp);
  const bearishBOS = !!(sl && last.close < sl.price && bearDisp);

  let chochBull = false,
    chochBear = false;
  if (swingTrend === "SELL" && sh && last.close > sh.price && bullDisp)
    chochBull = true;
  if (swingTrend === "BUY" && sl && last.close < sl.price && bearDisp)
    chochBear = true;
  if (sl && last.close > sl.price && bullDisp && !bullishBOS) {
    if (prevL && sl.price < prevL.price) chochBull = true;
  }
  if (sh && last.close < sh.price && bearDisp && !bearishBOS) {
    if (prevH && sh.price > prevH.price) chochBear = true;
  }

  let trend = swingTrend;
  if (bullishBOS || chochBull) trend = "BUY";
  if (bearishBOS || chochBear) trend = "SELL";

  return {
    trend,
    swingTrend,
    bullishBOS,
    bearishBOS,
    chochBull,
    chochBear,
    bullDisp,
    bearDisp,
    sh,
    sl,
    pivots: p
  };
}

function liquiditySweep(candles) {
  const p = pivots(candles);
  const n = candles.length;
  const recentLows = p.lows.slice(-8).filter((x) => x.i < n - 2);
  const recentHighs = p.highs.slice(-8).filter((x) => x.i < n - 2);
  const sweepLook = Math.min(8, n - 1);

  let bullSweep = null;
  for (const lvl of recentLows.slice().reverse()) {
    for (let bi = 0; bi < sweepLook && !bullSweep; bi++) {
      const c = candles[n - 1 - bi];
      if (c.low < lvl.price && c.close > lvl.price) {
        bullSweep = { type: "sellside", level: lvl, candle: c };
        break;
      }
    }
    if (bullSweep) break;
  }

  let bearSweep = null;
  for (const lvl of recentHighs.slice().reverse()) {
    for (let bi = 0; bi < sweepLook && !bearSweep; bi++) {
      const c = candles[n - 1 - bi];
      if (c.high > lvl.price && c.close < lvl.price) {
        bearSweep = { type: "buyside", level: lvl, candle: c };
        break;
      }
    }
    if (bearSweep) break;
  }

  let sessHigh = -Infinity,
    sessLow = Infinity;
  const look = Math.min(48, n);
  for (let i = n - look; i < n; i++) {
    if (candles[i].high > sessHigh) sessHigh = candles[i].high;
    if (candles[i].low < sessLow) sessLow = candles[i].low;
  }

  return {
    bull: !!bullSweep,
    bear: !!bearSweep,
    bullSweep,
    bearSweep,
    low: bullSweep ? bullSweep.level : recentLows[recentLows.length - 1],
    high: bearSweep ? bearSweep.level : recentHighs[recentHighs.length - 1],
    sessHigh,
    sessLow
  };
}

function fvg(candles) {
  const out = [];
  const n = candles.length;
  for (let i = 2; i < n; i++) {
    const a = candles[i - 2],
      c = candles[i];
    if (c.low > a.high) {
      const gap = {
        dir: "buy",
        low: a.high,
        high: c.low,
        mid: (a.high + c.low) / 2,
        i,
        mitigated: false
      };
      for (let k = i + 1; k < n; k++) {
        if (candles[k].low <= gap.low) {
          gap.mitigated = true;
          break;
        }
      }
      out.push(gap);
    }
    if (c.high < a.low) {
      const gap = {
        dir: "sell",
        low: c.high,
        high: a.low,
        mid: (c.high + a.low) / 2,
        i,
        mitigated: false
      };
      for (let k = i + 1; k < n; k++) {
        if (candles[k].high >= gap.high) {
          gap.mitigated = true;
          break;
        }
      }
      out.push(gap);
    }
  }
  return out.filter((x) => x.i >= n - 40).slice(-12);
}

function orderBlocks(candles) {
  const out = [];
  const n = candles.length;
  for (let i = 3; i < n; i++) {
    if (!isDisplacement(candles, i)) continue;
    if (isBull(candles[i])) {
      for (let k = i - 1; k >= Math.max(0, i - 6); k--) {
        if (isBear(candles[k])) {
          const ob = {
            dir: "buy",
            low: candles[k].low,
            high: candles[k].high,
            i: k,
            mitigated: false
          };
          for (let m = i + 1; m < n; m++) {
            if (candles[m].low < ob.low) {
              ob.mitigated = true;
              break;
            }
          }
          out.push(ob);
          break;
        }
      }
    }
    if (isBear(candles[i])) {
      for (let k = i - 1; k >= Math.max(0, i - 6); k--) {
        if (isBull(candles[k])) {
          const ob = {
            dir: "sell",
            low: candles[k].low,
            high: candles[k].high,
            i: k,
            mitigated: false
          };
          for (let m = i + 1; m < n; m++) {
            if (candles[m].high > ob.high) {
              ob.mitigated = true;
              break;
            }
          }
          out.push(ob);
          break;
        }
      }
    }
  }
  return out.filter((x) => x.i >= n - 50).slice(-10);
}

/** Detect Breaker Blocks: an OB that was violated (price closed through it) */
function breakerBlocks(candles, obs) {
  const out = [];
  const n = candles.length;
  const lastClose = candles[n - 1].close;
  for (const ob of obs) {
    // Original bullish OB that price later closed below → becomes bearish breaker
    if (ob.dir === "buy" && !ob.mitigated) {
      for (let k = ob.i + 1; k < n; k++) {
        if (candles[k].close < ob.low) {
          out.push({
            dir: "sell",
            low: ob.low,
            high: ob.high,
            i: ob.i,
            type: "breaker",
            originalDir: "buy"
          });
          break;
        }
      }
    }
    // Original bearish OB that price later closed above → becomes bullish breaker
    if (ob.dir === "sell" && !ob.mitigated) {
      for (let k = ob.i + 1; k < n; k++) {
        if (candles[k].close > ob.high) {
          out.push({
            dir: "buy",
            low: ob.low,
            high: ob.high,
            i: ob.i,
            type: "breaker",
            originalDir: "sell"
          });
          break;
        }
      }
    }
  }
  return out.slice(-6);
}

function dealingRange(candles, s) {
  const highs = (s && s.pivots && s.pivots.highs) || pivots(candles).highs;
  const lows = (s && s.pivots && s.pivots.lows) || pivots(candles).lows;
  const useH = highs.slice(-4);
  const useL = lows.slice(-4);
  let high = -Infinity,
    low = Infinity;
  for (const h of useH) if (h.price > high) high = h.price;
  for (const l of useL) if (l.price < low) low = l.price;
  if (!isFinite(high) || !isFinite(low) || high <= low) {
    const slice = candles.slice(-40);
    high = Math.max(...slice.map((c) => c.high));
    low = Math.min(...slice.map((c) => c.low));
  }
  const range = high - low;
  const eq = (high + low) / 2;
  const oteBuyLow = high - range * 0.79;
  const oteBuyHigh = high - range * 0.618;
  const oteSellLow = low + range * 0.618;
  const oteSellHigh = low + range * 0.79;
  return {
    high,
    low,
    eq,
    range,
    oteBuyLow,
    oteBuyHigh,
    oteSellLow,
    oteSellHigh
  };
}

function analyzeTF(candles) {
  const s = structure(candles);
  const liq = liquiditySweep(candles);
  const fvgs = fvg(candles);
  const obs = orderBlocks(candles);
  const breakers = breakerBlocks(candles, obs);
  const dr = dealingRange(candles, s);
  const last = candles[candles.length - 1];
  let pd = "EQ";
  if (last.close < dr.eq) pd = "DISCOUNT";
  else if (last.close > dr.eq) pd = "PREMIUM";
  return { ...s, liq, fvgs, obs, breakers, dr, pd, last, candles };
}

function getSessionInfo(date) {
  const d = date || new Date();
  const day = d.getUTCDay();
  const weekday = day >= 1 && day <= 5;
  const h = d.getUTCHours() + d.getUTCMinutes() / 60;
  let active = null;
  if (h >= 7 && h < 10) active = { id: "london", name: "London Open" };
  else if (h >= 12 && h < 15) active = { id: "nyam", name: "New York AM" };
  else if (h >= 15 && h < 17) active = { id: "nypm", name: "New York PM" };
  else if (h >= 0 && h < 7) active = { id: "asia", name: "Asian" };
  const inKillZone = !!(active && (active.id === "london" || active.id === "nyam"));
  const inSilverBulletWindow =
    (h >= 12 && h < 13) || (h >= 14 && h < 15) || (h >= 7 && h < 8); // approx 10-11 NY / 2-3 / London
  return { weekday, inKillZone, inSilverBulletWindow, active, hourUTC: h };
}

function inZone(price, z) {
  return price >= z.low && price <= z.high;
}

function inRange(price, lo, hi) {
  return price >= lo && price <= hi;
}

/* ============================================================
   UPGRADED MULTI-STRATEGY ICT SIGNAL ENGINE
   11 strategies · MTF hierarchy · weighted confidence · dedup
   ============================================================ */

const STRATEGY_WEIGHTS = {
  "Strict ICT / Market Maker": 25,
  "Silver Bullet": 22,
  "Turtle Soup": 19,
  "Breaker Block": 16,
  "OTE Pullback": 14,
  "CISD": 10,                 // boosted — strong confirmation
  "Unicorn Model": 7,         // boosted — high-quality confluence
  "Liquidity Sweep / Raid": 6, // slight boost
  "Judas Swing": 3,
  "London Reversal": 2,
  "FVG Continuation": 2
};

const PRIMARY_STRATEGIES = new Set([
  "Strict ICT / Market Maker",
  "Silver Bullet",
  "Turtle Soup",
  "Breaker Block",
  "OTE Pullback"
]);

function buildTradeResult(direction, price, zone, entryTF, refineTF, dr, session, primary, confirmations, score, dig, biases, reason, mode) {
  const entry = price;
  const buffer = Math.max((zone.high - zone.low) * 0.15, price * 0.0002);
  let sl, tp1, tp2, tp3;

  if (direction === "BUY") {
    const sweepLvl = entryTF.liq.bullSweep ? entryTF.liq.bullSweep.level.price : zone.low;
    const swingLow = entryTF.sl ? entryTF.sl.price : zone.low;
    sl = Math.min(zone.low, sweepLvl, swingLow) - buffer;
    const risk = Math.max(entry - sl, price * 0.00035);
    const buySideLiq = entryTF.liq.sessHigh || dr.high;
    tp1 = entry + risk * 2.0;
    tp2 = Math.max(entry + risk * 3.0, buySideLiq * 0.999);
    tp3 = Math.max(entry + risk * 4.0, dr.high);
    if ((tp1 - entry) / risk < 2) tp1 = entry + risk * 2;
  } else {
    const sweepLvl = entryTF.liq.bearSweep ? entryTF.liq.bearSweep.level.price : zone.high;
    const swingHigh = entryTF.sh ? entryTF.sh.price : zone.high;
    sl = Math.max(zone.high, sweepLvl, swingHigh) + buffer;
    const risk = Math.max(sl - entry, price * 0.00035);
    const sellSideLiq = entryTF.liq.sessLow || dr.low;
    tp1 = entry - risk * 2.0;
    tp2 = Math.min(entry - risk * 3.0, sellSideLiq * 1.001);
    tp3 = Math.min(entry - risk * 4.0, dr.low);
    if ((entry - tp1) / risk < 2) tp1 = entry - risk * 2;
  }

  const risk = Math.abs(entry - sl);
  const rr = risk > 0 ? Math.abs(tp1 - entry) / risk : 0;
  if (rr < 1.8) {
    return { trade: false, reason: "R:R below minimum (1:" + rr.toFixed(1) + ")" };
  }

  const confLevel =
    score >= 90 ? "EXTREME / A+" :
    score >= 80 ? "HIGH CONFIDENCE" :
    score >= 70 ? "GOOD SETUP" :
    score >= 60 ? "MODERATE / WATCH" : "NO TRADE";

  return {
    trade: true,
    dir: direction.toLowerCase(),
    direction,
    entry: +entry.toFixed(dig),
    sl: +sl.toFixed(dig),
    tp1: +tp1.toFixed(dig),
    tp2: +tp2.toFixed(dig),
    tp3: +tp3.toFixed(dig),
    rr: +rr.toFixed(2),
    prob: Math.min(98, Math.round(score)),
    confidenceLevel: confLevel,
    model: primary,
    primaryStrategy: primary,
    confirmations: confirmations || [],
    pair: PAIR,
    session: session.active ? session.active.name : (session.inKillZone ? "Kill Zone" : ""),
    mode: mode || STRATEGY_MODE,
    bias4H: biases.h4 || "—",
    bias1H: biases.h1 || "—",
    setupTF: "15M",
    confirmTF: "5M",
    entryTF: "1M/5M",
    reason: reason || (primary + (confirmations && confirmations.length ? " + " + confirmations.join(" + ") : "")),
    at: new Date().toISOString()
  };
}

function detectCISD(entryTF, refineTF, direction) {
  // CISD: strong close in trade direction after displacement / MSS (state of delivery change)
  const c = entryTF.last || refineTF.last;
  if (!c) return false;
  if (direction === "BUY") {
    return isBull(c) && (entryTF.bullDisp || refineTF.bullDisp || entryTF.chochBull || entryTF.bullishBOS);
  }
  return isBear(c) && (entryTF.bearDisp || refineTF.bearDisp || entryTF.chochBear || entryTF.bearishBOS);
}

function detectUnicorn(entryTF, m15, direction, price) {
  // Unicorn: FVG + Order Block confluence in same direction (both unmitigated near price)
  const dirKey = direction === "BUY" ? "buy" : "sell";
  const fvgs = (entryTF.fvgs || []).concat(m15.fvgs || []).filter(x => x.dir === dirKey && !x.mitigated);
  const obs = (entryTF.obs || []).concat(m15.obs || []).filter(x => x.dir === dirKey && !x.mitigated);
  let hasF = false, hasO = false;
  for (const z of fvgs) if (inZone(price, z) || Math.abs(z.mid - price) / price < 0.0015) hasF = true;
  for (const z of obs) if (inZone(price, z) || Math.abs(((z.high + z.low) / 2) - price) / price < 0.0015) hasO = true;
  return hasF && hasO;
}

function detectJudas(session, entryTF, refineTF, direction) {
  // Juda
