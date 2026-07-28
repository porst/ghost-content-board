#!/usr/bin/env node
// Runs on a schedule (see .github/workflows/topic-scheduler.yml). Uses Claude's
// web_search tool to find current Taiwan spirituality/folklore/exorcism/wealth
// discourse, generates 5-8 new content topics, and appends them to the
// `topics` array embedded in topic-board.html.
import Anthropic from "@anthropic-ai/sdk";
import fs from "node:fs";
import path from "node:path";
import { extractArrayBlock, replaceArrayBlock } from "../lib/board.mjs";

const ROOT = process.cwd();
const HTML_PATH = path.join(ROOT, "topic-board.html");
const STATE_PATH = path.join(ROOT, "automation", "state.json");
const CYCLE_DAYS = 21;

// "commentary"（同業評論型）is a distinct research *source*, not just a
// content angle: it comes from monitoring what other 宮廟/靈性工作者/KOL
// publish on social platforms (e.g. IG), rather than from general public
// discourse. Any future research-automation step that watches trend sources
// (PTT/Dcard/Threads, etc.) should treat "monitor competitor/peer social
// posts" as an equally first-class source feeding this type.
const TYPE_LABELS = {
  explosive: "爆發型",
  trust: "信任型",
  crossover: "身份交叉",
  commentary: "同業評論型",
};

function readState() {
  if (!fs.existsSync(STATE_PATH)) return { lastRunDate: null };
  return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
}

function writeState(state) {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + "\n");
}

function daysSince(dateStr) {
  const then = new Date(dateStr + "T00:00:00Z").getTime();
  return (Date.now() - then) / (1000 * 60 * 60 * 24);
}

function setOutput(name, value) {
  const file = process.env.GITHUB_OUTPUT;
  if (file) fs.appendFileSync(file, `${name}=${value}\n`);
}

function buildPrompt(existingTitles) {
  const today = new Date().toISOString().slice(0, 10);
  const avoidList = existingTitles.length
    ? `\n\n已經在主題庫裡的標題（請勿重複或高度相似）：\n${existingTitles.map((t) => `- ${t}`).join("\n")}`
    : "";

  const system = `你是「鬼磕頭」的內容策略顧問。鬼磕頭是一位同時具備代書與靈性服務背景的內容創作者，內容聚焦台灣靈性、民俗禁忌、驅邪、收驚、招財等主題，語氣鐵口直斷、務實、不誇大，擅長用專業角度拆解常見迷信與習俗。

你的任務：使用網路搜尋工具，找出目前台灣網路上與「靈性 / 民俗 / 驅邪 / 招財」相關的熱門話題與趨勢，來源包括：
- Threads、Dcard、新聞、命理媒體、一般社群討論
- 其他宮廟、靈性工作者、同業 KOL 在社群（例如 IG）上發布的儀式/觀點內容，這類內容適合作為「同業評論型」主題的素材

然後產出 5 到 8 個適合鬼磕頭發揮的內容主題。

輸出規則（非常重要，請嚴格遵守）：
- 你的最終回覆整體只能是一個 JSON 陣列本身：第一個字元必須是 \`[\`，最後一個字元必須是 \`]\`。
- 前面不能加任何過渡句或說明，例如「已蒐集足夠依據，以下輸出主題 JSON」這類句子絕對不要出現。後面也不能加任何結語。
- 不要使用 markdown code fence（不要用 \`\`\`json 包起來）。
- 如果你需要跟自己確認資訊蒐集得夠不夠、要不要多搜尋幾輪，這些思考都只能放在 thinking 裡，最終文字回覆只留 JSON 陣列。
- 陣列中每個物件必須包含以下欄位：
  - "title": 字串，繁體中文標題
  - "type": 字串，必須是 "explosive"（爆發型）、"trust"（信任型）、"crossover"（身份交叉）或 "commentary"（同業評論型，針對其他宮廟/靈性工作者/KOL發布內容的專業回應與差異化觀點）其中之一
  - "why": 字串，說明這個主題為什麼現在熱門（盡量引用你搜尋到的具體依據）
  - "angle": 字串，建議鬼磕頭應該怎麼切入這個主題
  - "tags": 字串陣列，2 到 4 個簡短標籤
  - "script": 陣列，剛好 4 個物件，每個物件有 "q"（問題方向的標籤，例如「開場問題」「追問方向1」「追問方向2」「收尾引導」）與 "a"（實際訪談問題文字）
- 不要包含 "id" 或 "status" 欄位，這些會由系統自動加上。`;

  const user = `今天是 ${today}（台灣）。請搜尋近期台灣靈性/民俗/驅邪/招財相關的熱門話題，並產出 5 到 8 個新的內容主題。${avoidList}

再次提醒：搜尋與思考都完成後，直接輸出 JSON 陣列本身，不要加任何開場白（例如「已蒐集足夠依據」）或結語。`;

  return { system, user };
}

function stripCodeFence(text) {
  const trimmed = text.trim();
  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return fenceMatch ? fenceMatch[1] : trimmed;
}

