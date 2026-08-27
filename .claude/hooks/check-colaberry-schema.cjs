#!/usr/bin/env node
/**
 * PostToolUse hook: after any Edit/Write/NotebookEdit that touches
 * .colaberry/plan.json or .colaberry/progress.json, cross-validate the two
 * files against each other and re-check progress.json's totals arithmetic.
 *
 * This exists because that drift has already shipped once and gone
 * unnoticed until it broke something downstream: commit 5968beb had to
 * restore STORY-005/006 verification data lost when progress.json was
 * "accidentally reverted to its STORY-004 state", and fill in a missing
 * points_awarded so totals arithmetic was internally consistent again.
 * Nothing caught that at write time — it was only found later. This hook
 * is that catch, applied on every future edit to either file.
 */
const fs = require("fs");
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

function isColaberryFile(targetPath, cwd, name) {
  if (!targetPath) return false;
  const absolute = path.isAbsolute(targetPath) ? targetPath : path.resolve(cwd, targetPath);
  const relative = path.relative(cwd, absolute).split(path.sep).join("/");
  return relative === `.colaberry/${name}`;
}

function readJson(cwd, relPath) {
  const abs = path.resolve(cwd, relPath);
  if (!fs.existsSync(abs)) return { error: `${relPath} does not exist` };
  try {
    return { value: JSON.parse(fs.readFileSync(abs, "utf8")) };
  } catch (err) {
    return { error: `${relPath} is not valid JSON: ${err.message}` };
  }
}

function validate(plan, progress) {
  const problems = [];

  if (
    plan.schema_version !== undefined &&
    progress.schema_version !== undefined &&
    plan.schema_version !== progress.schema_version
  ) {
    problems.push(
      `schema_version mismatch: plan.json is ${plan.schema_version}, progress.json is ${progress.schema_version}.`
    );
  }

  const planStories = Array.isArray(plan.stories) ? plan.stories : [];
  const progressStories = Array.isArray(progress.stories) ? progress.stories : [];
  const planById = new Map(planStories.map((s) => [s.id, s]));
  const progressById = new Map(progressStories.map((s) => [s.id, s]));

  // Only check plan -> progress. A story existing in progress.json with no
  // match in plan.json (e.g. STORY-000, a meta-story about the Command
  // Center tooling itself, tracked only in progress.json + docs/stories/)
  // is legitimate and not the drift this hook guards against. A story that
  // plan.json expects but progress.json has silently dropped is the
  // dangerous direction — that's exactly what commit 5968beb had to repair.
  for (const id of planById.keys()) {
    if (!progressById.has(id)) {
      problems.push(`${id} exists in plan.json but has no entry in progress.json.`);
    }
  }

  for (const [id, planStory] of planById) {
    const progressStory = progressById.get(id);
    if (!progressStory) continue;

    const planAcceptance = Array.isArray(planStory.acceptance) ? planStory.acceptance : [];
    const progressCriteria = Array.isArray(progressStory.criteria) ? progressStory.criteria : [];

    if (planAcceptance.length !== progressCriteria.length) {
      problems.push(
        `${id}: plan.json has ${planAcceptance.length} acceptance criteria but progress.json has ` +
          `${progressCriteria.length} criteria entries.`
      );
    } else {
      progressCriteria.forEach((c, i) => {
        if (c.text !== planAcceptance[i]) {
          problems.push(`${id}: criteria[${i}].text in progress.json doesn't match plan.json's acceptance[${i}].`);
        }
      });
    }

    const v = progressStory.verification || {};
    const passedCount = progressCriteria.filter((c) => c.passed === true).length;

    if (typeof v.criteria_total === "number" && v.criteria_total !== progressCriteria.length) {
      problems.push(
        `${id}: verification.criteria_total (${v.criteria_total}) != criteria.length (${progressCriteria.length}).`
      );
    }
    if (typeof v.criteria_passed === "number" && v.criteria_passed !== passedCount) {
      problems.push(
        `${id}: verification.criteria_passed (${v.criteria_passed}) != count of criteria with passed:true (${passedCount}).`
      );
    }
    if (v.state === "verified") {
      if (passedCount !== progressCriteria.length) {
        problems.push(`${id}: verification.state is "verified" but not every criterion has passed:true.`);
      }
      if (Array.isArray(v.outstanding) && v.outstanding.length > 0) {
        problems.push(`${id}: verification.state is "verified" but outstanding is non-empty.`);
      }
    }
  }

  const totals = progress.totals || {};
  const expected = {
    stories_total: progressStories.length,
    stories_verified: progressStories.filter((s) => s.verification && s.verification.state === "verified").length,
    stories_submitted: progressStories.filter((s) => s.verification && s.verification.state === "submitted").length,
    stories_in_progress: progressStories.filter((s) => s.verification && s.verification.state === "in_progress")
      .length,
    stories_not_started: progressStories.filter(
      (s) => !s.verification || s.verification.state === "not_started"
    ).length,
    criteria_total: progressStories.reduce((sum, s) => sum + (s.acceptance_total || 0), 0),
    criteria_passed: progressStories.reduce(
      (sum, s) => sum + ((s.verification && s.verification.criteria_passed) || 0),
      0
    ),
    points_awarded: progressStories.reduce(
      (sum, s) => sum + ((s.verification && s.verification.points_awarded) || 0),
      0
    ),
  };

  for (const [key, expectedValue] of Object.entries(expected)) {
    if (typeof totals[key] === "number" && totals[key] !== expectedValue) {
      problems.push(`totals.${key} is ${totals[key]} but the stories[] array implies ${expectedValue}.`);
    }
  }

  return problems;
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
  const touchesColaberry =
    isColaberryFile(targetPath, cwd, "plan.json") || isColaberryFile(targetPath, cwd, "progress.json");
  if (!guarded.includes(toolName) || !touchesColaberry) {
    process.exit(0);
  }

  const planResult = readJson(cwd, ".colaberry/plan.json");
  const progressResult = readJson(cwd, ".colaberry/progress.json");

  const problems = [];
  if (planResult.error) problems.push(planResult.error);
  if (progressResult.error) problems.push(progressResult.error);
  if (!planResult.error && !progressResult.error) {
    problems.push(...validate(planResult.value, progressResult.value));
  }

  if (problems.length === 0) {
    process.exit(0);
  }

  const reason =
    `.colaberry/plan.json and .colaberry/progress.json are out of sync (this is the drift class that ` +
    `broke the Command Center in commit 2fedfc8 and had to be repaired in 5968beb):\n` +
    problems.map((p) => `- ${p}`).join("\n") +
    `\n\nFix these before continuing. If you're mid-way through /mark-verified, finish recomputing ` +
    `the totals block from stories[] rather than hand-editing individual numbers.`;

  process.stdout.write(
    JSON.stringify({
      decision: "block",
      reason,
    })
  );
  process.exit(0);
})();
