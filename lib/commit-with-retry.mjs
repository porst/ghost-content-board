// Generic "read topics array, mutate it, commit" helper with a retry on a
// 409 (sha changed under us between the read and the write — e.g. two
// edits landing close together). Shared by anything that mutates the
// `topics` array in topic-board.html via the GitHub Contents API.
import { extractArrayBlock, replaceArrayBlock } from "./board.mjs";
import { fetchBoardFile, putBoardFile } from "./github-content.mjs";

const MAX_COMMIT_ATTEMPTS = 2;

// `mutate(topics)` must mutate the array in place and return a commit
// message string. Throwing from `mutate` (e.g. "topic not found") aborts
// immediately without retrying, since that's not a conflict that a fresh
// fetch would resolve. Returns the full (mutated) topics array on success.
export async function commitTopicsUpdate(githubToken, committer, mutate) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_COMMIT_ATTEMPTS; attempt++) {
    const { html, sha } = await fetchBoardFile(githubToken);
    const topicsBlock = extractArrayBlock(html, "topics");
    if (!topicsBlock) throw new Error("`const topics = ` not found in topic-board.html");

    const commitMessage = mutate(topicsBlock.value);

    const updatedHtml = replaceArrayBlock(html, "topics", topicsBlock.value, topicsBlock);
    const putRes = await putBoardFile(githubToken, updatedHtml, sha, commitMessage, committer);
    if (putRes.ok) return topicsBlock.value;
    if (putRes.status === 409 && attempt < MAX_COMMIT_ATTEMPTS) {
      lastError = new Error("stale sha, retrying");
      continue;
    }
    throw new Error(`GitHub commit failed: ${putRes.status} ${await putRes.text()}`);
  }
  throw lastError || new Error("Failed to commit after retries.");
}
