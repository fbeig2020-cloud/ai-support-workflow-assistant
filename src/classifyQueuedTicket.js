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
 * classification itself is a standalone action here with nothing to
 * combine it with — so it still reuses auditedActions.js's classifyAndLog()
 * as-is, unchanged, the same shape every other standalone classification
 * already uses.
 *
 * STORY-013 extends this recovery tool the same way it extends
 * ingestSupportTicket.js: after a successful reclassification, it also
 * runs knowledgeBaseSearch.js's searchKnowledgeBase() and
 * generateDraftResponse.js's generateDraftResponse() against the fresh
 * classification, so a recovered ticket ends up just as complete as a
 * freshly-ingested one — never permanently missing search/draft data just
 * because it needed recovery instead of a clean ingest. Because this is a
 * distinct action from "classification happened" (it runs after
 * classifyAndLog() has already persisted its own row), it gets its own
 * second, combined audit entry — not two more separate AndLog rows —
 * returned as `preparationAuditResult` alongside the classification's own
 * `auditResult`. Any kbSearchResult/draftResponse the ticket already
 * carried (there isn't a reachable case where an eligible ticket has one —
 * eligibility requires status 'unclassified' or classificationError: true,
 * and nothing in this codebase sets either of those on a ticket that also
 * already has search/draft data) is overwritten by plain object-key
 * assignment, never merged, so no stale data could survive even if that
 * became reachable later. This function is async (searchKnowledgeBase/
 * generateDraftResponse both do file I/O), unlike classifyAndLog()/
 * classifySupportRequest(), which are synchronous. Never throws — every
 * branch returns a structured result object.
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
 * @property {import('./auditLog.js').AuditAppendResult} [auditResult]           The classification step's own audit entry.
 * @property {import('./auditLog.js').AuditAppendResult} [preparationAuditResult] The search+draft step's combined audit entry.
 */

import { listQueuedTickets, addTicketToQueue } from './ticketQueue.js';
import { classifyAndLog } from './auditedActions.js';
import { searchKnowledgeBase } from './knowledgeBaseSearch.js';
import { generateDraftResponse } from './generateDraftResponse.js';
import { appendAuditEntry } from './auditLog.js';

/** Ticket ids must be safe to use directly as a filename — mirrors ticketQueue.js's SAFE_TICKET_ID. */
const SAFE_TICKET_ID = /^[A-Za-z0-9_-]+$/;

/**
 * One combined audit entry for the search+draft step that follows a
 * successful reclassification — mirrors ingestSupportTicket.js's
 * buildClassificationLogEntry() shape and its "one action, one row"
 * philosophy, kept as a distinct second entry (not merged into
 * classifyAndLog()'s own row) since it's a separate step that runs after
 * classification has already been persisted.
 *
 * @param {{ ticketId: string, category: string, priority: string,
 *   kbSearchFound?: boolean, kbSearchConfidence?: string, kbSearchFailed?: boolean,
 *   draftGenerated?: boolean, draftGenerationFailed?: boolean }} fields
 * @returns {Object}
 */
function buildPreparationLogEntry({
  ticketId,
  category,
  priority,
  kbSearchFound,
  kbSearchConfidence,
  kbSearchFailed,
  draftGenerated,
  draftGenerationFailed,
}) {
  return {
    timestamp: new Date().toISOString(),
    level: 'info',
    service: 'classifyQueuedTicket',
    event: 'queued_ticket_search_and_draft_prepared',
    outcome: 'success',
    context: {
      requestId: ticketId,
      category,
      priority,
      kbSearchFound,
      kbSearchConfidence,
      kbSearchFailed,
      draftGenerated,
      draftGenerationFailed,
    },
    humanSummary: 'This recovered ticket was searched against the knowledge base and given a draft response, matching its new classification.',
  };
}

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
 * @returns {Promise<ClassifyQueuedTicketResult>}
 */
export async function classifyQueuedTicket(requestId, options = {}) {
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
    // Explicitly overwritten below (not merged) with the fresh search/draft
    // output — never left holding data tied to a now-superseded category.
    kbSearchResult: undefined,
    kbSearchFailed: undefined,
    kbSearchFailedMessage: undefined,
    draftResponse: undefined,
    draftGenerationFailed: undefined,
    draftGenerationFailedMessage: undefined,
  };

  let kbSearchResult;
  try {
    kbSearchResult = await searchKnowledgeBase(result, options);
    updatedTicket.kbSearchResult = kbSearchResult;
  } catch (error) {
    updatedTicket.kbSearchFailed = true;
    updatedTicket.kbSearchFailedMessage = error instanceof Error ? error.message : String(error);
  }

  let draftResponse;
  try {
    draftResponse = await generateDraftResponse(result, kbSearchResult, options);
    updatedTicket.draftResponse = draftResponse;
  } catch (error) {
    updatedTicket.draftGenerationFailed = true;
    updatedTicket.draftGenerationFailedMessage = error instanceof Error ? error.message : String(error);
  }

  const preparationAuditResult = appendAuditEntry(
    buildPreparationLogEntry({
      ticketId: requestId,
      category: result.category,
      priority: result.priority,
      kbSearchFound: kbSearchResult?.found,
      kbSearchConfidence: kbSearchResult?.confidence,
      kbSearchFailed: updatedTicket.kbSearchFailed,
      draftGenerated: draftResponse?.generated,
      draftGenerationFailed: updatedTicket.draftGenerationFailed,
    }),
    options,
  );

  const queueResult = addTicketToQueue(updatedTicket, options);
  if (!queueResult.ok || !queueResult.saved) {
    return {
      ok: false,
      classified: false,
      message: `Ticket "${requestId}" was classified, but could not be saved back to the queue: ${queueResult.message}`,
      errorClass: queueResult.logEntry?.error_class ?? 'QueueWriteFailedError',
      auditResult: result.auditResult,
      preparationAuditResult,
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
    preparationAuditResult,
  };
}
