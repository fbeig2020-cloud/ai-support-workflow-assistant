/**
 * STORY-008 — Classification Learning from Human Corrections.
 *
 * When a support agent rejects a classification (src/reviewClassification.js)
 * and supplies the correct category, that correction is worth remembering:
 * if the same keyword keeps getting misclassified the same way, the static
 * signal tables in src/classify.js are probably missing a rule. This module
 * records those corrections and, once a pattern repeats often enough,
 * proposes a rule change — it never applies one itself (REQ-008/R4's
 * "recommend, don't act" boundary applies here exactly as it does to
 * escalation and everything else in this repo).
 *
 * Deliberately does NOT call reviewClassification.js itself: that module's
 * decision shape (`{ action, reviewer, reason }`) has no field for "the
 * correct category," and extending it would mean growing a contract that 46+
 * existing tests depend on for something only this new flow needs. Instead,
 * recordClassificationCorrection() is a separate, explicit step a caller
 * takes after a reject — supplying the wrong category (from the classification
 * that was rejected) and the correct one (from the human) directly. See
 * auditedActions.js's recordClassificationCorrectionAndLog for the audited
 * wrapper.
 *
 * checkForSuggestedRule() only ever proposes: it writes a suggestion into the
 * existing ticket queue (src/ticketQueue.js, reused, not duplicated) tagged
 * `type: "suggested_rule_change"` so it's unmistakably not a student ticket.
 * A human reviews and approves/rejects it via src/reviewSuggestedRule.js;
 * only approval causes src/classify.js's applyApprovedClassificationRule()
 * to run (wired in auditedActions.js's reviewSuggestedRuleAndLog) and change
 * future classifications. Rejecting discards the suggestion — nothing about
 * classify.js changes.
 *
 * Known limitation: src/data/classificationCorrections.json is one shared
 * file, read-modify-write, unlike ticketQueue.js's one-file-per-ticket design
 * (which exists specifically to avoid this). Concurrent corrections could
 * race and lose an update. Accepted for this repo's scope — flagged here
 * rather than silently ignored.
 *
 * Failure paths handled (never throws — every branch returns a result object):
 *  - recordClassificationCorrection: malformed correction (missing/blank
 *    requestId, keyword, wrongCategory, correctCategory, or reviewer; a
 *    category not in CATEGORIES) -> fails closed, ValidationError.
 *  - recordClassificationCorrection: same requestId already recorded ->
 *    idempotent no-op (`recorded: false, duplicate: true`), not an error and
 *    not a second entry — satisfies CLAUDE.md's idempotency mandate.
 *  - recordClassificationCorrection: corrupt corrections file -> fails
 *    closed rather than risk silently discarding prior history by
 *    overwriting it with just the new entry.
 *  - recordClassificationCorrection: write fails (permission denied,
 *    unwritable path) -> fails closed, CorrectionsAccessDeniedError or
 *    CorrectionsWriteFailedError, alerted to stderr.
 *  - checkForSuggestedRule: missing corrections file -> no corrections, no
 *    suggestion (not a failure — nothing has been recorded yet).
 *  - checkForSuggestedRule: corrupt corrections file -> fails closed rather
 *    than silently analyzing as if there were zero corrections.
 *  - checkForSuggestedRule: a qualifying pattern whose queue write fails ->
 *    still reports the suggestion, but flags `queued: false` so the caller
 *    knows it didn't actually land where a human would see it.
 *
 * @typedef {Object} ClassificationCorrection
 * @property {string} requestId       The ticket this correction came from. Also the idempotency key.
 * @property {string} keyword         The specific signal a human identified as responsible for the
 *                                       wrong classification. Not inferred automatically — classify.js's
 *                                       matchedSignals mixes category and priority signals with no label
 *                                       distinguishing them, so a human names the one being corrected.
 * @property {string} wrongCategory   The category the AI originally assigned (one of classify.js's CATEGORIES).
 * @property {string} correctCategory The category the human says it should have been (one of CATEGORIES).
 * @property {string} reviewer        Non-empty. Who made the correction — required for the audit trail.
 *
 * @typedef {Object} RecordCorrectionResult
 * @property {boolean} ok
 * @property {boolean} recorded
 * @property {boolean} [duplicate]    Present and true when this requestId was already recorded.
 * @property {string} [message]       Present when recorded is false.
 * @property {Object} logEntry
 *
 * @typedef {Object} SuggestedRuleChange
 * @property {'suggested_rule_change'} type   Distinguishes this from a normal ticket shape at a glance.
 * @property {string} keyword
 * @property {string} wrongCategory
 * @property {string} correctCategory
 * @property {number} timesSeen
 * @property {string} requestId       Deterministic hash of the pattern, so re-checking upserts the
 *                                       same queue entry (via ticketQueue.js) instead of duplicating.
 * @property {string} createdAt
 *
 * @typedef {Object} CheckSuggestionsResult
 * @property {boolean} ok
 * @property {boolean} suggested
 * @property {SuggestedRuleChange[]} suggestions
 * @property {string} [message]       Present when ok is false.
 * @property {Object} logEntry
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { CATEGORIES } from './classify.js';
import { addTicketToQueue } from './ticketQueue.js';

/** Default location corrections are persisted to (STORY-008). */
export const CORRECTIONS_PATH = new URL('./data/classificationCorrections.json', import.meta.url);

