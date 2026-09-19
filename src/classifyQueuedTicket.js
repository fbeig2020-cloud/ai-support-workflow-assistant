/**
 * STORY-012 — Recovery tool for tickets that end up unclassified.
 *
 * Standalone counterpart to ingestSupportTicket.js's automatic
 * classify-on-ingest: for (a) a ticket that ingestSupportTicket() saved with
 * classificationError: true after classification unexpectedly failed, and
 * (b) any older/pre-existing ticket in the queue that was never run through
 * ingestSupportTicket() at all (e.g. hand-seeded fixtures) and is still
 * sitting at status: 'unclassified'.
 *
 * Unlike ingestSupportTicket.js's combined audit entry (one event covering
 * both ingest and classify, since there they happen as a single action),
 * this is a standalone classification action with nothing to combine it
 * with — so it reuses auditedActions.js's classifyAndLog() as-is, the same
 * shape every other standalone classification already uses. Never throws —
 * every branch returns a structured result object.
 *
 * @typedef {Object} ClassifyQueuedTicketResult
 * @property {boolean} ok
 * @property {boolean} [found]      false when no queued ticket matches requestId.
 * @property {boolean} [skipped]    true when the ticket was left untouched (already
 *                                    classified, or not in an eligible status).
 * @property {boolean} [classified] true once classification was applied and saved.
 * @property {string} [status]      Present on a skip: the ticket's actual status field.
 * @property {string} [category]    Present once classified.
 * @property {string} [priority]    Present once classified.
 * @property {string} [path]        Ticket queue file path, present once classified.
 * @property {string} [message]
 * @property {string} [errorClass]
 * @property {import('./auditLog.js').AuditAppendResult} [auditResult]
 */

import { listQueuedTickets, addTicketToQueue } from './ticketQueue.js';
import { classifyAndLog } from './auditedActions.js';

/** Ticket ids must be safe to use directly as a filename — mirrors ticketQueue.js's SAFE_TICKET_ID. */
const SAFE_TICKET_ID = /^[A-Za-z0-9_-]+$/;

/**
 * Classify (or reclassify) one queued ticket by id and persist the result.
 * Only acts on a ticket whose status is genuinely 'unclassified' or that
 * carries classificationError: true — a ticket already sitting at
 * status: 'classified' (or any other status) is left untouched, so this
 * never silently overwrites a category a human may have already reviewed.
 *
 * @param {unknown} requestId
 * @param {{ queueDir?: string, logPath?: string }} [options]   Override the queue
 *   directory / audit log path (tests only).
 * @returns {ClassifyQueuedTicketResult}
 */
export function classifyQueuedTicket(requestId, options = {}) {
  if (typeof requestId !== 'string' || requestId.trim() === '' || !SAFE_TICKET_ID.test(requestId)) {
    return {
      ok: false,
      message: 'Ticket not classified: requestId is missing, blank, or unsafe.',
      errorClass: 'ValidationError',
    };
  }

  const queued = listQueuedTickets(options);
  const ticket = queued.find((t) => t.requestId === requestId);
  if (!ticket) {
    return {
      ok: false,
      found: false,
      message: `Ticket not classified: no queued ticket found for requestId "${requestId}".`,
      errorClass: 'NotFoundError',
    };
  }

  const eligible = ticket.status === 'unclassified' || ticket.classificationError === true;
  if (!eligible) {
    return {
      ok: true,
      skipped: true,
      status: ticket.status ?? null,
      message: `Ticket "${requestId}" was not classified: status is "${ticket.status ?? 'unset'}", which is not eligible for (re)classification.`,
    };
  }

  if (typeof ticket.requestText !== 'string' || ticket.requestText.trim() === '') {
    return {
      ok: false,
      classified: false,
      message: `Ticket "${requestId}" not classified: it has no requestText to classify from.`,
      errorClass: 'ValidationError',
    };
  }

  const result = classifyAndLog(ticket.requestText, options);

  const updatedTicket = {
    ...ticket,
    status: 'classified',
    category: result.category,
    priority: result.priority,
    classificationError: undefined,
    classificationErrorMessage: undefined,
  };

  const queueResult = addTicketToQueue(updatedTicket, options);
  if (!queueResult.ok || !queueResult.saved) {
    return {
      ok: false,
      classified: false,
      message: `Ticket "${requestId}" was classified, but could not be saved back to the queue: ${queueResult.message}`,
      errorClass: queueResult.logEntry?.error_class ?? 'QueueWriteFailedError',
      auditResult: result.auditResult,
    };
  }

  return {
    ok: true,
    classified: true,
    category: result.category,
    priority: result.priority,
    path: queueResult.path,
    message: `Ticket "${requestId}" classified as ${result.category} (${result.priority} priority).`,
    auditResult: result.auditResult,
  };
}
