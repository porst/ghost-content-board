// Version-history helper for a topic's 訪談大綱 (script). Never overwrites —
// every AI regeneration or manual edit is appended as a new entry in
// `topic.scriptVersions`, and `topic.script` is kept in sync with whichever
// version is latest (the rest of the codebase — rendering, LINE feedback —
// only ever reads `topic.script`, so this keeps that contract unchanged).

function nextVersionLabel(existingVersions) {
  return existingVersions.length === 0 ? "原始版本" : `修訂版本${existingVersions.length}`;
}

// source: "ai" | "manual"
export function pushScriptVersion(topic, { script, source }) {
  if (!Array.isArray(topic.scriptVersions) || topic.scriptVersions.length === 0) {
    // First time this topic is touched by the versioning system — seed
    // history with whatever script it already had, so nothing is lost.
    topic.scriptVersions = [
      {
        label: "原始版本",
        source: "original",
        script: topic.script,
        createdAt: null,
      },
    ];
  }

  topic.scriptVersions.push({
    label: nextVersionLabel(topic.scriptVersions),
    source,
    script,
    createdAt: new Date().toISOString(),
  });

  topic.script = script;
}
