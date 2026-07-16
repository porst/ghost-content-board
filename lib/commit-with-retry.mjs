// Generic "read one or more array blocks, mutate them, commit" helper with a
// retry on a 409 (sha changed under us between the read and the write — e.g.
// two edits landing close together). Shared by anything that mutates the
// `topics` / `batches` array literals in topic-board.html via the GitHub
// Contents API.
import { extractArrayBlock, replaceArrayBlock } from "./board.mjs";
import { fetchBoardFile, putBoardFile } from "./github-content.mjs";

const MAX_COMMIT_ATTEMPTS = 2;

// `mutate(values)` must mutate the arrays in place (values is
// `{ [blockName]: array }`) and return a commit message string. Throwing
// from `mutate` (e.g. "topic not found") aborts immediately without
// retrying, since that's not a conflict that a fresh fetch would resolve.
// Returns the full (mutated) `{ [blockName]: array }` on success.
export async function commitBoardUpdate(githubToken, committer, blockNames, mutate) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_COMMIT_ATTEMPTS; attempt++) {
    const { html, sha } = await fetchBoardFile(githubToken);

    const blocks = {};
    const values = {};
    for (const name of blockNames) {
      const block = extractArrayBlock(html, name);
      if (!block) throw new Error(`\`const ${name} = \` not found in topic-board.html`);
      blocks[name] = block;
      values[name] = block.value;
    }

    const commitMessage = mutate(values);

    // Each replaceArrayBlock call shifts every later offset in the html, so
    // blocks after the first must be re-located against the html it just
    // produced rather than reusing the original (now stale) positions.
    let updatedHtml = html;
    for (const name of blockNames) {
      const block = extractArrayBlock(updatedHtml, name);
      updatedHtml = replaceArrayBlock(updatedHtml, name, values[name], block);
    }

    const putRes = await putBoardFile(githubToken, updatedHtml, sha, commitMessage, committer);
    if (putRes.ok) return values;
    if (putRes.status === 409 && attempt < MAX_COMMIT_ATTEMPTS) {
      lastError = new Error("stale sha, retrying");
      continue;
    }
    throw new Error(`GitHub commit failed: ${putRes.status} ${await putRes.text()}`);
  }
  throw lastError || new Error("Failed to commit after retries.");
}

// `mutate(topics)` must mutate the array in place and return a commit
// message string. Returns the full (mutated) topics array on success.
export async function commitTopicsUpdate(githubToken, committer, mutate) {
  const values = await commitBoardUpdate(githubToken, committer, ["topics"], (values) =>
    mutate(values.topics),
  );
  return values.topics;
}
