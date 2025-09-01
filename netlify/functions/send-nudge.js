// netlify/functions/send-nudge.js
exports.handler = async (event) => {
  const CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  };
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: CORS };

  const {
    SUPABASE_URL,
    SUPABASE_ANON_KEY,
    SUPABASE_SERVICE_ROLE_KEY,
    TWILIO_ACCOUNT_SID,
    TWILIO_AUTH_TOKEN,
    TWILIO_WHATSAPP_FROM,
    SITE_URL,
    CRON_SECRET
  } = process.env;

  // Basic config checks
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY ||
      !TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_WHATSAPP_FROM) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: "Server not configured" }) };
  }

  try {
    // Auth: require our secret token
    const params = event.queryStringParameters || {};
    const token = (params.token || "").trim();
    if (!CRON_SECRET || token !== CRON_SECRET) {
      return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: "Unauthorized" }) };
    }

    // kind=plan|log|weekly_parent (we'll start with plan)
    const kind = (params.kind || "plan").toLowerCase();

    // 1) Load profiles (service role — server-side only)
    const profRes = await fetch(`${SUPABASE_URL}/rest/v1/profiles?select=user_id,full_name,meher_phone,parent_phone,tz,daily_opt_in,weekly_parent_opt_in`, {
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`
      }
    });
    if (!profRes.ok) {
      const t = await profRes.text();
      return { statusCode: profRes.status, headers: CORS, body: JSON.stringify({ error: "profiles fetch failed", detail: t }) };
    }
    const profiles = await profRes.json();

    // 2) Choose recipients + message
    let rows = [];
    if (kind === "plan") {
      // Daily: Meher’s phone if opted-in
      for (const p of profiles) {
        if (!p.daily_opt_in) continue;
        const to = (p.meher_phone || "").trim();
        if (!to.startsWith("+")) continue; // must be E.164
        const msg = `⏰ Quick nudge: Please plan tomorrow by 22:00.\nOpen the app: ${SITE_URL || ""}`;
        rows.push({ to, msg });
      }
    } else if (kind === "log") {
      for (const p of profiles) {
        if (!p.daily_opt_in) continue;
        const to = (p.meher_phone || "").trim();
        if (!to.startsWith("+")) continue;
        const msg = `📝 Reminder: Please log today's study by 23:00.\nOpen the app: ${SITE_URL || ""}`;
        rows.push({ to, msg });
      }
    } else if (kind === "weekly_parent") {
      for (const p of profiles) {
        if (!p.weekly_parent_opt_in) continue;
        const to = (p.parent_phone || "").trim();
        if (!to.startsWith("+")) continue;
        const msg = `📊 Weekly summary is ready. Open the dashboard: ${SITE_URL || ""}`;
        rows.push({ to, msg });
      }
    } else {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "Unknown kind" }) };
    }

    if (!rows.length) {
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, sent: 0, reason: "no recipients" }) };
    }

    // 3) Send via Twilio
    const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");
    let sent = 0, errors = [];

    for (const r of rows) {
      const params = new URLSearchParams();
      params.append("From", TWILIO_WHATSAPP_FROM);      // e.g. whatsapp:+1...
      params.append("To", `whatsapp:${r.to}`);
      params.append("Body", r.msg);

      const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`;
      const res = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
        body: params.toString(),
      });
      const j = await res.json().catch(()=> ({}));
      if (res.ok) sent++; else errors.push({ to: r.to, error: j.message || res.statusText });
    }

    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, kind, attempted: rows.length, sent, errors }) };
  } catch (e) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: e.message || "Server error" }) };
  }
};