/** Same pattern must recur this many separate times before a rule is suggested. */
export const SUGGESTION_THRESHOLD = 3;

/**
 * @param {string|URL} path
 * @returns {string}
 */
function dirOf(path) {
  return dirname(path instanceof URL ? fileURLToPath(path) : path);
}

/**
 * @param {{ event: string, outcome: 'success'|'failure', context: Object,
 *   errorClass?: string }} fields
 * @returns {Object}
 */
function buildLogEntry({ event, outcome, context, errorClass }) {
  const entry = {
    timestamp: new Date().toISOString(),
    level: outcome === 'success' ? 'info' : 'warn',
    service: 'classificationCorrections',
    event,
    outcome,
    context,
  };
  if (errorClass) entry.error_class = errorClass;
  return entry;
}

/**
 * @param {unknown} correction
 * @returns {boolean}
 */
function isValidCorrection(correction) {
  return (
    correction !== null &&
    typeof correction === 'object' &&
    !Array.isArray(correction) &&
    typeof correction.requestId === 'string' &&
    correction.requestId.trim() !== '' &&
    typeof correction.keyword === 'string' &&
    correction.keyword.trim() !== '' &&
    typeof correction.wrongCategory === 'string' &&
    CATEGORIES.includes(correction.wrongCategory) &&
    typeof correction.correctCategory === 'string' &&
    CATEGORIES.includes(correction.correctCategory) &&
    typeof correction.reviewer === 'string' &&
    correction.reviewer.trim() !== ''
  );
}

/**
 * Load the corrections file. Distinguishes "not created yet" (empty history,
 * not a failure) from "corrupt" (a real failure — the caller must not treat
 * corrupt data as if it were empty).
 *
 * @param {string|URL} path
 * @returns {{ ok: true, corrections: ClassificationCorrection[] } | { ok: false, message: string }}
 */
function loadCorrections(path) {
  if (!existsSync(path)) {
    return { ok: true, corrections: [] };
  }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (!parsed || !Array.isArray(parsed.corrections)) {
      return { ok: false, message: 'Corrections file is missing a corrections array.' };
    }
    return { ok: true, corrections: parsed.corrections };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `Corrections file is not valid JSON: ${message}` };
  }
}

/**
 * Record one human correction of a wrong classification. Never throws.
 * Idempotent on `requestId`: recording the same requestId twice does not
 * create a second entry.
 *
 * @param {unknown} correction
 * @param {{ correctionsPath?: string|URL }} [options]   Override the corrections file path (tests only).
 * @returns {RecordCorrectionResult}
 */
