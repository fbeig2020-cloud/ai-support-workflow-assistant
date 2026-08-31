/**
 * Ticket Queue — persistence for tickets waiting to be picked up.
 *
 * One JSON file per ticket, keyed on `requestId`, mirroring
 * saveSupportSummary.js's write-side shape (sync fs, fail-closed on bad
 * input, never throws). Unlike saveSupportSummary.js this module also reads
 * and deletes — but the same rules apply: no path is ever built from
 * untrusted input without validating it first.
 *
 * `requestId` is validated against the same safe filename character set used
 * throughout this repo (saveSupportSummary.js's SAFE_TICKET_ID) before it is
 * ever used to build a path — untrusted-looking input (path separators,
 * `..`, etc.) is rejected rather than interpolated into a filesystem path,
 * per the Security Enforcement Layer's input-validation rule.
 *
 * Failure paths handled (never throws — every branch returns a result):
 *  - addTicketToQueue: missing/blank requestId, unsafe requestId, or a write
 *    failure (permission denied, unwritable path) -> fails closed,
 *    ValidationError / QueueAccessDeniedError / QueueWriteFailedError.
 *  - listQueuedTickets: queue/ missing or empty -> []. A corrupt (non-JSON
 *    or malformed) file is skipped rather than crashing the whole listing —
 *    it is recorded on the returned array's `.skipped` property instead.
 *  - removeTicketFromQueue: an unsafe/invalid ticketId, or a ticket that
 *    does not exist -> { ok: false }, never throws.
 *
 * @typedef {Object} QueuedTicket
 * @property {string} requestId
 * @property {'low'|'medium'|'high'|'urgent'} priority
 * @property {string} createdAt   ISO-8601 timestamp.
 *
 * @typedef {Object} AddTicketResult
 * @property {boolean} ok
 * @property {boolean} saved
 * @property {string} [path]      Present when saved is true.
 * @property {string} [message]   Present when saved is false.
 * @property {Object} logEntry    Structured, stdout-log-shaped record (Observability Framework
 *                                  shape). Not persisted to the audit trail here — persistence
 *                                  is the caller-side wrapper in auditedActions.js.
 *
 * @typedef {Object} RemoveTicketResult
 * @property {boolean} ok
 * @property {string} [message]   Present when ok is false.
 * @property {Object} logEntry
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { PRIORITIES } from './classify.js';

/** Default location queued tickets are persisted to. One JSON file per ticket. */
export const QUEUE_DIR = 'queue';

/** Ticket ids must be safe to use directly as a filename — no separators, no traversal. */
const SAFE_TICKET_ID = /^[A-Za-z0-9_-]+$/;

/** Lowest priority first, matching classify.js's PRIORITIES order — used to rank for sorting. */
const PRIORITY_RANK = new Map(PRIORITIES.map((priority, index) => [priority, index]));

/**
 * @param {{ event: string, outcome: 'success'|'failure', requestId: string|undefined,
 *   errorClass?: string, reason?: string }} fields
 * @returns {Object}
 */
function buildLogEntry({ event, outcome, requestId, errorClass, reason }) {
  const entry = {
    timestamp: new Date().toISOString(),
    level: outcome === 'success' ? 'info' : 'warn',
    service: 'ticketQueue',
    event,
    outcome,
    context: { requestId },
  };
  if (errorClass) entry.error_class = errorClass;
  if (reason) entry.context.reason = reason;
  return entry;
}

/**
 * @param {string} reason
 * @param {unknown} ticket
 * @returns {AddTicketResult}
 */
function notQueued(reason, ticket) {
  const requestId =
    ticket && typeof ticket === 'object' && typeof ticket.requestId === 'string' ? ticket.requestId : undefined;
  return {
    ok: false,
    saved: false,
    message: `Ticket not added to queue: ${reason.replace(/_/g, ' ')}.`,
    logEntry: buildLogEntry({
      event: 'ticket_queue_add_failed',
      outcome: 'failure',
      requestId,
      errorClass: 'ValidationError',
      reason,
    }),
  };
}

/**
 * @param {unknown} ticket
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
function validateTicket(ticket) {
  if (ticket === null || typeof ticket !== 'object' || Array.isArray(ticket)) {
    return { ok: false, reason: 'invalid_ticket' };
  }
  if (typeof ticket.requestId !== 'string' || ticket.requestId.trim() === '') {
    return { ok: false, reason: 'invalid_request_id' };
  }
  if (!SAFE_TICKET_ID.test(ticket.requestId)) {
    return { ok: false, reason: 'unsafe_request_id' };
  }
  return { ok: true };
}

/**
 * Add one ticket to the queue, persisted as queue/<requestId>.json. Upsert —
 * calling this twice for the same requestId overwrites, never duplicates.
 * Never throws — every branch returns a result object.
 *
 * @param {unknown} ticket   Must have a non-empty, filename-safe `requestId`.
 * @param {{ queueDir?: string }} [options]   Override the queue directory (tests only).
 * @returns {AddTicketResult}
 */
