// Vercel Edge Function: batch-saves the board's "狀態" (status) and "拍攝梯次"
// (shooting batch) fields back to topic-board.html. Called from the board's
// "儲存變更" button — the page lets you freely adjust several cards'
// status/batch in the browser first, then this endpoint commits the full
// current snapshot in one shot, instead of writing back on every dropdown
// change. Same auth/CORS contract as update-script.js.
//
// Env vars required: GITHUB_PAT, BOARD_EDIT_TOKEN.
import { commitBoardUpdate } from "../lib/commit-with-retry.mjs";
import { checkRequestAuth, jsonResponse } from "../lib/api-helpers.mjs";

export const config = { runtime: "edge" };

const COMMITTER = {
  name: "board-state-bot",
  email: "board-state-bot@users.noreply.github.com",
};

const VALID_STATUSES = new Set(["pending", "selected", "shot", "posted", "archived"]);

function isValidBatches(batches) {
  return (
    Array.isArray(batches) &&
    batches.every(
      (b) => b && Number.isInteger(b.id) && typeof b.name === "string" && b.name.trim().length > 0,
    )
  );
}

function isValidTopicUpdates(updates) {
  return (
    Array.isArray(updates) &&
    updates.length > 0 &&
    updates.every(
      (u) =>
        u &&
        Number.isInteger(u.id) &&
        VALID_STATUSES.has(u.status) &&
        (u.batchId === null || Number.isInteger(u.batchId)),
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

  const topicUpdates = body.topics;
  const batches = body.batches;

  if (!isValidTopicUpdates(topicUpdates)) {
    return jsonResponse(
      { error: "topics must be a non-empty array of {id, status, batchId} entries" },
      400,
    );
  }
  if (!isValidBatches(batches)) {
    return jsonResponse({ error: "batches must be an array of {id, name}" }, 400);
  }

  const batchIds = new Set(batches.map((b) => b.id));
  for (const u of topicUpdates) {
    if (u.batchId !== null && !batchIds.has(u.batchId)) {
      return jsonResponse({ error: `batchId ${u.batchId} on topic #${u.id} matches no batch` }, 400);
    }
  }

  let result;
  try {
    result = await commitBoardUpdate(githubToken, COMMITTER, ["topics", "batches"], (values) => {
      for (const u of topicUpdates) {
        const topic = values.topics.find((t) => t.id === u.id);
        if (!topic) throw new Error(`Topic #${u.id} not found`);
        topic.status = u.status;
        topic.batchId = u.batchId;
      }
      values.batches.length = 0;
      values.batches.push(...batches);
      return "Board update: save status/shooting-batch changes";
    });
  } catch (err) {
    console.error("save-board-state: commit failed:", err);
    return jsonResponse({ error: String(err.message || err) }, 500);
  }

  return jsonResponse({ topics: result.topics, batches: result.batches });
}
