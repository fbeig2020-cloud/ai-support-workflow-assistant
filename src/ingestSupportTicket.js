/**
 * Ingest Support Ticket — entry point for a new support request arriving
 * with student contact info attached.
 *
 * Builds the classifier-facing ticket (requestId, requestText, status,
 * priority, createdAt, source) and saves it via ticketQueue.js's
 * addTicketToQueue() — the queue write logic itself is not duplicated here.
 * Student contact info (studentEmail, studentName) is persisted separately,
 * to queue/<ticketId>.student.json, and is never included in a logEntry or
 * passed to any AI-facing function (classify.js, knowledgeBaseSearch.js,
 * generateDraftResponse.js) — those only ever see the ticket record.
 *
 * `ticketId` is validated against the same safe filename character set
 * ticketQueue.js uses (SAFE_TICKET_ID) before anything is built from it,
 * per the Security Enforcement Layer's input-validation rule. Never throws
 * — every branch returns a result object.
 *
 * Failure paths handled:
 *  - Invalid input (missing/blank ticketId, unsafe ticketId, missing/blank
 *    requestText, missing/blank studentEmail, or a non-string
 *    studentName/source) -> fails closed, ValidationError.
 *  - addTicketToQueue() failure (unwritable queue dir, etc.) -> its result
 *    is returned as-is; no student file is written.
 *  - Ticket saved but the student-info write fails -> the code attempts to
 *    re-save the ticket with contactInfoMissing: true added, so a human
 *    reviewing the queue can see the gap directly on the ticket. If that
 *    re-flag also succeeds, returns ok: false with a message saying contact
 *    info was not saved. If the re-flag also fails (a rarer, deeper failure),
 *    returns ok: false with a "manual review required" message and
 *    errorClass: 'CriticalWriteFailure', since the ticket can no longer even
 *    self-report the missing contact info. Never throws in any case.
 *
 * @typedef {Object} IngestTicketResult
 * @property {boolean} ok
 * @property {boolean} saved
 * @property {string} [path]         Ticket queue file path, present when the ticket was saved.
 * @property {string} [studentPath]  Student info file path, present when it was saved.
 * @property {string} [message]      Present when ok is false.
 * @property {Object} [logEntry]     Structured, stdout-log-shaped record (Observability
 *                                     Framework shape). Never contains studentEmail or
 *                                     studentName.
 */

import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { addTicketToQueue, QUEUE_DIR } from './ticketQueue.js';

/** Ticket ids must be safe to use directly as a filename — mirrors ticketQueue.js's SAFE_TICKET_ID. */
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
    service: 'ingestSupportTicket',
    event,
    outcome,
    context: { requestId: ticketId },
  };
  if (errorClass) entry.error_class = errorClass;
  if (reason) entry.context.reason = reason;
  return entry;
}

/**
 * @param {string} reason
 * @param {unknown} input
 * @returns {IngestTicketResult}
 */
function notIngested(reason, input) {
  const ticketId =
    input && typeof input === 'object' && typeof input.ticketId === 'string' ? input.ticketId : undefined;
  return {
    ok: false,
    saved: false,
    message: `Support ticket not ingested: ${reason.replace(/_/g, ' ')}.`,
    logEntry: buildLogEntry({
      event: 'support_ticket_ingest_failed',
      outcome: 'failure',
      ticketId,
      errorClass: 'ValidationError',
      reason,
    }),
  };
}

/**
 * @param {unknown} input
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
function validateInput(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, reason: 'invalid_input' };
  }
  if (typeof input.ticketId !== 'string' || input.ticketId.trim() === '') {
    return { ok: false, reason: 'invalid_ticket_id' };
  }
  if (!SAFE_TICKET_ID.test(input.ticketId)) {
    return { ok: false, reason: 'unsafe_ticket_id' };
  }
  if (typeof input.requestText !== 'string' || input.requestText.trim() === '') {
    return { ok: false, reason: 'invalid_request_text' };
  }
  if (typeof input.studentEmail !== 'string' || input.studentEmail.trim() === '') {
    return { ok: false, reason: 'invalid_student_email' };
  }
  if (input.studentName !== undefined && typeof input.studentName !== 'string') {
    return { ok: false, reason: 'invalid_student_name' };
  }
  if (input.source !== undefined && typeof input.source !== 'string') {
    return { ok: false, reason: 'invalid_source' };
  }
  return { ok: true };
}

/**
 * Ingest a new support ticket: validate, queue it for classification, and
 * separately persist the student contact info it arrived with. Never throws
 * — every branch returns a result object.
 *
 * @param {unknown} input   Must have ticketId, requestText, studentEmail (all
 *   non-empty strings); studentName and source are optional strings.
 * @returns {IngestTicketResult}
 */
export function ingestSupportTicket(input) {
  const validation = validateInput(input);
  if (!validation.ok) {
    return notIngested(validation.reason, input);
  }

  const { ticketId, requestText, studentEmail, studentName, source } = input;

  const ticket = {
    requestId: ticketId,
    requestText,
    status: 'unclassified',
    priority: null,
    createdAt: new Date().toISOString(),
    source: source ?? null,
  };

  const queueResult = addTicketToQueue(ticket);
  if (!queueResult.ok || !queueResult.saved) {
    return queueResult;
  }

  const studentPath = join(QUEUE_DIR, `${ticketId}.student.json`);
  const studentRecord = { requestId: ticketId, studentEmail, studentName: studentName ?? null };

  try {
    if (!existsSync(QUEUE_DIR)) {
      mkdirSync(QUEUE_DIR, { recursive: true });
    }
    writeFileSync(studentPath, JSON.stringify(studentRecord, null, 2), { encoding: 'utf8' });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const errorClass = error.code === 'EACCES' || error.code === 'EPERM' ? 'StudentInfoAccessDeniedError' : 'StudentInfoWriteFailedError';
    process.stderr.write(`ALERT: support ticket student info write failed: ${message}\n`);

    const flagResult = addTicketToQueue({ ...ticket, contactInfoMissing: true });
    if (flagResult.ok && flagResult.saved) {
      return {
        ok: false,
        saved: true,
        path: queueResult.path,
        message: 'Ticket queued and flagged — student contact info was not saved.',
        logEntry: buildLogEntry({ event: 'support_ticket_student_info_save_failed', outcome: 'failure', ticketId }),
      };
    }

    return {
      ok: false,
      saved: true,
      path: queueResult.path,
      message: 'Ticket queued, but contact info was lost and the ticket could not be flagged. Manual review required.',
      logEntry: buildLogEntry({ event: 'support_ticket_flag_failed', outcome: 'failure', ticketId, errorClass: 'CriticalWriteFailure' }),
    };
  }

  return {
    ok: true,
    saved: true,
    path: queueResult.path,
    studentPath,
    logEntry: buildLogEntry({ event: 'support_ticket_ingested', outcome: 'success', ticketId }),
  };
}
