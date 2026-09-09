/**
 * STORY-001 — Classify and Prioritize Support Requests.
 * Extended by STORY-008 (Classification Learning) with a bounded, explicitly
 * human-gated exception to this module's own determinism principle — see the
 * "Approved classification overrides" section below.
 *
 * Deterministic, rule-based classification. Per CLAUDE.md's core principle
 * ("LLMs are probabilistic. Production systems must be deterministic."), this
 * does NOT call a model — it matches keyword signals against fixed tables so
 * the same input always yields the same output and behavior is auditable.
 *
 * This module only classifies and summarizes. It does not approve, act, send,
 * or persist anything (that's STORY-002 / STORY-003) — see R4 in
 * src/guardrail.js for the boundary that governs restricted actions.
 *
 * Approved classification overrides (STORY-008): src/data/approvedClassificationRules.json
 * holds a small, human-approved keyword -> category table, populated ONLY by
 * applyApprovedClassificationRule() below, which is itself only ever called
 * after a human approves a rule-change suggestion (src/reviewSuggestedRule.js,
 * wired through auditedActions.js's reviewSuggestedRuleAndLog). Nothing in
 * this repo writes that file automatically from repeated corrections alone —
 * src/classificationCorrections.js's checkForSuggestedRule() only ever
 * proposes. classifySupportRequest() reads that file (sync, so this function
 * stays synchronous for every existing caller) and, when a request contains
 * an approved keyword, assigns its category directly, bypassing the static
 * signal tables for category only — priority detection is unaffected. This
 * is still fully deterministic (same file contents -> same output) and still
 * never self-updating on its own; a human approves every entry. flagged
 * explicitly because architecture/layers-and-boundaries.md's Part V scored
 * this module's "Adaptive" dimension "Not Met, by design" before this
 * change — that verdict is now stale and may be worth revisiting, though
 * updating that doc is out of scope here unless asked.
 *
 * @typedef {'power_bi_report_issue'|'data_issue'|'access_permission_issue'|
 *   'sql_database_issue'|'login_problem'|'technical_question'|
 *   'general_support_request'} Category
 *
 * @typedef {'low'|'medium'|'high'|'urgent'} Priority
 *
 * @typedef {Object} ClassificationResult
 * @property {Category} category
 * @property {Priority} priority
 * @property {string} summary
 * @property {string[]} matchedSignals   Keyword signals that drove the decision (for review/audit).
 * @property {Object} logEntry           Structured, stdout-log-shaped record of this decision
 *                                        (Observability Framework shape). Not persisted here —
 *                                        persistent audit trail storage is STORY-003.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Default location of the approved classification overrides (STORY-008). */
export const APPROVED_RULES_PATH = new URL('./data/approvedClassificationRules.json', import.meta.url);

/** The only categories this assistant may assign. Order also breaks match-count ties. */
export const CATEGORIES = [
  'login_problem',
  'access_permission_issue',
  'power_bi_report_issue',
  'sql_database_issue',
  'data_issue',
  'technical_question',
  'general_support_request',
];

/** The only priority levels this assistant may assign. */
export const PRIORITIES = ['low', 'medium', 'high', 'urgent'];

/** Default when no category signal matches — never leave a request unclassified. */
const DEFAULT_CATEGORY = 'general_support_request';

/** Default when no priority signal matches — never leave a request unprioritized. */
const DEFAULT_PRIORITY = 'medium';

/** Keyword signals per category. Substring match against lowercased request text. */
const CATEGORY_SIGNALS = {
  login_problem: [
    'log in', 'login', 'log-in', 'sign in', 'signin', 'locked out', 'locked account',
    'password', 'mfa', '2fa', 'two-factor', 'authentication failed', "can't log",
    'cannot log',
  ],
  access_permission_issue: [
    'access', 'permission', 'unauthorized', 'not authorized', 'grant access',
    'need access', 'access denied', 'role assignment', 'entitlement',
  ],
  power_bi_report_issue: [
    'power bi', 'powerbi', 'report', 'dashboard', 'visual', 'dataset refresh',
    'refresh failed', 'report is blank', "report won't load",
  ],
  sql_database_issue: [
    'sql', 'database', 'db connection', 'stored procedure', 'query timeout',
    'deadlock', 'table', 'query is slow', 'query failed',
  ],
  data_issue: [
    'data issue', 'data quality', 'data is missing', 'missing data', 'wrong data',
    'incorrect data', 'duplicate records', 'data mismatch', "numbers don't match",
    'data is wrong',
  ],
  technical_question: [
    'how do i', 'how to', 'question about', 'wondering how', 'can you explain',
    'what is the best way', 'is it possible to',
  ],
};

