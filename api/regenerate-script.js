// Vercel Node.js Serverless Function (NOT Edge) — regenerates a topic's
// 訪談大綱 (interview script) using Claude, taking the topic's accumulated
// LINE feedback into account. Called directly from topic-board.html's
// "根據回饋重新生成" button.
//
// This deliberately does NOT set `export const config = { runtime: "edge" }`
// (Node.js is the default when that's omitted). @anthropic-ai/sdk pulls in
// node:fs / node:path internally, which the Edge Runtime's V8 isolate
// doesn't support at all -- deploying this on Edge failed with "The Edge
// Function ... is referencing unsupported modules: @anthropic-ai: node:fs,
// node:path". Node.js's runtime has full support for those, so this is the
// fix, rather than dropping the official SDK for raw HTTP (the other two
// Edge Functions in this project, api/line-webhook.js and
// api/update-script.js, don't touch the SDK and stay on Edge).
//
// Node.js Functions use the classic (req, res) handler shape, not the Web
// Fetch API Request/Response used by the Edge Functions elsewhere in this
// project -- hence the local corsHeaders/sendJson helpers below instead of
// lib/api-helpers.mjs (which is Request/Response-shaped and still used by
// update-script.js).
//
// Env vars required: ANTHROPIC_API_KEY, GITHUB_PAT, BOARD_EDIT_TOKEN.
import Anthropic from "@anthropic-ai/sdk";
import { extractArrayBlock } from "../lib/board.mjs";
import { fetchBoardFile } from "../lib/github-content.mjs";
import { commitTopicsUpdate } from "../lib/commit-with-retry.mjs";
import { pushScriptVersion } from "../lib/script-versions.mjs";
import { ALLOWED_ORIGIN } from "../lib/api-helpers.mjs";

const REQUIRED_SCRIPT_FIELDS = ["q", "a"];
const COMMITTER = {
  name: "ai-script-regen-bot",
  email: "ai-script-regen-bot@users.noreply.github.com",
};

function setCorsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Board-Token");
}

function sendJson(res, status, body) {
  res.status(status).json(body);
}

// @vercel/node auto-parses req.body for a JSON content-type, but guard
// against it arriving as a raw string (or missing) anyway.
function parseBody(req) {
  if (req.body == null) return null;
  if (typeof req.body === "string") {
    try {
      return JSON.parse(req.body);
    } catch {
      return null;
    }
  }
  return req.body;
}

function stripCodeFence(text) {
  const trimmed = text.trim();
  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return fenceMatch ? fenceMatch[1] : trimmed;
}

function buildPrompt(topic) {
  const feedbackList = (topic.feedback || []).length
    ? topic.feedback.map((f, i) => `${i + 1}. [${f.sender}] ${f.text}`).join("\n")
    : "（目前尚無回饋）";

  const system = `你是「鬼磕頭」的內容策略顧問。鬼磕頭是一位同時具備代書與靈性服務背景的內容創作者，內容聚焦台灣靈性、民俗禁忌、驅邪、收驚、招財等主題，語氣鐵口直斷、務實、不誇大，擅長用專業角度拆解常見迷信與習俗。

你的任務：根據這個主題的原始資料，以及觀眾在 LINE 群組留下的實際回饋，重新設計一版訪談大綱，讓切角更貼近觀眾真正在意或質疑的點，而不是重複原本的內容。

輸出規則：
- 只能輸出一個 JSON 陣列，不要有任何其他文字、說明或 markdown code fence。
- 陣列必須剛好包含 4 個物件，依序對應：
  - {"q": "開場問題", "a": 字串}
  - {"q": "追問方向1", "a": 字串}
  - {"q": "追問方向2", "a": 字串}
  - {"q": "收尾引導", "a": 字串}`;

  const user = `主題標題：${topic.title}
為什麼現在熱：${topic.why}
建議切角：${topic.angle}

觀眾在 LINE 群組留下的回饋：
${feedbackList}

請根據以上資訊，重新產生一版訪談大綱。`;

  return { system, user };
}

