// Vercel Edge Function for the LINE group bot. Two responsibilities that
// coexist in the same webhook:
//
// 1. Group ID capture (original purpose) — logs source type / group / room /
//    user IDs for every incoming event. Useful whenever the bot is added to
//    a new group and you need its ID. The old auto-reply-with-Group-ID
//    behavior is now OFF by default (set LINE_REPLY_WITH_GROUP_ID=true to
//    restore it) — leaving it on would mean every real feedback message also
//    gets a "這個群組的 Group ID 是..." reply, which defeats the point of (2).
//
// 2. Feedback capture — for text messages, looks for a "#<number>" tag. If
//    present and it matches an existing topic id, the message (with sender
//    display name + timestamp) is appended to that topic's `feedback` array
//    in topic-board.html. Otherwise (no tag, or the tagged id doesn't match
//    any topic) it's appended to the top-level `unsorted` array instead.
//    Both cases commit + push to topic-board.html via the GitHub Contents
//    API (there's no local git checkout to shell out to from an Edge
//    Function), so this needs a GITHUB_PAT env var — a token with Contents:
//    Read and write access to this repo.
//
// Env vars required: LINE_CHANNEL_SECRET, LINE_CHANNEL_ACCESS_TOKEN, GITHUB_PAT.
// Optional: LINE_REPLY_WITH_GROUP_ID=true to restore the old auto-reply.
//
// Runs on Vercel's Edge Runtime (Web APIs only, no Node "crypto"/"fs"/Buffer),
// so signature verification uses SubtleCrypto and base64 (de)coding uses
// atob/btoa + TextEncoder/TextDecoder.
import { extractArrayBlock, replaceArrayBlock } from "../lib/board.mjs";

export const config = { runtime: "edge" };

const REPO_OWNER = "porst";
const REPO_NAME = "ghost-content-board";
const REPO_BRANCH = "main";
const FILE_PATH = "topic-board.html";
const MAX_COMMIT_ATTEMPTS = 3;

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

async function getGroupMemberDisplayName(accessToken, groupId, userId) {
  try {
    const res = await fetch(
      `https://api.line.me/v2/bot/group/${groupId}/member/${userId}`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    if (!res.ok) return userId;
    const data = await res.json();
    return data.displayName || userId;
  } catch {
    return userId;
  }
}

// GitHub's Contents API returns file content as base64 of the raw UTF-8
// bytes — plain atob() would mangle the Traditional Chinese text (it treats
// each decoded byte as a Latin-1 code point). Route through TextDecoder /
// TextEncoder instead.
function base64ToUtf8(base64) {
  const binary = atob(base64.replace(/\n/g, ""));
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder("utf-8").decode(bytes);
}

function utf8ToBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

async function fetchBoardFile(githubToken) {
  const res = await fetch(
    `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${FILE_PATH}?ref=${REPO_BRANCH}`,
    {
      headers: {
        Authorization: `Bearer ${githubToken}`,
        Accept: "application/vnd.github+json",
      },
    },
  );
  if (!res.ok) {
    throw new Error(`GitHub fetch failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  return { html: base64ToUtf8(data.content), sha: data.sha };
}

async function putBoardFile(githubToken, html, sha, message) {
  return fetch(
    `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${FILE_PATH}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${githubToken}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message,
        content: utf8ToBase64(html),
        sha,
        branch: REPO_BRANCH,
        committer: {
          name: "line-feedback-bot",
          email: "line-feedback-bot@users.noreply.github.com",
        },
      }),
    },
  );
}

// Appends feedbackEntry to topic `topicId`'s feedback array, or to the
// top-level `unsorted` array if topicId is null or doesn't match any topic.
// Re-fetches on a 409 (sha changed under us — e.g. two feedback messages
// landing close together) and retries with the fresh content.
async function appendFeedback(githubToken, { topicId, feedbackEntry }) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_COMMIT_ATTEMPTS; attempt++) {
    const { html, sha } = await fetchBoardFile(githubToken);

    let updatedHtml = null;
    let commitMessage = "";

    if (topicId != null) {
      const topicsBlock = extractArrayBlock(html, "topics");
      if (!topicsBlock) throw new Error("`const topics = ` not found in topic-board.html");
      const topic = topicsBlock.value.find((t) => t.id === topicId);
      if (topic) {
        topic.feedback = Array.isArray(topic.feedback) ? topic.feedback : [];
        topic.feedback.push(feedbackEntry);
        updatedHtml = replaceArrayBlock(html, "topics", topicsBlock.value, topicsBlock);
        commitMessage = `LINE feedback: append to topic #${topicId}`;
      }
    }

    if (!updatedHtml) {
      const unsortedBlock = extractArrayBlock(html, "unsorted");
      if (!unsortedBlock) throw new Error("`const unsorted = ` not found in topic-board.html");
      unsortedBlock.value.push(feedbackEntry);
      updatedHtml = replaceArrayBlock(html, "unsorted", unsortedBlock.value, unsortedBlock);
      commitMessage =
        topicId != null
          ? `LINE feedback: #${topicId} not found, append to unsorted`
          : "LINE feedback: append to unsorted discussion";
    }

    const putRes = await putBoardFile(githubToken, updatedHtml, sha, commitMessage);
    if (putRes.ok) return;
    if (putRes.status === 409 && attempt < MAX_COMMIT_ATTEMPTS) {
      lastError = new Error("stale sha, retrying");
      continue;
    }
    throw new Error(`GitHub commit failed: ${putRes.status} ${await putRes.text()}`);
  }
  throw lastError || new Error("Failed to commit feedback after retries.");
}

async function handleFeedbackMessage(event, { channelAccessToken, githubToken }) {
  const { groupId, userId } = event.source || {};
  const text = event.message.text;
  const match = text.match(/#(\d+)/);
  const topicId = match ? Number(match[1]) : null;

  const sender =
    groupId && userId
      ? await getGroupMemberDisplayName(channelAccessToken, groupId, userId)
      : userId || "未知使用者";

  const feedbackEntry = {
    text,
    sender,
    time: new Date(event.timestamp).toISOString(),
  };

  await appendFeedback(githubToken, { topicId, feedbackEntry });
}

export default async function handler(request) {
  if (request.method !== "POST") {
    return new Response("Not found", { status: 404 });
  }

  const channelSecret = process.env.LINE_CHANNEL_SECRET;
  const channelAccessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  const githubToken = process.env.GITHUB_PAT;
  const replyWithGroupId = process.env.LINE_REPLY_WITH_GROUP_ID === "true";
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

    if (event.type === "message" && event.message?.type === "text") {
      if (!githubToken) {
        console.error("Missing GITHUB_PAT env var — cannot record feedback.");
      } else {
        try {
          await handleFeedbackMessage(event, { channelAccessToken, githubToken });
        } catch (err) {
          console.error("Failed to record feedback:", err);
        }
      }
    }

    if (event.type === "message" && event.replyToken && groupId && replyWithGroupId) {
      await replyText(channelAccessToken, event.replyToken, `這個群組的 Group ID 是：\n${groupId}`);
    }
  }

  return new Response("OK", { status: 200 });
}
