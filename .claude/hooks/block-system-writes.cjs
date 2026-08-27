#!/usr/bin/env node
/**
 * PreToolUse hook: denies Edit/Write/NotebookEdit calls that target the
 * top-level /system directory. /system is portal-owned and auto-generated
 * (see root CLAUDE.md "Folder Responsibilities" -> /system: "DO NOT manually
 * edit"). Manual edits get silently overwritten by the portal and cause
 * drift, so this is enforced here instead of relying on the model
 * remembering the rule every session.
 */
const path = require("path");

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

function isUnderTopLevelSystemDir(targetPath, cwd) {
  if (!targetPath) return false;
  const absolute = path.isAbsolute(targetPath)
    ? targetPath
    : path.resolve(cwd, targetPath);
  const relative = path.relative(cwd, absolute).split(path.sep).join("/");
  return relative === "system" || relative.startsWith("system/");
}

(async () => {
  let input;
  try {
    input = JSON.parse(await readStdin());
  } catch {
    process.exit(0);
  }

  const toolName = input.tool_name;
  const toolInput = input.tool_input || {};
  const targetPath = toolInput.file_path || toolInput.notebook_path;
  const cwd = process.cwd();

  const guarded = ["Edit", "Write", "NotebookEdit"];
  if (!guarded.includes(toolName) || !isUnderTopLevelSystemDir(targetPath, cwd)) {
    process.exit(0);
  }

  const reason =
    `Blocked: "${targetPath}" is inside the top-level /system directory, ` +
    `which is portal-owned and auto-generated (state_graph.json, ` +
    `database_map.json, ui_map.json, and everything else under /system). ` +
    `Per the root CLAUDE.md "Folder Responsibilities" section (and ` +
    `system/CLAUDE.md where it exists): "DO NOT manually edit." A manual ` +
    `write here will be silently overwritten by the next portal sync and ` +
    `cause state drift. If /system genuinely needs to change, that change ` +
    `belongs in the portal, not in this repo.`;

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    })
  );
  process.exit(0);
})();
