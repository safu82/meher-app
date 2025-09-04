// netlify/functions/send-nudge.js
exports.handler = async (event) => {
  // ===== CORS / preflight =====
  const CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  };
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: CORS };

  // ===== Env vars =====
  const {
    SUPABASE_URL,
    SUPABASE_ANON_KEY,
    SUPABASE_SERVICE_ROLE_KEY,
    TWILIO_ACCOUNT_SID,
    TWILIO_AUTH_TOKEN,
    TWILIO_WHATSAPP_FROM, // e.g. "whatsapp:+14155238886" (Sandbox) or your approved number
    SITE_URL,             // optional: link to your app shown in messages
    CRON_SECRET,          // required query token
    DAILY_TARGET_MIN,     // optional (default 240)
  } = process.env;

  // ---- Hard-coded fallback for Meher (set this once) ----
  // Put Meher's WhatsApp number here in E.164 format, e.g. "+91XXXXXXXXXX".
  // If you leave this empty, the code will fall back to profiles.meher_phone.
  const DEFAULT_MEHER_TO = "+919987785027";

  // ===== Basic config check =====
  const must = [
    SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY,
    TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_WHATSAPP_FROM
  ];
  if (must.some(v => !v)) {
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: "Server not configured. Missing env vars." })
    };
  }

  // ===== Helpers =====
  function todayISOinIST() {
    const now = new Date();
    const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
    const ist = new Date(utc + 5.5 * 3600000); // UTC+5:30
    const y = ist.getFullYear();
    const m = String(ist.getMonth() + 1).padStart(2, "0");
    const d = String(ist.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  function fmtHM(mins) {
    const h = Math.floor((mins || 0) / 60);
    const m = (mins || 0) % 60;
    if (h && m) return `${h}h ${m}m`;
    if (h) return `${h}h`;
    return `${m}m`;
  }
  // Be tolerant of URLs where '+' becomes a space or is omitted.
  function normalizeTo(e164) {
    let t = (e164 || "").trim().replace(/\s+/g, "");
    if (t.startsWith("whatsapp:")) t = t.slice("whatsapp:".length);
    if (!t.startsWith("+") && /^\d{10,15}$/.test(t)) t = "+" + t;
    return t;
  }

  try {
    // ===== Auth: token guard =====
    const params = event.queryStringParameters || {};
    const token = (params.token || "").trim();
    if (!CRON_SECRET || token !== CRON_SECRET) {
      return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: "Unauthorized" }) };
    }

    // kind=plan|log|weekly_parent|wrap2230
    const kind = (params.kind || "plan").toLowerCase();

    // Optional: override recipient for a one-off test (e.g., &to=+91XXXXXXXXXX)
    const toOverride = params.to ? normalizeTo(params.to) : null;

    // ===== Load profiles (server-side, service role) =====
    const select = [
      "user_id",
      "meher_phone",
      "parent_phone",
      "tz",
      "daily_opt_in",
      "weekly_parent_opt_in",
    ].join(",");
    const profRes = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?select=${encodeURIComponent(select)}`,
      {
        headers: {
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        },
      }
    );
    if (!profRes.ok) {
      const t = await profRes.text();
      return {
        statusCode: profRes.status,
        headers: CORS,
        body: JSON.stringify({ error: "profiles fetch failed", detail: t }),
      };
    }
    const profiles = await profRes.json();

    // ===== Build rows to send =====
    let rows = [];

    if (kind === "plan") {
      for (const p of profiles) {
        if (!p.daily_opt_in) continue;
        const to = toOverride || normalizeTo(DEFAULT_MEHER_TO || p.meher_phone);
        if (!to || !to.startsWith("+")) continue;
        const msg = `⏰ Quick nudge: Please plan tomorrow by 22:00.\nOpen the app: ${SITE_URL || ""}`;
        rows.push({ to, msg });
        if (toOverride || DEFAULT_MEHER_TO) break; // send only once when overriding
      }
    } else if (kind === "log") {
      for (const p of profiles) {
        if (!p.daily_opt_in) continue;
        const to = toOverride || normalizeTo(DEFAULT_MEHER_TO || p.meher_phone);
        if (!to || !to.startsWith("+")) continue;
        const msg = `📝 Reminder: Please log today's study by 23:00.\nOpen the app: ${SITE_URL || ""}`;
        rows.push({ to, msg });
        if (toOverride || DEFAULT_MEHER_TO) break;
      }
    } else if (kind === "weekly_parent") {
      for (const p of profiles) {
        if (!p.weekly_parent_opt_in) continue;
        const to = toOverride || normalizeTo(p.parent_phone);
        if (!to || !to.startsWith("+")) continue;
        const msg = `📊 Weekly update is ready.\nOpen the app: ${SITE_URL || ""}`;
        rows.push({ to, msg });
        if (toOverride) break;
      }
    } else if (kind === "wrap2230") {
      // Dynamic 22:30 IST message: "actuals up to now + are you done?"
      const iso = todayISOinIST();
      const targetMin = Number(DAILY_TARGET_MIN || 240);

      for (const p of profiles) {
        if (!p.daily_opt_in) continue;

        const to = toOverride || normalizeTo(DEFAULT_MEHER_TO || p.meher_phone);
        if (!to || !to.startsWith("+")) continue;

        // Fetch today's actuals for this user
        const q = new URLSearchParams({
          select: "duration_min",
          iso: `eq.${iso}`,
          user_id: `eq.${p.user_id}`,
        });
        const actRes = await fetch(
          `${SUPABASE_URL}/rest/v1/sessions_actual?${q.toString()}`,
          {
            headers: {
              apikey: SUPABASE_ANON_KEY,
              Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
            },
          }
        );

        if (!actRes.ok) {
          const fallback = `Couldn't fetch today’s totals, but remember to wrap up and log your study.\nOpen the app: ${SITE_URL || ""}`;
          rows.push({ to, msg: fallback });
          if (toOverride || DEFAULT_MEHER_TO) break;
          continue;
        }

        const acts = await actRes.json(); // [{ duration_min }, ...]
        const totalMin = acts.reduce((s, r) => s + (r?.duration_min || 0), 0);
        const pct = targetMin > 0 ? Math.round((totalMin / targetMin) * 100) : 0;

        const header = `Today so far: ${fmtHM(totalMin)} / ${fmtHM(targetMin)} (${pct}%)`;
        const tail = `Are you done for the day? If yes, reply "DONE". If not, try a short focused block. You’ve got this 💪`;
        const msg = [header, `Open the app: ${SITE_URL || ""}`, tail].join("\n\n");

        rows.push({ to, msg });
        if (toOverride || DEFAULT_MEHER_TO) break;
      }
    } else {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: `Unknown kind: ${kind}` }) };
    }

    // ===== Send via Twilio =====
    const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");
    let sent = 0;
    const errors = [];

    console.log("rows to send:", rows.length);

    for (const r of rows) {
      console.log("Sending to:", r.to);

      const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`;
      const body = new URLSearchParams({
        From: TWILIO_WHATSAPP_FROM,      // already "whatsapp:+1..."
        To: `whatsapp:${r.to}`,          // ensure only one "whatsapp:" prefix
        Body: r.msg,
      });

      const res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: body.toString(),
      });

      let j = {};
      try { j = await res.json(); } catch (_) {}
      console.log("Twilio response:", j); // view in Netlify Functions → Logs

      if (res.ok) sent++;
      else errors.push({ to: r.to, error: j.message || res.statusText || `HTTP ${res.status}` });
    }

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ ok: true, kind, attempted: rows.length, sent, errors }),
    };
  } catch (e) {
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: e.message || "Server error" }),
    };
  }
};

