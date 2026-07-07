#!/usr/bin/env node
// Sends a LINE Messaging API push notification pointing at the topic board.
const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const targetId = process.env.LINE_TARGET_ID;
const count = process.env.TOPIC_COUNT || "";
const boardUrl = "https://porst.github.io/ghost-content-board/topic-board.html";

if (!token || !targetId) {
  throw new Error("LINE_CHANNEL_ACCESS_TOKEN or LINE_TARGET_ID is not set.");
}

const text = `🔮 鬼磕頭內容主題管理板已更新${count ? `，新增 ${count} 個主題` : ""}！\n${boardUrl}`;

const res = await fetch("https://api.line.me/v2/bot/message/push", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  },
  body: JSON.stringify({
    to: targetId,
    messages: [{ type: "text", text }],
  }),
});

if (!res.ok) {
  const body = await res.text();
  throw new Error(`LINE push failed: ${res.status} ${body}`);
}

console.log("LINE notification sent.");
