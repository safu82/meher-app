// log-actual.js  (NO <script> tags in this file)
(() => {
  // TODO: put your real anon key here
  const ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJ5ZW9ubWRtenNjenJnc3phYXRjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTY1NjYwMTUsImV4cCI6MjA3MjE0MjAxNX0.sPXg-enI268EthpIfKF_tsZT1JqgITsQxVuqJaEzZ_Y";
  // Must match the EDGE_APP_KEY you set via `supabase secrets set EDGE_APP_KEY=...`
  const APP_KEY  = "supersecret_123";

  const EDGE_URL = "https://ryeonmdmzsczrgszaatc.functions.supabase.co/log-actual";
  const MEHER_USER_ID = "4da1c43e-fb17-4cec-8162-64fc6dcd8b0d";

  async function logActual({ userId = MEHER_USER_ID, subjectId, durationMin, startMin, endMin, iso, planId, topic }) {
    if (!subjectId) throw new Error("subjectId is required");
    const hasBlock = Number.isFinite(startMin) && Number.isFinite(endMin);
    const hasDuration = Number.isFinite(durationMin);
    if (!hasBlock && !hasDuration) throw new Error("Provide durationMin OR startMin+endMin");

    const payload = {
      user_id: userId,
      subject_id: subjectId,
      ...(iso ? { iso } : {}),
      ...(planId ? { plan_id: planId } : {}),
      ...(topic ? { topic } : {}),
      ...(hasBlock
        ? { start_min: Math.floor(startMin), end_min: Math.floor(endMin) }
        : { duration_min: Math.floor(durationMin) }),
    };

    const res = await fetch(EDGE_URL, {
      method: "POST",
      headers: {
        "x-app-key": APP_KEY,
        "Content-Type": "application/json",
        "Authorization": "Bearer " + ANON_KEY,
        "apikey": ANON_KEY,
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`log-actual failed (${res.status}): ${txt}`);
    }
    return res.json();
  }

  // expose globally
  window.logActual = logActual;
})();