/** Keyword signals per priority tier, checked in this order: urgent, high, low. */
const PRIORITY_SIGNALS = {
  urgent: [
    'urgent', 'asap', 'as soon as possible', 'critical', 'emergency',
    'production is down', 'system is down', 'is down', 'outage', 'immediately',
    'entire team', 'all users', 'cannot work', 'blocking my work',
  ],
  high: [
    'not working', 'broken', 'failing', "can't access", 'cannot access',
    'locked out', 'error', 'blocked',
  ],
  low: [
    'no rush', 'whenever you get a chance', 'not urgent', 'low priority',
    'just curious', 'no hurry',
  ],
};

/** Max summary length before truncation, in characters. */
const SUMMARY_MAX_LENGTH = 140;

/**
 * Load the approved-override table (STORY-008). Fails closed to "no
 * overrides" on any problem (missing file, corrupt JSON, wrong shape) —
 * never throws, and never lets a bad overrides file break classification
 * itself; it just falls back to the static signal tables below. Skips any
 * rule with `revoked: true` (see revokeApprovedRule() below) so a revoked
 * rule stops matching new requests immediately — it is filtered out here,
 * not deleted from the file, so past classifications that already used it
 * are never touched or re-run.
 *
 * @param {string|URL} rulesPath
 * @returns {{ keyword: string, category: Category }[]}
 */
function loadApprovedOverrides(rulesPath) {
  try {
    if (!existsSync(rulesPath)) return [];
    const parsed = JSON.parse(readFileSync(rulesPath, 'utf8'));
    if (!parsed || !Array.isArray(parsed.rules)) return [];
    return parsed.rules.filter(
      (rule) =>
        rule !== null &&
        typeof rule === 'object' &&
        typeof rule.keyword === 'string' &&
        rule.keyword.trim() !== '' &&
        typeof rule.category === 'string' &&
        CATEGORIES.includes(rule.category) &&
        rule.revoked !== true,
    );
  } catch {
    return [];
  }
}

/**
 * @param {string} requestText
 * @param {{ keyword: string, category: Category }[]} overrides   Checked first,
 *   in file order; the first matching keyword wins. See loadApprovedOverrides.
 * @returns {{ category: Category, matchedSignals: string[], overrideApplied: boolean }}
 */
function determineCategory(requestText, overrides) {
  for (const rule of overrides) {
    if (requestText.includes(rule.keyword.toLowerCase())) {
      return { category: rule.category, matchedSignals: [rule.keyword], overrideApplied: true };
    }
  }

  let bestCategory = DEFAULT_CATEGORY;
  let bestScore = 0;
  let bestSignals = [];

  for (const category of CATEGORIES) {
    const signals = CATEGORY_SIGNALS[category];
    if (!signals) continue; // general_support_request has no signal list — it's the fallback.

    const matched = signals.filter((signal) => requestText.includes(signal));
    if (matched.length > bestScore) {
      bestScore = matched.length;
      bestCategory = category;
      bestSignals = matched;
    }
  }

  return { category: bestCategory, matchedSignals: bestSignals, overrideApplied: false };
}

/**
 * @param {string} requestText
 * @returns {{ priority: Priority, matchedSignals: string[] }}
 */
function determinePriority(requestText) {
  for (const priority of ['urgent', 'high', 'low']) {
    const matched = PRIORITY_SIGNALS[priority].filter((signal) => requestText.includes(signal));
    if (matched.length > 0) {
      return { priority, matchedSignals: matched };
    }
  }
  return { priority: DEFAULT_PRIORITY, matchedSignals: [] };
}

/**
 * Collapse whitespace and truncate to a short, human-scannable summary.
 * @param {string} rawText
 * @returns {string}
 */
