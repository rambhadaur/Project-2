/**
 * GET /api/health
 * Status + Twelve Data key quota (remaining / 800 free plan).
 * Supports up to 10 rotating API keys.
 */
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

function maskKey(k) {
  if (!k || k.length < 10) return "—";
  return k.slice(0, 6) + "…" + k.slice(-4);
}

async function loadRemote() {
  try {
    const RTDB =
      process.env.FIREBASE_RTDB_URL ||
      "https://ict-signal-default-rtdb.firebaseio.com";
    const res = await fetch(RTDB.replace(/\/$/, "") + "/serverConfig.json", {
      headers: { Accept: "application/json" }
    });
    if (res.ok) {
      const data = await res.json();
      if (data && typeof data === "object") return data;
    }
  } catch (e) {}
  return {};
}

async function fetchQuota(apiKey) {
  try {
    const url =
      "https://api.twelvedata.com/api_usage?apikey=" + encodeURIComponent(apiKey);
    const res = await fetch(url, { cache: "no-store" });
    const j = await res.json().catch(() => ({}));
    const left =
      j.credits_left != null
        ? Number(j.credits_left)
        : j.api_credits_left != null
        ? Number(j.api_credits_left)
        : null;
    const used =
      j.credits_used != null
        ? Number(j.credits_used)
        : j.api_credits_used != null
        ? Number(j.api_credits_used)
        : null;
    const limit =
      j.plan_daily_limit != null
        ? Number(j.plan_daily_limit)
        : j.daily_limit != null
        ? Number(j.daily_limit)
        : 800;
    const plan = j.plan || j.plan_name || "Basic";
    const limited =
      (left != null && left <= 0) ||
      /rate|limit|quota|exceeded|credits/i.test(String(j.message || j.status || ""));
    return {
      ok: res.ok && left != null,
      masked: maskKey(apiKey),
      creditsLeft: left,
      creditsUsed: used,
      dailyLimit: limit || 800,
      plan,
      limited: !!limited,
      message: j.message || null
    };
  } catch (e) {
    return {
      ok: false,
      masked: maskKey(apiKey),
      creditsLeft: null,
      creditsUsed: null,
      dailyLimit: 800,
      plan: "?",
      limited: false,
      message: e.message || String(e)
    };
  }
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");

  const remote = await loadRemote();
  const tdKeys = collectTdKeys(remote);
  const hasTd = tdKeys.length > 0;
  const hasTg = !!(
    (remote.telegramBotToken || process.env.TELEGRAM_BOT_TOKEN) &&
    (remote.telegramChatId || process.env.TELEGRAM_CHAT_ID)
  );
  const hasNtfy = !!(remote.ntfyTopic || process.env.NTFY_TOPIC);
  const hasFcm = !!process.env.FCM_SERVER_KEY;

  let lastHeartbeat = null;
  try {
    const RTDB =
      process.env.FIREBASE_RTDB_URL ||
      "https://ict-signal-default-rtdb.firebaseio.com";
    const r = await fetch(RTDB.replace(/\/$/, "") + "/lastServerHeartbeat.json", {
      headers: { Accept: "application/json" }
    });
    if (r.ok) lastHeartbeat = await r.json();
  } catch (e) {}

  const ageMin =
    lastHeartbeat && lastHeartbeat.at
      ? Math.round((Date.now() - lastHeartbeat.at) / 60000)
      : null;

  const quotas = [];
  for (let i = 0; i < tdKeys.length && i < 10; i++) {
    quotas.push(await fetchQuota(tdKeys[i]));
  }

  const anyAvailable = quotas.some(
    (q) => q.ok && !q.limited && (q.creditsLeft == null || q.creditsLeft > 0)
  );
  const allLimited =
    quotas.length > 0 &&
    quotas.every((q) => q.limited || (q.creditsLeft != null && q.creditsLeft <= 0));

  let scannerStatus = "unknown";
  let scannerReason = "";
  if (!hasTd) {
    scannerStatus = "deactivated";
    scannerReason = "No Twelve Data API keys configured";
  } else if (allLimited) {
    scannerStatus = "deactivated";
    scannerReason =
      "All API keys hit daily limit (800/day free plan). Resets midnight UTC.";
  } else if (ageMin == null) {
    scannerStatus = "inactive";
    scannerReason =
      "No heartbeat yet — set up cron every 5 min pointing to /api/scan-ict";
  } else if (ageMin > 15) {
    scannerStatus = "deactivated";
    scannerReason =
      "Last scan " + ageMin + " min ago — cron may be stopped or failing";
  } else {
    scannerStatus = "active";
    scannerReason = "Online (every 5 min)";
  }

  return res.status(200).json({
    ok: true,
    platform: "vercel",
    service: "ICT Gold AI — 24/7 Multi-Strategy Scanner",
    hasFcmKey: hasFcm,
    hasTelegram: hasTg,
    hasNtfy: hasNtfy,
    hasTwelveData: hasTd,
    twelveDataKeysCount: tdKeys.length,
    twelveDataKeysMasked: tdKeys.map(maskKey),
    quotas,
    anyKeyAvailable: anyAvailable,
    allKeysLimited: allLimited,
    scannerStatus,
    scannerReason,
    lastHeartbeat: lastHeartbeat
      ? {
          ok: lastHeartbeat.ok,
          trade: lastHeartbeat.trade,
          error: lastHeartbeat.error || null,
          usedKey: lastHeartbeat.usedKeyMasked || null,
          price: lastHeartbeat.price || null,
          ageMinutes: ageMin,
          at: lastHeartbeat.iso || null
        }
      : null,
    cronAlive: ageMin != null && ageMin < 15,
    note:
      scannerStatus === "active"
        ? "24/7 scanner ACTIVE — browser does not need to stay open. Keys rotate on rate-limit."
        : scannerReason
  });
};
