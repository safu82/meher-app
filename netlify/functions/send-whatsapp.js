// netlify/functions/send-whatsapp.js
exports.handler = async (event) => {
  // CORS (optional)
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: cors };
  }
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers: cors, body: "Method Not Allowed" };
  }

  try {
    const auth = event.headers.authorization || "";
    if (!auth.startsWith("Bearer ")) {
      return { statusCode: 401, headers: cors, body: JSON.stringify({ error: "Missing auth token" }) };
    }
    const accessToken = auth.slice("Bearer ".length);

    // Required env vars
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
    const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
    const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
    const TWILIO_WHATSAPP_FROM = process.env.TWILIO_WHATSAPP_FROM;

    if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_WHATSAPP_FROM) {
      return { statusCode: 500, headers: cors, body: JSON.stringify({ error: "Server not configured" }) };
    }

    // 1) Read the caller’s profile via Supabase REST with the user’s JWT (RLS-safe)
    const profRes = await fetch(`${SUPABASE_URL}/rest/v1/profiles?select=*&limit=1`, {
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${accessToken}`, // authenticates as the signed-in user
      },
    });
    if (!profRes.ok) {
      return { statusCode: profRes.status, headers: cors, body: JSON.stringify({ error: "Profile fetch failed" }) };
    }
    const profArr = await profRes.json();
    const prof = profArr[0];
    if (!prof) {
      return { statusCode: 400, headers: cors, body: JSON.stringify({ error: "No profile found for this user" }) };
    }

    // Pick destination number: prefer Meher’s, else parent’s
    const toNumber = (prof.meher_phone || prof.parent_phone || "").trim();
    if (!toNumber.startsWith("+")) {
      return { statusCode: 400, headers: cors, body: JSON.stringify({ error: "No E.164 phone in profile" }) };
    }

    // 2) Send WhatsApp via Twilio REST
    // Twilio expects application/x-www-form-urlencoded
    const params = new URLSearchParams();
    params.append("From", TWILIO_WHATSAPP_FROM);       // e.g. whatsapp:+1...
    params.append("To", `whatsapp:${toNumber}`);       // to must be whatsapp:+CCNNNN...
    params.append("Body", "Hello from Meher Study App 👋 This is a test.");

    const twilioUrl = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`;
    const basicAuth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");

    const twRes = await fetch(twilioUrl, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basicAuth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });

    const twJson = await twRes.json();
    if (!twRes.ok) {
      return { statusCode: twRes.status, headers: cors, body: JSON.stringify({ error: twJson.message || "Twilio error" }) };
    }

    return {
      statusCode: 200,
      headers: { ...cors, "Content-Type": "application/json" },
      body: JSON.stringify({ ok: true, to: toNumber, sid: twJson.sid }),
    };
  } catch (e) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: e.message || "Server error" }) };
  }
};
