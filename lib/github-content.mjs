// Shared GitHub Contents API client for reading/writing topic-board.html.
// Used by every Edge Function that needs to commit to the board (the LINE
// feedback webhook, AI script regeneration, manual script edits).
//
// No Node-specific APIs — safe on Vercel's Edge Runtime as well as in
// plain Node.

const REPO_OWNER = "porst";
const REPO_NAME = "ghost-content-board";
const REPO_BRANCH = "main";
const FILE_PATH = "topic-board.html";
const FETCH_TIMEOUT_MS = 8000;

// Every outbound call goes through this so a stalled request fails fast
// instead of eating the whole function's execution budget silently — a
// bare fetch() that never resolves is how a FUNCTION_INVOCATION_TIMEOUT
// with zero completed requests happens.
export async function fetchWithTimeout(url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error(`Request to ${url} timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
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

export async function fetchBoardFile(githubToken) {
  const res = await fetchWithTimeout(
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

export async function putBoardFile(githubToken, html, sha, message, committer) {
  return fetchWithTimeout(
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
        committer,
      }),
    },
  );
}
