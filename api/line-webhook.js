// Vercel Edge Function — temporary utility to capture a LINE Group ID.
// Deploy this repo to Vercel, set LINE_CHANNEL_SECRET + LINE_CHANNEL_ACCESS_TOKEN
// as environment variables, point the LINE channel's webhook URL at
// https://<your-project>.vercel.app/api/line-webhook, then send any message in
// the group. Check the function's logs (Vercel dashboard -> project -> Logs)
// for the printed Group ID, and the bot also replies with it in-group.
//
// Runs on Vercel's Edge Runtime (Web APIs only, no Node "crypto" module), so
// signature verification uses SubtleCrypto instead of node:crypto.
export const config = { runtime: "edge" };

async function hmacSha256Base64(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return btoa(String.fromCharCode(...new Uint8Array(signature)));
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

async function replyText(accessToken, replyToken, text) {
  const res = await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      replyToken,
      messages: [{ type: "text", text }],
    }),
  });
  if (!res.ok) {
    console.error("LINE reply failed:", res.status, await res.text());
  }
}

export default async function handler(request) {
  if (request.method !== "POST") {
    return new Response("Not found", { status: 404 });
  }

  const channelSecret = process.env.LINE_CHANNEL_SECRET;
  const channelAccessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!channelSecret || !channelAccessToken) {
    console.error("Missing LINE_CHANNEL_SECRET or LINE_CHANNEL_ACCESS_TOKEN env var.");
    return new Response("Server not configured", { status: 500 });
  }

  const rawBody = await request.text();
  const signature = request.headers.get("x-line-signature") || "";
  const expected = await hmacSha256Base64(channelSecret, rawBody);

  if (!timingSafeEqual(signature, expected)) {
    console.error("Signature verification failed — check LINE_CHANNEL_SECRET.");
    return new Response("Invalid signature", { status: 401 });
  }

  let body;
  try {
    body = JSON.parse(rawBody);
  } catch {
    // LINE's webhook-verify test can send a non-JSON/empty body — still 200.
    return new Response("OK", { status: 200 });
  }

  for (const event of body.events || []) {
    const { type: sourceType, groupId, roomId, userId } = event.source || {};
    console.log("--- incoming event ---");
    console.log("source type:", sourceType);
    if (groupId) console.log("Group ID:", groupId);
    if (roomId) console.log("Room ID:", roomId);
    if (userId) console.log("User ID:", userId);

    if (event.type === "message" && event.replyToken && groupId) {
      await replyText(channelAccessToken, event.replyToken, `這個群組的 Group ID 是：\n${groupId}`);
    }
  }

  return new Response("OK", { status: 200 });
}