function summarize(rawText) {
  const collapsed = rawText.trim().replace(/\s+/g, ' ');
  if (collapsed.length <= SUMMARY_MAX_LENGTH) return collapsed;

  const truncated = collapsed.slice(0, SUMMARY_MAX_LENGTH);
  const lastSpace = truncated.lastIndexOf(' ');
  return `${truncated.slice(0, lastSpace > 0 ? lastSpace : SUMMARY_MAX_LENGTH)}…`;
}

/**
 * Classify and prioritize a support request. Pure and idempotent: same input
 * always yields the same output, no side effects.
 *
 * @param {unknown} requestText
 * @param {{ rulesPath?: string|URL }} [options]   Override the approved-overrides file path (tests only).
 * @returns {ClassificationResult}
 */
export function classifySupportRequest(requestText, options = {}) {
  if (typeof requestText !== 'string' || requestText.trim() === '') {
    return {
      category: DEFAULT_CATEGORY,
      priority: DEFAULT_PRIORITY,
      summary: '',
      matchedSignals: [],
      logEntry: buildLogEntry({
        category: DEFAULT_CATEGORY,
        priority: DEFAULT_PRIORITY,
        summary: '',
        matchedSignals: [],
        outcome: 'failure',
        errorClass: 'ValidationError',
      }),
    };
  }

  const normalized = requestText.toLowerCase();
  const overrides = loadApprovedOverrides(options.rulesPath ?? APPROVED_RULES_PATH);
  const { category, matchedSignals: categorySignals, overrideApplied } = determineCategory(normalized, overrides);
  const { priority, matchedSignals: prioritySignals } = determinePriority(normalized);
  const summary = summarize(requestText);
  const matchedSignals = [...categorySignals, ...prioritySignals];

  return {
    category,
    priority,
    summary,
    matchedSignals,
    logEntry: buildLogEntry({ category, priority, summary, matchedSignals, outcome: 'success', overrideApplied }),
  };
}

/**
 * Build a structured, stdout-log-shaped record of a classification decision
 * (per CLAUDE.md's Observability Framework). This function only builds the
 * record — it does not write it anywhere; persistent audit trail storage is
 * STORY-003.
 *
 * @param {{ category: Category, priority: Priority, summary: string,
 *   matchedSignals: string[], outcome: 'success'|'failure', errorClass?: string,
 *   overrideApplied?: boolean }} fields
 * @returns {Object}
 */
function buildLogEntry({ category, priority, summary, matchedSignals, outcome, errorClass, overrideApplied }) {
  const entry = {
    timestamp: new Date().toISOString(),
    level: outcome === 'success' ? 'info' : 'warn',
    service: 'classify',
    event: 'support_request_classified',
    outcome,
    context: { category, priority, summary, matchedSignals, overrideApplied: overrideApplied ?? false },
  };
  if (errorClass) entry.error_class = errorClass;
  return entry;
}

/**
 * @param {{ event: string, outcome: 'success'|'failure', keyword: string|undefined,
 *   category: string|undefined, errorClass?: string, reason?: string }} fields
 * @returns {Object}
 */
function buildApplyRuleLogEntry({ event, outcome, keyword, category, errorClass, reason }) {
  const entry = {
    timestamp: new Date().toISOString(),
    level: outcome === 'success' ? 'info' : 'warn',
    service: 'classify',
    event,
    outcome,
    context: { keyword, category },
  };
  if (errorClass) entry.error_class = errorClass;
  if (reason) entry.context.reason = reason;
  return entry;
}

/**
 * Persist one approved keyword -> category override, so classifySupportRequest()
 * uses it for that keyword going forward. This is the ONLY sanctioned write
 * path for src/data/approvedClassificationRules.json — it must only ever be
 * called after a human has approved a rule-change suggestion (see
 * src/reviewSuggestedRule.js and auditedActions.js's reviewSuggestedRuleAndLog).
 * Calling it directly, without that approval step, is a misuse of this
 * function, not a safe shortcut. Upsert by keyword — approving the same
 * keyword again just overwrites its category, never duplicates. Never throws.
 *
 * @param {unknown} rule   Must have a non-empty string `keyword` and a `category`
 *   that is one of CATEGORIES.
 * @param {{ rulesPath?: string|URL }} [options]   Override the approved-overrides file path (tests only).
 * @returns {{ ok: boolean, applied: boolean, message?: string, logEntry: Object }}
 */