export function recordClassificationCorrection(correction, options = {}) {
  if (!isValidCorrection(correction)) {
    return {
      ok: false,
      recorded: false,
      message: 'Correction not recorded: invalid correction shape.',
      logEntry: buildLogEntry({
        event: 'classification_correction_rejected',
        outcome: 'failure',
        context: { correction },
        errorClass: 'ValidationError',
      }),
    };
  }

  const path = options.correctionsPath ?? CORRECTIONS_PATH;
  const loaded = loadCorrections(path);
  if (!loaded.ok) {
    return {
      ok: false,
      recorded: false,
      message: `Correction not recorded: ${loaded.message}`,
      logEntry: buildLogEntry({
        event: 'classification_correction_record_failed',
        outcome: 'failure',
        context: { requestId: correction.requestId },
        errorClass: 'CorrectionsFileCorruptError',
      }),
    };
  }

  const { requestId, keyword, wrongCategory, correctCategory, reviewer } = correction;
  const alreadyRecorded = loaded.corrections.some((existing) => existing.requestId === requestId);
  if (alreadyRecorded) {
    return {
      ok: true,
      recorded: false,
      duplicate: true,
      message: `Correction not recorded: requestId ${requestId} was already recorded.`,
      logEntry: buildLogEntry({
        event: 'classification_correction_duplicate',
        outcome: 'success',
        context: { requestId, keyword, wrongCategory, correctCategory, reviewer },
      }),
    };
  }

  const entry = { requestId, keyword, wrongCategory, correctCategory, reviewer, recordedAt: new Date().toISOString() };
  const nextCorrections = [...loaded.corrections, entry];

  try {
    const dir = dirOf(path);
    if (dir && dir !== '.' && !existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(path, JSON.stringify({ corrections: nextCorrections }, null, 2), { encoding: 'utf8' });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const errorClass = error.code === 'EACCES' || error.code === 'EPERM' ? 'CorrectionsAccessDeniedError' : 'CorrectionsWriteFailedError';
    process.stderr.write(`ALERT: classification correction write failed: ${message}\n`);
    return {
      ok: false,
      recorded: false,
      message: `Correction not recorded: ${message}`,
      logEntry: buildLogEntry({
        event: 'classification_correction_record_failed',
        outcome: 'failure',
        context: { requestId, keyword, wrongCategory, correctCategory, reviewer },
        errorClass,
      }),
    };
  }

  return {
    ok: true,
    recorded: true,
    correction: entry,
    logEntry: buildLogEntry({
      event: 'classification_correction_recorded',
      outcome: 'success',
      context: { requestId, keyword, wrongCategory, correctCategory, reviewer },
    }),
  };
}

/**
 * A short, filename-safe, deterministic id for a (keyword, wrongCategory,
 * correctCategory) pattern — so checkForSuggestedRule() upserts the same
 * ticket-queue entry (via ticketQueue.js's existing upsert-by-requestId
 * behavior) on every recheck instead of creating a duplicate, and so raw
 * keywords containing characters ticketQueue's SAFE_TICKET_ID would reject
 * (spaces, apostrophes — e.g. "can't log") never reach it directly.
 *
 * @param {string} keyword
 * @param {string} wrongCategory
 * @param {string} correctCategory
 * @returns {string}
 */
function suggestionRequestId(keyword, wrongCategory, correctCategory) {
  const hash = createHash('sha256').update(`${keyword.toLowerCase()}|${wrongCategory}|${correctCategory}`, 'utf8').digest('hex');
  return `rule-suggestion-${hash.slice(0, 16)}`;
}

/**
 * Check the recorded corrections for a keyword -> correctCategory pattern
 * that has recurred at least SUGGESTION_THRESHOLD separate times, and — for
 * every such pattern found — queue a `suggested_rule_change` proposal
 * alongside the tickets a human already reviews (src/ticketQueue.js, reused).
 * Never applies anything. Never throws.
 *
 * @param {{ correctionsPath?: string|URL, queueDir?: string }} [options]
 *   `correctionsPath` overrides the corrections file (tests only); `queueDir`
 *   is passed through to ticketQueue.js's addTicketToQueue (tests only).
 * @returns {CheckSuggestionsResult}
 */
export function checkForSuggestedRule(options = {}) {
  const path = options.correctionsPath ?? CORRECTIONS_PATH;
  const loaded = loadCorrections(path);
  if (!loaded.ok) {
    return {
      ok: false,
      suggested: false,
      suggestions: [],
      message: `Could not check for a suggested rule: ${loaded.message}`,
      logEntry: buildLogEntry({
        event: 'rule_suggestion_check_failed',
        outcome: 'failure',
        context: {},
        errorClass: 'CorrectionsFileCorruptError',
      }),
    };
  }

  const groups = new Map();
  for (const correction of loaded.corrections) {
    const key = `${correction.keyword.toLowerCase()}|${correction.wrongCategory}|${correction.correctCategory}`;
    const group = groups.get(key) ?? { keyword: correction.keyword, wrongCategory: correction.wrongCategory, correctCategory: correction.correctCategory, count: 0 };
    group.count += 1;
    groups.set(key, group);
  }

  const suggestions = [];
  for (const group of groups.values()) {
    if (group.count < SUGGESTION_THRESHOLD) continue;

    const requestId = suggestionRequestId(group.keyword, group.wrongCategory, group.correctCategory);
    const suggestion = {
      type: 'suggested_rule_change',
      keyword: group.keyword,
      wrongCategory: group.wrongCategory,
      correctCategory: group.correctCategory,
      timesSeen: group.count,
      requestId,
      createdAt: new Date().toISOString(),
    };

    const queueResult = addTicketToQueue(suggestion, { queueDir: options.queueDir });
    suggestions.push({ ...suggestion, queued: queueResult.saved === true });
  }

  return {
    ok: true,
    suggested: suggestions.length > 0,
    suggestions,
    logEntry: buildLogEntry({
      event: suggestions.length > 0 ? 'rule_suggestion_created' : 'rule_suggestion_check_completed',
      outcome: 'success',
      context: { suggestionCount: suggestions.length, patterns: suggestions.map((s) => ({ keyword: s.keyword, correctCategory: s.correctCategory, timesSeen: s.timesSeen })) },
    }),
  };
}
