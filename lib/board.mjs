// Pure, dependency-free helpers for reading/writing the `const topics = [...]`
// and `const unsorted = [...]` array literals embedded in topic-board.html.
//
// No Node-specific APIs (fs, path, Buffer) — this module is imported both by
// scripts/generate-topics.mjs (Node, runs in GitHub Actions) and by
// api/line-webhook.js (Vercel Edge Runtime, a V8 isolate with only Web APIs),
// so it has to work in both.

// Scans forward from `const {varName} = ` to find the matching closing
// bracket of the array literal, respecting string literals so a `]` inside a
// quoted string doesn't end the scan early. Returns null if the variable
// isn't declared in this html at all.
export function extractArrayBlock(html, varName) {
  const marker = `const ${varName} = `;
  const start = html.indexOf(marker);
  if (start === -1) return null;

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
  // The literal uses unquoted JS object-literal keys (not strict JSON), and
  // this is our own trusted file content, so `new Function` evaluation is
  // safe here.
  const value = new Function(`return (${arrayText});`)();
  const semiIndex = html.indexOf(";", i);
  return { value, blockStart: start, blockEnd: semiIndex + 1 };
}

// Replaces the `const {varName} = [...]` block (as located by
// extractArrayBlock) with a freshly serialized version of `value`. Only
// touches this one block — safe to call once per html string, but if you
// need to update two different array blocks in the same html, re-extract
// the second block's positions from the *new* html returned here (the
// original block's indices are invalidated once the text length changes).
export function replaceArrayBlock(html, varName, value, block) {
  const literal = JSON.stringify(value, null, 2);
  return (
    html.slice(0, block.blockStart) +
    `const ${varName} = ${literal};` +
    html.slice(block.blockEnd)
  );
}