export function applyApprovedClassificationRule(rule, options = {}) {
  const keyword = rule && typeof rule === 'object' ? rule.keyword : undefined;
  const category = rule && typeof rule === 'object' ? rule.category : undefined;

  const isValid =
    rule !== null &&
    typeof rule === 'object' &&
    !Array.isArray(rule) &&
    typeof keyword === 'string' &&
    keyword.trim() !== '' &&
    typeof category === 'string' &&
    CATEGORIES.includes(category);

  if (!isValid) {
    return {
      ok: false,
      applied: false,
      message: 'Rule not applied: invalid keyword or category.',
      logEntry: buildApplyRuleLogEntry({
        event: 'approved_classification_rule_rejected',
        outcome: 'failure',
        keyword,
        category,
        errorClass: 'ValidationError',
        reason: 'invalid_rule',
      }),
    };
  }

  const rulesPath = options.rulesPath ?? APPROVED_RULES_PATH;

  let existingRules = [];
  try {
    if (existsSync(rulesPath)) {
      const parsed = JSON.parse(readFileSync(rulesPath, 'utf8'));
      if (parsed && Array.isArray(parsed.rules)) existingRules = parsed.rules;
    }
  } catch (error) {
    return {
      ok: false,
      applied: false,
      message: 'Rule not applied: approved-overrides file is corrupt.',
      logEntry: buildApplyRuleLogEntry({
        event: 'approved_classification_rule_apply_failed',
        outcome: 'failure',
        keyword,
        category,
        errorClass: 'RulesFileCorruptError',
        reason: error instanceof Error ? error.message : String(error),
      }),
    };
  }

  const withoutExisting = existingRules.filter(
    (existing) => !(existing && typeof existing.keyword === 'string' && existing.keyword.toLowerCase() === keyword.toLowerCase()),
  );
  const nextRules = [...withoutExisting, { keyword, category, approvedAt: new Date().toISOString() }];

  try {
    const dir = dirname(rulesPath instanceof URL ? fileURLToPath(rulesPath) : rulesPath);
    if (dir && dir !== '.' && !existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(rulesPath, JSON.stringify({ rules: nextRules }, null, 2), { encoding: 'utf8' });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const errorClass = error.code === 'EACCES' || error.code === 'EPERM' ? 'RulesAccessDeniedError' : 'RulesWriteFailedError';
    process.stderr.write(`ALERT: approved classification rule write failed: ${message}\n`);
    return {
      ok: false,
      applied: false,
      message: `Rule not applied: ${message}`,
      logEntry: buildApplyRuleLogEntry({ event: 'approved_classification_rule_apply_failed', outcome: 'failure', keyword, category, errorClass }),
    };
  }

  return {
    ok: true,
    applied: true,
    logEntry: buildApplyRuleLogEntry({ event: 'approved_classification_rule_applied', outcome: 'success', keyword, category }),
  };
}

/**
 * @param {{ event: string, outcome: 'success'|'failure', keyword: string|undefined,
 *   reason: string|undefined, reviewer: string|undefined, errorClass?: string }} fields
 * @returns {Object}
 */
function buildRevokeRuleLogEntry({ event, outcome, keyword, reason, reviewer, errorClass }) {
  const entry = {
    timestamp: new Date().toISOString(),
    level: outcome === 'success' ? 'info' : 'warn',
    service: 'classify',
    event,
    outcome,
    context: { keyword, reason, reviewer },
  };
  if (errorClass) entry.error_class = errorClass;
  return entry;
}

/**
 * Revoke a previously approved classification override. Marks the rule
 * `revoked: true` (plus `revokedAt`/`revokedBy`/`revokedReason`) rather than
 * deleting it, so approval history stays intact and classifications already
 * made using the rule are never touched or re-run — only loadApprovedOverrides()
 * changes behavior, by skipping revoked rules for requests classified from
 * this point forward. Idempotent: revoking an already-revoked rule is a
 * no-op, not an error (`ok: true, revoked: false, alreadyRevoked: true`),
 * per CLAUDE.md's idempotency mandate. Never throws.
 *
 * @param {unknown} revocation   Must have a non-empty string `keyword`, `reason`, and `reviewer`.
 * @param {{ rulesPath?: string|URL }} [options]   Override the approved-overrides file path (tests only).
 * @returns {{ ok: boolean, revoked: boolean, alreadyRevoked?: boolean, notFound?: boolean,
 *   message?: string, rule?: Object, logEntry: Object }}
 */
export function revokeApprovedRule(revocation, options = {}) {
  const keyword = revocation && typeof revocation === 'object' ? revocation.keyword : undefined;
  const reason = revocation && typeof revocation === 'object' ? revocation.reason : undefined;
  const reviewer = revocation && typeof revocation === 'object' ? revocation.reviewer : undefined;

  const isValid =
    revocation !== null &&
    typeof revocation === 'object' &&
    !Array.isArray(revocation) &&
    typeof keyword === 'string' &&
    keyword.trim() !== '' &&
    typeof reason === 'string' &&
    reason.trim() !== '' &&
    typeof reviewer === 'string' &&
    reviewer.trim() !== '';

  if (!isValid) {
    return {
      ok: false,
      revoked: false,
      message: 'Rule not revoked: invalid keyword, reason, or reviewer.',
      logEntry: buildRevokeRuleLogEntry({
        event: 'approved_classification_rule_revoke_rejected',
        outcome: 'failure',
        keyword,
        reason,
        reviewer,
        errorClass: 'ValidationError',
      }),
    };
  }

  const rulesPath = options.rulesPath ?? APPROVED_RULES_PATH;

  let existingRules = [];
  try {
    if (existsSync(rulesPath)) {
      const parsed = JSON.parse(readFileSync(rulesPath, 'utf8'));
      if (parsed && Array.isArray(parsed.rules)) existingRules = parsed.rules;
    }
  } catch (error) {
    return {
      ok: false,
      revoked: false,
      message: 'Rule not revoked: approved-overrides file is corrupt.',
      logEntry: buildRevokeRuleLogEntry({
        event: 'approved_classification_rule_revoke_failed',
        outcome: 'failure',
        keyword,
        reason,
        reviewer,
        errorClass: 'RulesFileCorruptError',
      }),
    };
  }

  const ruleIndex = existingRules.findIndex(
    (existing) => existing && typeof existing.keyword === 'string' && existing.keyword.toLowerCase() === keyword.toLowerCase(),
  );

  if (ruleIndex === -1) {
    return {
      ok: false,
      revoked: false,
      notFound: true,
      message: `Rule not revoked: no approved rule found for keyword "${keyword}".`,
      logEntry: buildRevokeRuleLogEntry({
        event: 'approved_classification_rule_revoke_failed',
        outcome: 'failure',
        keyword,
        reason,
        reviewer,
        errorClass: 'RuleNotFoundError',
      }),
    };
  }

  if (existingRules[ruleIndex].revoked === true) {
    return {
      ok: true,
      revoked: false,
      alreadyRevoked: true,
      message: `Rule not revoked: keyword "${keyword}" was already revoked.`,
      logEntry: buildRevokeRuleLogEntry({
        event: 'approved_classification_rule_revoke_duplicate',
        outcome: 'success',
        keyword,
        reason,
        reviewer,
      }),
    };
  }

  const revokedRule = {
    ...existingRules[ruleIndex],
    revoked: true,
    revokedAt: new Date().toISOString(),
    revokedBy: reviewer,
    revokedReason: reason,
  };
  const nextRules = [...existingRules];
  nextRules[ruleIndex] = revokedRule;

  try {
    const dir = dirname(rulesPath instanceof URL ? fileURLToPath(rulesPath) : rulesPath);
    if (dir && dir !== '.' && !existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(rulesPath, JSON.stringify({ rules: nextRules }, null, 2), { encoding: 'utf8' });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const errorClass = error.code === 'EACCES' || error.code === 'EPERM' ? 'RulesAccessDeniedError' : 'RulesWriteFailedError';
    process.stderr.write(`ALERT: approved classification rule revoke write failed: ${message}\n`);
    return {
      ok: false,
      revoked: false,
      message: `Rule not revoked: ${message}`,
      logEntry: buildRevokeRuleLogEntry({
        event: 'approved_classification_rule_revoke_failed',
        outcome: 'failure',
        keyword,
        reason,
        reviewer,
        errorClass,
      }),
    };
  }

  return {
    ok: true,
    revoked: true,
    rule: revokedRule,
    logEntry: buildRevokeRuleLogEntry({ event: 'approved_classification_rule_revoked', outcome: 'success', keyword, reason, reviewer }),
  };
}