export function addTicketToQueue(ticket, options = {}) {
  const validation = validateTicket(ticket);
  if (!validation.ok) {
    return notQueued(validation.reason, ticket);
  }

  const dir = options.queueDir ?? QUEUE_DIR;
  const path = join(dir, `${ticket.requestId}.json`);

  try {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(path, JSON.stringify(ticket, null, 2), { encoding: 'utf8' });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const errorClass = error.code === 'EACCES' || error.code === 'EPERM' ? 'QueueAccessDeniedError' : 'QueueWriteFailedError';
    process.stderr.write(`ALERT: ticket queue write failed: ${message}\n`);
    return {
      ok: false,
      saved: false,
      message: `Ticket not added to queue: ${message}`,
      logEntry: buildLogEntry({ event: 'ticket_queue_add_failed', outcome: 'failure', requestId: ticket.requestId, errorClass }),
    };
  }

  return {
    ok: true,
    saved: true,
    path,
    logEntry: buildLogEntry({ event: 'ticket_queued', outcome: 'success', requestId: ticket.requestId }),
  };
}

/**
 * @param {string} priority
 * @returns {number}
 */
function priorityRank(priority) {
  return PRIORITY_RANK.has(priority) ? PRIORITY_RANK.get(priority) : -1;
}

/**
 * List every queued ticket, sorted highest priority first (urgent > high >
 * medium > low), ties broken by earliest createdAt. Never throws — a
 * missing/empty queue directory yields an empty array, and a corrupt file
 * is skipped rather than aborting the whole listing.
 *
 * @param {{ queueDir?: string }} [options]   Override the queue directory (tests only).
 * @returns {QueuedTicket[] & { skipped: { file: string, reason: string }[] }}
 *   The array of parsed tickets. A `skipped` property (always present, even
 *   when empty) records any file that could not be read as a valid ticket.
 */
export function listQueuedTickets(options = {}) {
  const dir = options.queueDir ?? QUEUE_DIR;
  const tickets = [];
  tickets.skipped = [];

  if (!existsSync(dir)) {
    return tickets;
  }

  let files;
  try {
    files = readdirSync(dir).filter((name) => name.endsWith('.json'));
  } catch {
    return tickets;
  }

  for (const file of files) {
    const path = join(dir, file);
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8'));
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed) || typeof parsed.requestId !== 'string') {
        tickets.skipped.push({ file, reason: 'invalid_ticket_shape' });
        continue;
      }
      tickets.push(parsed);
    } catch {
      tickets.skipped.push({ file, reason: 'corrupt_json' });
    }
  }

  tickets.sort((a, b) => {
    const rankDiff = priorityRank(b.priority) - priorityRank(a.priority);
    if (rankDiff !== 0) return rankDiff;
    return (Date.parse(a.createdAt) || 0) - (Date.parse(b.createdAt) || 0);
  });

  return tickets;
}

/**
 * Remove one ticket from the queue by id. Never throws — a missing ticket
 * or an unsafe/invalid ticketId returns `{ ok: false }` rather than
 * throwing.
 *
 * @param {unknown} ticketId
 * @param {{ queueDir?: string }} [options]   Override the queue directory (tests only).
 * @returns {RemoveTicketResult}
 */
export function removeTicketFromQueue(ticketId, options = {}) {
  const dir = options.queueDir ?? QUEUE_DIR;

  if (typeof ticketId !== 'string' || ticketId.trim() === '' || !SAFE_TICKET_ID.test(ticketId)) {
    return {
      ok: false,
      message: 'Ticket not removed from queue: unsafe or invalid ticket id.',
      logEntry: buildLogEntry({
        event: 'ticket_queue_remove_failed',
        outcome: 'failure',
        requestId: typeof ticketId === 'string' ? ticketId : undefined,
        errorClass: 'ValidationError',
        reason: 'unsafe_ticket_id',
      }),
    };
  }

  const path = join(dir, `${ticketId}.json`);

  if (!existsSync(path)) {
    return {
      ok: false,
      message: `Ticket not removed from queue: no queued ticket found for ${ticketId}.`,
      logEntry: buildLogEntry({
        event: 'ticket_queue_remove_failed',
        outcome: 'failure',
        requestId: ticketId,
        errorClass: 'NotFoundError',
        reason: 'ticket_not_found',
      }),
    };
  }

  try {
    unlinkSync(path);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const errorClass = error.code === 'EACCES' || error.code === 'EPERM' ? 'QueueAccessDeniedError' : 'QueueRemoveFailedError';
    process.stderr.write(`ALERT: ticket queue remove failed: ${message}\n`);
    return {
      ok: false,
      message: `Ticket not removed from queue: ${message}`,
      logEntry: buildLogEntry({ event: 'ticket_queue_remove_failed', outcome: 'failure', requestId: ticketId, errorClass }),
    };
  }

  return {
    ok: true,
    logEntry: buildLogEntry({ event: 'ticket_removed_from_queue', outcome: 'success', requestId: ticketId }),
  };
}
