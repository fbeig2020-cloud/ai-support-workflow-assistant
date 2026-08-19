/**
 * STORY-001 — Classify and Prioritize Support Requests.
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
 * @param {string} requestText
 * @returns {{ category: Category, matchedSignals: string[] }}
 */
function determineCategory(requestText) {
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

  return { category: bestCategory, matchedSignals: bestSignals };
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
 * @returns {ClassificationResult}
 */
export function classifySupportRequest(requestText) {
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
  const { category, matchedSignals: categorySignals } = determineCategory(normalized);
  const { priority, matchedSignals: prioritySignals } = determinePriority(normalized);
  const summary = summarize(requestText);
  const matchedSignals = [...categorySignals, ...prioritySignals];

  return {
    category,
    priority,
    summary,
    matchedSignals,
    logEntry: buildLogEntry({ category, priority, summary, matchedSignals, outcome: 'success' }),
  };
}

/**
 * Build a structured, stdout-log-shaped record of a classification decision
 * (per CLAUDE.md's Observability Framework). This function only builds the
 * record — it does not write it anywhere; persistent audit trail storage is
 * STORY-003.
 *
 * @param {{ category: Category, priority: Priority, summary: string,
 *   matchedSignals: string[], outcome: 'success'|'failure', errorClass?: string }} fields
 * @returns {Object}
 */
function buildLogEntry({ category, priority, summary, matchedSignals, outcome, errorClass }) {
  const entry = {
    timestamp: new Date().toISOString(),
    level: outcome === 'success' ? 'info' : 'warn',
    service: 'classify',
    event: 'support_request_classified',
    outcome,
    context: { category, priority, summary, matchedSignals },
  };
  if (errorClass) entry.error_class = errorClass;
  return entry;
}
