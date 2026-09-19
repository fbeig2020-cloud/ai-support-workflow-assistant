/**
 * Ingest Support Ticket — entry point for a new support request arriving
 * with student contact info attached.
 *
 * Builds the classifier-facing ticket (requestId, requestText, status,
 * priority, createdAt, source), classifies it automatically via classify.js's
 * classifySupportRequest() (STORY-012 — no separate manual classify step),
 * and saves it via ticketQueue.js's addTicketToQueue() — the queue write
 * logic itself is not duplicated here. Student contact info (studentEmail,
 * studentName) is persisted separately, to queue/<ticketId>.student.json,
 * and is never included in a logEntry or passed to any AI-facing function
 * (classify.js, knowledgeBaseSearch.js, generateDraftResponse.js) — those
 * only ever see the ticket record.
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
 *  - classifySupportRequest() unexpectedly throws or returns a malformed
 *    result (requestText is always non-blank here, so this is not the
 *    "missing text" case classify.js itself fails closed on) -> the ticket
 *    is still saved: status stays 'unclassified', classificationError is
 *    set to true, and classificationErrorMessage carries the real reason.
 *    Recoverable later via classifyQueuedTicket().
 *  - addTicketToQueue() failure (unwritable queue dir, etc.) -> its result
 *    is returned as-is (with classificationAuditResult attached); no student
 *    file is written.
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
 * @property {import('./auditLog.js').AuditAppendResult} [classificationAuditResult]
 *   Result of persisting the combined ingest+classify audit entry. Present
 *   whenever classification was attempted (i.e. whenever input validation
 *   passed), regardless of whether classification or the later queue/student
 *   writes succeeded.
 */

import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { addTicketToQueue, QUEUE_DIR } from './ticketQueue.js';
import { classifySupportRequest } from './classify.js';
import { appendAuditEntry } from './auditLog.js';

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
 * Combined ingest+classify audit entry. Classification now happens
 * automatically as part of ingestion, so this is one audit event, not two
 * — it is NOT built via classify.js's own classifyAndLog() wrapper (that
 * would persist a second, separate 'support_request_classified' row for
 * what is, from the caller's point of view, a single action).
 *
 * @param {{ ticketId: string, outcome: 'success'|'failure', category?: string,
 *   priority?: string, summary?: string, matchedSignals?: string[],
 *   errorClass?: string, reason?: string }} fields
 * @returns {Object}
 */
function buildClassificationLogEntry({ ticketId, outcome, category, priority, summary, matchedSignals, errorClass, reason }) {
  const entry = {
    timestamp: new Date().toISOString(),
    level: outcome === 'success' ? 'info' : 'warn',
    service: 'ingestSupportTicket',
    event: 'support_ticket_ingested_and_classified',
    outcome,
    context: { requestId: ticketId, category, priority, summary, matchedSignals },
  };
  if (outcome === 'success') {
    const categoryText = category.replace(/_/g, ' ');
    entry.humanSummary = `This ticket was automatically classified as a ${categoryText} with ${priority} priority upon ingestion.`;
  }
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
 * Ingest a new support ticket: validate, classify it, queue it, and
 * separately persist the student contact info it arrived with. Never throws
 * — every branch returns a result object.
 *
 * Classification happens automatically, right after the ticket is built and
 * before it is ever written to the queue, so the common case is a single
 * queue write with the real category/priority already on it (never a
 * write-then-requeue). If classification itself unexpectedly fails
 * (classifySupportRequest() throws, or returns a malformed result), the
 * ticket is still saved — status stays 'unclassified', classificationError
 * is set to true, and classificationErrorMessage carries the real reason, so
 * a human (or classifyQueuedTicket()) can follow up. Either way, exactly one
 * combined audit trail entry is written for the classification step — see
 * buildClassificationLogEntry() above for why this isn't classify.js's own
 * classifyAndLog() wrapper.
 *
 * @param {unknown} input   Must have ticketId, requestText, studentEmail (all
 *   non-empty strings); studentName and source are optional strings.
 * @param {{ queueDir?: string, logPath?: string }} [options]   Override the queue
 *   directory / audit log path (tests only).
 * @returns {IngestTicketResult}
 */
export function ingestSupportTicket(input, options = {}) {
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

  let classification;
  let classificationFailure;
  try {
    classification = classifySupportRequest(requestText, options);
    if (typeof classification?.category !== 'string' || typeof classification?.priority !== 'string') {
      throw new Error('classifySupportRequest returned a malformed result');
    }
  } catch (error) {
    classificationFailure = error instanceof Error ? error.message : String(error);
  }

  let classificationAuditResult;
  if (classificationFailure) {
    ticket.classificationError = true;
    ticket.classificationErrorMessage = classificationFailure;
    classificationAuditResult = appendAuditEntry(
      buildClassificationLogEntry({ ticketId, outcome: 'failure', errorClass: 'ClassificationError', reason: classificationFailure }),
      options,
    );
  } else {
    ticket.status = 'classified';
    ticket.category = classification.category;
    ticket.priority = classification.priority;
    classificationAuditResult = appendAuditEntry(
      buildClassificationLogEntry({
        ticketId,
        outcome: 'success',
        category: classification.category,
        priority: classification.priority,
        summary: classification.summary,
        matchedSignals: classification.matchedSignals,
      }),
      options,
    );
  }

  const queueResult = addTicketToQueue(ticket, options);
  if (!queueResult.ok || !queueResult.saved) {
    return { ...queueResult, classificationAuditResult };
  }

  const queueDir = options.queueDir ?? QUEUE_DIR;
  const studentPath = join(queueDir, `${ticketId}.student.json`);
  const studentRecord = { requestId: ticketId, studentEmail, studentName: studentName ?? null };

  try {
    if (!existsSync(queueDir)) {
      mkdirSync(queueDir, { recursive: true });
    }
    writeFileSync(studentPath, JSON.stringify(studentRecord, null, 2), { encoding: 'utf8' });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const errorClass = error.code === 'EACCES' || error.code === 'EPERM' ? 'StudentInfoAccessDeniedError' : 'StudentInfoWriteFailedError';
    process.stderr.write(`ALERT: support ticket student info write failed: ${message}\n`);

    const flagResult = addTicketToQueue({ ...ticket, contactInfoMissing: true }, options);
    if (flagResult.ok && flagResult.saved) {
      return {
        ok: false,
        saved: true,
        path: queueResult.path,
        message: 'Ticket queued and flagged — student contact info was not saved.',
        logEntry: buildLogEntry({ event: 'support_ticket_student_info_save_failed', outcome: 'failure', ticketId }),
        classificationAuditResult,
      };
    }

    return {
      ok: false,
      saved: true,
      path: queueResult.path,
      message: 'Ticket queued, but contact info was lost and the ticket could not be flagged. Manual review required.',
      logEntry: buildLogEntry({ event: 'support_ticket_flag_failed', outcome: 'failure', ticketId, errorClass: 'CriticalWriteFailure' }),
      classificationAuditResult,
    };
  }

  return {
    ok: true,
    saved: true,
    path: queueResult.path,
    studentPath,
    logEntry: buildLogEntry({ event: 'support_ticket_ingested', outcome: 'success', ticketId }),
    classificationAuditResult,
  };
}
