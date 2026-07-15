// Shared plumbing for the browser-facing Edge Functions (regenerate-script,
// update-script) that topic-board.html calls directly from client-side JS.
//
// The board is a public static page with no login, so these endpoints are
// otherwise unauthenticated and reachable by anyone who finds the URL —
// hence the X-Board-Token check (a shared secret, not real user auth, but
// enough to stop casual/drive-by hits against an endpoint that both costs
// money (Claude) and can rewrite repo content).

// The board is served from GitHub Pages at this origin. Scoped narrowly
// (not "*") as basic hygiene, though note this doesn't substitute for the
// token check below — CORS only restricts browser-based cross-site
// requests, not a direct curl/script hitting the endpoint.
export const ALLOWED_ORIGIN = "https://porst.github.io";

export function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Board-Token",
  };
}

export function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}

export function preflightResponse() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

// Returns a Response to send immediately if the request should be rejected
// (wrong method, missing config, bad token), or null if it's OK to proceed.
export function checkRequestAuth(request, requiredEnvVars) {
  if (request.method === "OPTIONS") return preflightResponse();
  if (request.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  for (const [name, value] of Object.entries(requiredEnvVars)) {
    if (!value) {
      console.error(`Missing ${name} env var.`);
      return jsonResponse({ error: "Server not configured" }, 500);
    }
  }

  if (request.headers.get("x-board-token") !== requiredEnvVars.BOARD_EDIT_TOKEN) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  return null;
}
