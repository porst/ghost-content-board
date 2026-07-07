#!/usr/bin/env node
// Runs on a schedule (see .github/workflows/topic-scheduler.yml). Uses Claude's
// web_search tool to find current Taiwan spirituality/folklore/exorcism/wealth
// discourse, generates 5-8 new content topics, and appends them to the
// `topics` array embedded in topic-board.html.
import Anthropic from "@anthropic-ai/sdk";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const HTML_PATH = path.join(ROOT, "topic-board.html");
const STATE_PATH = path.join(ROOT, "automation", "state.json");
const CYCLE_DAYS = 21;

const TYPE_LABELS = {
  explosive: "爆發型",
  trust: "信任型",
  crossover: "身份交叉",
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

// Extract the `const topics = [ ... ];` array literal from topic-board.html
// via string-literal-aware bracket scanning. The file is our own trusted repo
// content, so evaluating the extracted literal with `new Function` is safe
// (it uses unquoted JS object-literal keys, not strict JSON).
function extractTopicsBlock(html) {
  const marker = "const topics = ";
  const start = html.indexOf(marker);
  if (start === -1) {
    throw new Error("Could not find `const topics = ` in topic-board.html");
  }
  const arrayStart = start + marker.length;
  let depth = 0;
  let inString = null;
  let i = arrayStart;
  for (; i < html.length; i++) {
    const ch = html[i];
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
      if (depth === 0) {
        i++;
        break;
      }
    }
  }
  const arrayText = html.slice(arrayStart, i);
  const topics = new Function(`return (${arrayText});`)();
  const semiIndex = html.indexOf(";", i);
  return { topics, blockStart: start, blockEnd: semiIndex + 1 };
}

function buildPrompt(existingTitles) {
  const today = new Date().toISOString().slice(0, 10);
  const avoidList = existingTitles.length
    ? `\n\n已經在主題庫裡的標題（請勿重複或高度相似）：\n${existingTitles.map((t) => `- ${t}`).join("\n")}`
    : "";

  const system = `你是「鬼磕頭」的內容策略顧問。鬼磕頭是一位同時具備代書與靈性服務背景的內容創作者，內容聚焦台灣靈性、民俗禁忌、驅邪、收驚、招財等主題，語氣鐵口直斷、務實、不誇大，擅長用專業角度拆解常見迷信與習俗。

你的任務：使用網路搜尋工具，找出目前台灣網路上（Threads、Dcard、新聞、命理媒體、社群等）與「靈性 / 民俗 / 驅邪 / 招財」相關的熱門話題與趨勢，然後產出 5 到 8 個適合鬼磕頭發揮的內容主題。

輸出規則：
- 只能輸出一個 JSON 陣列，不要有任何其他文字、說明或 markdown code fence。
- 陣列中每個物件必須包含以下欄位：
  - "title": 字串，繁體中文標題
  - "type": 字串，必須是 "explosive"（爆發型）、"trust"（信任型）或 "crossover"（身份交叉）其中之一
  - "why": 字串，說明這個主題為什麼現在熱門（盡量引用你搜尋到的具體依據）
  - "angle": 字串，建議鬼磕頭應該怎麼切入這個主題
  - "tags": 字串陣列，2 到 4 個簡短標籤
  - "script": 陣列，剛好 4 個物件，每個物件有 "q"（問題方向的標籤，例如「開場問題」「追問方向1」「追問方向2」「收尾引導」）與 "a"（實際訪談問題文字）
- 不要包含 "id" 或 "status" 欄位，這些會由系統自動加上。`;

  const user = `今天是 ${today}（台灣）。請搜尋近期台灣靈性/民俗/驅邪/招財相關的熱門話題，並產出 5 到 8 個新的內容主題。${avoidList}`;

  return { system, user };
}

function stripCodeFence(text) {
  const trimmed = text.trim();
  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return fenceMatch ? fenceMatch[1] : trimmed;
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
  } catch (err) {
    throw new Error(
      `Failed to parse JSON from Claude's response: ${err.message}\n---\n${raw}`,
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
  if (state.lastRunDate && daysSince(state.lastRunDate) < CYCLE_DAYS) {
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
  const { topics: existingTopics, blockStart, blockEnd } = extractTopicsBlock(html);
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
  const arrayLiteral = JSON.stringify(mergedTopics, null, 2);
  const newHtml =
    html.slice(0, blockStart) + `const topics = ${arrayLiteral};` + html.slice(blockEnd);
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
