// Vercel Edge Function: saves a manually-edited 訪談大綱 (interview script)
// as a new version. Called directly from topic-board.html's "儲存" button
// (after "編輯" mode). Same auth/CORS contract as regenerate-script.js, just
// without the Claude call — purely a text update, recorded as a "manual"
// version so it's never confused with (or silently replaces) an AI-authored
// one.
//
// Env vars required: GITHUB_PAT, BOARD_EDIT_TOKEN.
import { commitTopicsUpdate } from "../lib/commit-with-retry.mjs";
import { pushScriptVersion } from "../lib/script-versions.mjs";
import { checkRequestAuth, jsonResponse } from "../lib/api-helpers.mjs";

export const config = { runtime: "edge" };

const COMMITTER = {
  name: "manual-script-edit-bot",
  email: "manual-script-edit-bot@users.noreply.github.com",
};

function isValidScript(script) {
  return (
    Array.isArray(script) &&
    script.length === 4 &&
    script.every(
      (item) =>
        item &&
        typeof item.q === "string" &&
        item.q.trim().length > 0 &&
        typeof item.a === "string" &&
        item.a.trim().length > 0,
    )
  );
}

export default async function handler(request) {
  const githubToken = process.env.GITHUB_PAT;
  const boardToken = process.env.BOARD_EDIT_TOKEN;

  const authResponse = checkRequestAuth(request, {
    GITHUB_PAT: githubToken,
    BOARD_EDIT_TOKEN: boardToken,
  });
  if (authResponse) return authResponse;

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const topicId = Number(body.topicId);
  if (!Number.isInteger(topicId)) {
    return jsonResponse({ error: "topicId is required" }, 400);
  }
  if (!isValidScript(body.script)) {
    return jsonResponse(
      { error: "script must be an array of 4 {q, a} items, each with non-empty text" },
      400,
    );
  }

  let updatedTopic;
  try {
    const topics = await commitTopicsUpdate(githubToken, COMMITTER, (topics) => {
      const topic = topics.find((t) => t.id === topicId);
      if (!topic) throw new Error(`Topic #${topicId} not found`);
      pushScriptVersion(topic, { script: body.script, source: "manual" });
      return `Manual edit: script for topic #${topicId}`;
    });
    updatedTopic = topics.find((t) => t.id === topicId);
  } catch (err) {
    console.error("update-script: commit failed:", err);
    return jsonResponse({ error: String(err.message || err) }, 500);
  }

  return jsonResponse({ topic: updatedTopic });
}