// The prompt asks Claude to output the JSON array and nothing else, but it
// has occasionally prefaced the array with a stray transition sentence (e.g.
// "已蒐集足夠依據，以下輸出主題 JSON。"), which makes the overall text fail
// JSON.parse even though the array itself is well-formed. Rather than
// discarding an otherwise-good batch of topics over one wayward sentence,
// locate the first top-level `[...]` block — skipping over string contents
// so a `]` inside a title/answer doesn't end the scan early — and parse just
// that. Returns null if no balanced bracket pair is found at all.
function extractJsonArray(text) {
  const start = text.indexOf("[");
  if (start === -1) return null;

  let depth = 0;
  let inString = null;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") {
        i++;
        continue;
      }
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inString = ch;
      continue;
    }
    if (ch === "[") depth++;
    else if (ch === "]") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

async function generateTopics(client, existingTitles) {
  const { system, user } = buildPrompt(existingTitles);
  const messages = [{ role: "user", content: user }];

  let finalMessage;
  for (let i = 0; i < 4; i++) {
    const stream = client.messages.stream({
      model: "claude-opus-4-8",
      max_tokens: 8000,
      system,
      thinking: { type: "adaptive" },
      output_config: { effort: "high" },
      tools: [{ type: "web_search_20260209", name: "web_search" }],
      messages,
    });
    finalMessage = await stream.finalMessage();
    if (finalMessage.stop_reason !== "pause_turn") break;
    // Server-side tool loop hit its iteration limit — resume automatically.
    messages.push({ role: "assistant", content: finalMessage.content });
  }

  if (finalMessage.stop_reason === "refusal") {
    throw new Error("Claude declined the request (stop_reason: refusal).");
  }

  const textBlocks = finalMessage.content.filter((b) => b.type === "text");
  if (textBlocks.length === 0) {
    throw new Error("No text content in Claude's response.");
  }
  const raw = stripCodeFence(textBlocks[textBlocks.length - 1].text);

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (firstErr) {
    const extracted = extractJsonArray(raw);
    if (!extracted) {
      throw new Error(
        `Failed to parse JSON from Claude's response: ${firstErr.message}\n---\n${raw}`,
      );
    }
    try {
      parsed = JSON.parse(extracted);
    } catch (secondErr) {
      throw new Error(
        `Failed to parse JSON from Claude's response, even after extracting what looked like the array body: ${secondErr.message}\n---\n${raw}`,
      );
    }
    const discarded = (raw.slice(0, raw.indexOf(extracted)) + raw.slice(raw.indexOf(extracted) + extracted.length)).trim();
    console.warn(
      `Claude's response had extra text outside the JSON array; recovered by extracting the array and discarding: ${JSON.stringify(discarded)}`,
    );
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("Claude's response was not a non-empty JSON array.");
  }

  const REQUIRED_FIELDS = ["title", "type", "why", "angle", "tags", "script"];
  for (const item of parsed) {
    const missing = REQUIRED_FIELDS.filter((f) => !(f in item));
    if (missing.length) {
      throw new Error(
        `Generated topic is missing fields: ${missing.join(", ")} — ${JSON.stringify(item)}`,
      );
    }
    if (!TYPE_LABELS[item.type]) {
      throw new Error(`Generated topic has invalid type "${item.type}": ${item.title}`);
    }
  }

  return parsed;
}

async function main() {
  const state = readState();
  // Manual workflow_dispatch runs always execute — the 21-day gate only
  // throttles the scheduled cron trigger.
  const isManualTrigger = process.env.GITHUB_EVENT_NAME === "workflow_dispatch";
  if (!isManualTrigger && state.lastRunDate && daysSince(state.lastRunDate) < CYCLE_DAYS) {
    console.log(
      `Last run was ${daysSince(state.lastRunDate).toFixed(1)} days ago; waiting for the ${CYCLE_DAYS}-day cycle.`,
    );
    setOutput("generated", "false");
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set.");
  const client = new Anthropic({ apiKey });

  const html = fs.readFileSync(HTML_PATH, "utf8");
  const topicsBlock = extractArrayBlock(html, "topics");
  if (!topicsBlock) throw new Error("Could not find `const topics = ` in topic-board.html");
  const existingTopics = topicsBlock.value;
  const existingTitles = existingTopics.map((t) => t.title);

  const newTopicsRaw = await generateTopics(client, existingTitles);

  let nextId = existingTopics.reduce((max, t) => Math.max(max, t.id || 0), 0) + 1;
  const newTopics = newTopicsRaw.map((t) => ({
    id: nextId++,
    title: t.title,
    type: t.type,
    typeLabel: TYPE_LABELS[t.type],
    why: t.why,
    angle: t.angle,
    tags: t.tags,
    status: "pending",
    script: t.script,
  }));

  const mergedTopics = [...existingTopics, ...newTopics];
  const newHtml = replaceArrayBlock(html, "topics", mergedTopics, topicsBlock);
  fs.writeFileSync(HTML_PATH, newHtml);

  writeState({ lastRunDate: new Date().toISOString().slice(0, 10) });

  console.log(`Added ${newTopics.length} new topics.`);
  setOutput("generated", "true");
  setOutput("count", String(newTopics.length));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
