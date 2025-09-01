// netlify/edge-functions/protect.js
export default async (request, context) => {
  const url = new URL(request.url);

  // Let Netlify functions and internal paths pass through (cron, Twilio, etc.)
  if (url.pathname.startsWith("/.netlify/")) {
    return context.next();
  }

  const USER = Netlify.env.get("BASIC_AUTH_USER") || "";
  const PASS = Netlify.env.get("BASIC_AUTH_PASS") || "";

  // If not configured, don't block
  if (!USER || !PASS) return context.next();

  const auth = request.headers.get("authorization") || "";
  if (auth.startsWith("Basic ")) {
    const [u, p] = atob(auth.slice(6)).split(":");
    if (u === USER && p === PASS) {
      return context.next(); // allow
    }
  }

  // Ask browser for credentials
  return new Response("Authentication required", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="Meher Study App"' }
  });
};
