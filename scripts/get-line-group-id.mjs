#!/usr/bin/env node
// Temporary utility: run this, expose it publicly (e.g. `ngrok http 3000`),
// point your LINE channel's webhook URL at it, then send any message in the
// group. It logs the Group ID to the console and replies with it in the
// group so you don't even need to check the logs. Delete this script (and
// remove the webhook URL / revert it) once you've got the ID.
//
// Usage:
//   LINE_CHANNEL_SECRET=xxx LINE_CHANNEL_ACCESS_TOKEN=yyy node scripts/get-line-group-id.mjs
//
// No dependencies — uses only Node's built-in http/crypto modules.
import http from "node:http";
import crypto from "node:crypto";

const CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const PORT = process.env.PORT || 3000;

if (!CHANNEL_SECRET) {
  throw new Error("LINE_CHANNEL_SECRET is not set.");
}
if (!CHANNEL_ACCESS_TOKEN) {
  throw new Error("LINE_CHANNEL_ACCESS_TOKEN is not set.");
}

function verifySignature(rawBody, signatureHeader) {
  if (!signatureHeader) return false;
  const expected = crypto
    .createHmac("sha256", CHANNEL_SECRET)
    .update(rawBody)
    .digest("base64");
  // Both are base64 strings of the same fixed length (SHA-256 -> 44 chars),
  // so timingSafeEqual is safe to use directly here.
  const a = Buffer.from(expected);
  const b = Buffer.from(signatureHeader);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function replyText(replyToken, text) {
  const res = await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}`,
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

const server = http.createServer((req, res) => {
  if (req.method !== "POST") {
    res.writeHead(404).end();
    return;
  }

  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", async () => {
    const rawBody = Buffer.concat(chunks);

    if (!verifySignature(rawBody, req.headers["x-line-signature"])) {
      console.error("Signature verification failed — check LINE_CHANNEL_SECRET.");
      res.writeHead(401).end();
      return;
    }

    // Always 200 immediately (LINE's webhook-verify test sends an empty
    // events array and expects a fast 200).
    res.writeHead(200).end();

    let body;
    try {
      body = JSON.parse(rawBody.toString("utf8"));
    } catch {
      return;
    }

    for (const event of body.events || []) {
      const { type: sourceType, groupId, roomId, userId } = event.source || {};
      console.log("--- incoming event ---");
      console.log("source type:", sourceType);
      if (groupId) console.log("Group ID:", groupId);
      if (roomId) console.log("Room ID:", roomId);
      if (userId) console.log("User ID:", userId);

      if (event.type === "message" && event.replyToken && groupId) {
        await replyText(event.replyToken, `這個群組的 Group ID 是：\n${groupId}`);
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`Listening on http://localhost:${PORT}`);
  console.log("Expose this publicly (e.g. `ngrok http " + PORT + "`) and set it as the webhook URL in the LINE Developers Console.");
});