async function generateScript(client, topic) {
  const { system, user } = buildPrompt(topic);

  const response = await client.messages.create(
    {
      model: "claude-opus-4-8",
      max_tokens: 2000,
      system,
      thinking: { type: "adaptive" },
      output_config: { effort: "medium" },
      messages: [{ role: "user", content: user }],
    },
    // Adaptive thinking + a "medium" effort budget can comfortably take
    // longer than 20s, which is what caused APIConnectionTimeoutError in
    // production. Keep this comfortably under vercel.json's maxDuration (60s)
    // for this function, so the SDK's own error surfaces before Vercel kills
    // the invocation outright.
    { timeout: 55000 },
  );

  if (response.stop_reason === "refusal") {
    throw new Error("Claude declined the request (stop_reason: refusal).");
  }

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock) throw new Error("No text content in Claude's response.");

  const raw = stripCodeFence(textBlock.text);
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Failed to parse JSON from Claude's response: ${err.message}`);
  }
  if (!Array.isArray(parsed) || parsed.length !== 4) {
    throw new Error("Claude did not return exactly 4 script items.");
  }
  for (const item of parsed) {
    const missing = REQUIRED_SCRIPT_FIELDS.filter((f) => !(f in item));
    if (missing.length) throw new Error(`Script item missing fields: ${missing.join(", ")}`);
  }
  return parsed;
}

export default async function handler(req, res) {
  setCorsHeaders(res);

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }

  const githubToken = process.env.GITHUB_PAT;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const boardToken = process.env.BOARD_EDIT_TOKEN;
  if (!githubToken || !anthropicKey || !boardToken) {
    console.error("Missing GITHUB_PAT, ANTHROPIC_API_KEY, or BOARD_EDIT_TOKEN env var.");
    sendJson(res, 500, { error: "Server not configured" });
    return;
  }

  if (req.headers["x-board-token"] !== boardToken) {
    sendJson(res, 401, { error: "Unauthorized" });
    return;
  }

  const body = parseBody(req);
  const topicId = Number(body?.topicId);
  if (!Number.isInteger(topicId)) {
    sendJson(res, 400, { error: "topicId is required" });
    return;
  }

  // 1. Read the topic's current data to build the prompt from.
  let topicSnapshot;
  try {
    const { html } = await fetchBoardFile(githubToken);
    const topicsBlock = extractArrayBlock(html, "topics");
    if (!topicsBlock) throw new Error("`const topics = ` not found in topic-board.html");
    topicSnapshot = topicsBlock.value.find((t) => t.id === topicId);
    if (!topicSnapshot) {
      sendJson(res, 404, { error: `Topic #${topicId} not found` });
      return;
    }
  } catch (err) {
    console.error("regenerate-script: failed to read board:", err);
    sendJson(res, 500, { error: String(err.message || err) });
    return;
  }

  // 2. Generate the new script.
  let newScript;
  try {
    const client = new Anthropic({ apiKey: anthropicKey });
    newScript = await generateScript(client, topicSnapshot);
  } catch (err) {
    console.error("regenerate-script: Claude generation failed:", err);
    sendJson(res, 500, { error: String(err.message || err) });
    return;
  }

  // 3. Commit as a new version. Re-reads fresh content (so this doesn't
  //    clobber a concurrent feedback message or edit); retries once on a
  //    sha conflict.
  let updatedTopic;
  try {
    const topics = await commitTopicsUpdate(githubToken, COMMITTER, (topics) => {
      const topic = topics.find((t) => t.id === topicId);
      if (!topic) throw new Error(`Topic #${topicId} disappeared before commit`);
      pushScriptVersion(topic, { script: newScript, source: "ai" });
      return `AI regenerate script for topic #${topicId}`;
    });
    updatedTopic = topics.find((t) => t.id === topicId);
  } catch (err) {
    console.error("regenerate-script: commit failed:", err);
    sendJson(res, 500, { error: String(err.message || err) });
    return;
  }

  sendJson(res, 200, { topic: updatedTopic });
}
