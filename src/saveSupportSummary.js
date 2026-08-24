/**
 * STORY-007 — Save Final Support Summary (REQ-007: "...which can be saved
 * with the ticket").
 *
 * The explicit, manual save action for a summary produced by
 * generateSupportSummary.js. Deliberately a separate module, never called
 * automatically by generateSupportSummary() itself — that's what makes "I
 * should be able to save it manually" true rather than an automatic side
 * effect of generation. Mirrors auditLog.js's write-side shape (sync fs,
 * fail-loud on error, never throws) since this is the other write boundary
 * in this repo, unlike the async-read pattern used by
 * knowledgeBaseSearch.js/generateDraftResponse.js.
 *
 * Persists one JSON file per ticket to summaries/<ticketId>.json, keyed on
 * ticketId. Saving is an upsert (overwrite), not an append — calling this
 * twice for the same ticket never creates a second file or duplicate
 * side effect, satisfying CLAUDE.md's idempotency contract ("running it
 * twice must not double-create").
 *
 * `ticketId` is validated against a safe filename character set before it is
 * ever used to build a path — untrusted-looking input (path separators,
 * `..`, etc.) is rejected rather than interpolated into a filesystem path,
 * per the Security Enforcement Layer's input-validation rule.
 *
 * Failure paths handled (never throws — every branch returns a result object):
 *  - Malformed summary (not `generated: true`, missing/blank ticketId or
 *    summaryText, or a ticketId containing unsafe characters) -> fails
 *    closed, ValidationError ("Summary not savable").
 *  - Write fails (permission denied, unwritable path) -> fails closed,
 *    SaveAccessDeniedError or SaveFailedError, alerted to stderr (no
 *    external alerting system exists yet, same as auditLog.js).
 *
 * @typedef {import('./generateSupportSummary.js').SupportSummaryResult} SupportSummaryResult
 *
 * @typedef {Object} SaveSummaryResult
 * @property {boolean} ok
 * @property {boolean} saved
 * @property {string} [path]      Present when saved is true.
 * @property {string} [message]   Present when saved is false.
 * @property {Object} logEntry    Structured, stdout-log-shaped record (Observability Framework
 *                                  shape). Not persisted to the audit trail here — persistence
 *                                  is the caller-side wrapper in auditedActions.js.
 */

import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/** Default location summaries are saved to. One JSON file per ticket. */
export const SUMMARIES_DIR = 'summaries';

/** Ticket IDs must be safe to use directly as a filename — no separators, no traversal. */
const SAFE_TICKET_ID = /^[A-Za-z0-9_-]+$/;

/**
 * @param {{ event: string, outcome: 'success'|'failure', ticketId: string|undefined,
 *   errorClass?: string, reason?: string }} fields
 * @returns {Object}
 */
function buildLogEntry({ event, outcome, ticketId, errorClass, reason }) {
  const entry = {
    timestamp: new Date().toISOString(),
    level: outcome === 'success' ? 'info' : 'warn',
    service: 'saveSupportSummary',
    event,
    outcome,
    context: { ticketId },
  };
  if (errorClass) entry.error_class = errorClass;
  if (reason) entry.context.reason = reason;
  return entry;
}

/**
 * @param {string} reason
 * @param {unknown} summary
 * @returns {SaveSummaryResult}
 */
function notSaved(reason, summary) {
  const ticketId =
    summary && typeof summary === 'object' && typeof summary.ticketId === 'string' ? summary.ticketId : undefined;
  return {
    ok: false,
    saved: false,
    message: `Support summary not saved: ${reason.replace(/_/g, ' ')}.`,
    logEntry: buildLogEntry({
      event: 'support_summary_save_failed',
      outcome: 'failure',
      ticketId,
      errorClass: 'ValidationError',
      reason,
    }),
  };
}

/**
 * @param {unknown} summary
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
function validateSummary(summary) {
  if (summary === null || typeof summary !== 'object' || Array.isArray(summary)) {
    return { ok: false, reason: 'invalid_summary' };
  }
  if (summary.generated !== true) {
    return { ok: false, reason: 'summary_not_generated' };
  }
  if (typeof summary.ticketId !== 'string' || summary.ticketId.trim() === '') {
    return { ok: false, reason: 'invalid_ticket_id' };
  }
  if (!SAFE_TICKET_ID.test(summary.ticketId)) {
    return { ok: false, reason: 'unsafe_ticket_id' };
  }
  if (typeof summary.summaryText !== 'string' || summary.summaryText.trim() === '') {
    return { ok: false, reason: 'invalid_summary_text' };
  }
  return { ok: true };
}

/**
 * Manually save a generated support summary alongside its ticket. Never
 * throws — every branch returns a result object. Never called automatically
 * by generateSupportSummary(); this is the deliberate, explicit save step a
 * support agent triggers after reviewing the summary.
 *
 * @param {unknown} summary   A result from generateSupportSummary.js (must have generated: true).
 * @param {{ summariesDir?: string }} [options]   Override the save directory (tests only).
 * @returns {SaveSummaryResult}
 */
export function saveSupportSummary(summary, options = {}) {
  const validation = validateSummary(summary);
  if (!validation.ok) {
    return notSaved(validation.reason, summary);
  }

  const dir = options.summariesDir ?? SUMMARIES_DIR;
  const path = join(dir, `${summary.ticketId}.json`);
  const record = { ticketId: summary.ticketId, summaryText: summary.summaryText, savedAt: new Date().toISOString() };

  try {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(path, JSON.stringify(record, null, 2), { encoding: 'utf8' });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const errorClass = error.code === 'EACCES' || error.code === 'EPERM' ? 'SaveAccessDeniedError' : 'SaveFailedError';
    process.stderr.write(`ALERT: support summary save failed: ${message}\n`);
    return {
      ok: false,
      saved: false,
      message: `Support summary not saved: ${message}`,
      logEntry: buildLogEntry({ event: 'support_summary_save_failed', outcome: 'failure', ticketId: summary.ticketId, errorClass }),
    };
  }

  return {
    ok: true,
    saved: true,
    path,
    logEntry: buildLogEntry({ event: 'support_summary_saved', outcome: 'success', ticketId: summary.ticketId }),
  };
}
