/**
 * Structured log notifications for the MCP server (mcp-server.js).
 *
 * This is a separate concern from the per-module `logEntry` objects built by
 * classify.js/knowledgeBaseSearch.js/generateDraftResponse.js/etc. (those
 * feed the persistent, hash-chained audit trail via auditLog.js — STORY-003).
 * This module feeds the MCP protocol's own `notifications/message` channel
 * (Observability Framework: "structured event streams", correlation IDs)
 * so an MCP client/operator can watch server activity in real time.
 *
 * Every builder here returns `{ level, data }`:
 *  - `level` is one of the MCP LoggingLevelSchema values, ready to pass to
 *    `server.sendLoggingMessage({ level, data })`.
 *  - `data` is a plain, JSON-serializable object with a stable `event` name
 *    and only identifiers/categories/counts/durations — never a formatted
 *    sentence, and never a free-text field a user typed (no ticket summary,
 *    no requestText, no draft text, no rejection reason). Callers must not
 *    add such fields to `context`/`reason`/etc. either.
 *
 * One correlationId is minted per tool invocation (mcp-server.js does this
 * with node:crypto's randomUUID()) and threaded through every event for that
 * invocation, so a client can reconstruct the full timeline of one call.
 */

function base(event, { correlationId, tool }) {
  return { event, correlationId, tool, timestamp: new Date().toISOString() };
}

/** Tool invocation is starting. */
export function toolInvocationStarted({ correlationId, tool }) {
  return { level: 'info', data: base('tool_invocation_started', { correlationId, tool }) };
}

/** Tool invocation has finished (whether or not the requested action succeeded). */
export function toolInvocationFinished({ correlationId, tool, outcome, durationMs }) {
  return {
    level: outcome === 'success' ? 'info' : 'warning',
    data: { ...base('tool_invocation_finished', { correlationId, tool }), outcome, durationMs },
  };
}

/** A disk read boundary (knowledgeBase.json / responseTemplates.json) is starting. */
export function diskReadStarted({ correlationId, tool, file }) {
  return { level: 'info', data: { ...base('disk_read_started', { correlationId, tool }), file } };
}

/** A disk read boundary has finished, successfully or not. */
export function diskReadFinished({ correlationId, tool, file, outcome, durationMs, errorClass }) {
  const data = { ...base('disk_read_finished', { correlationId, tool }), file, outcome, durationMs };
  if (errorClass) data.error_class = errorClass;
  return { level: outcome === 'success' ? 'info' : 'warning', data };
}

/**
 * A request was fail-closed rejected — the tool call itself completed, but
 * the specific action it asked for was refused (e.g. an unrecognized tool
 * name, or a decision on a ticket that isn't in the queue). `reason` must be
 * a stable code, never free text.
 */
export function requestRejected({ correlationId, tool, reason, errorClass }) {
  const data = { ...base('request_rejected', { correlationId, tool }), reason };
  if (errorClass) data.error_class = errorClass;
  return { level: 'warning', data };
}

/** A caught error (thrown, or a checked failure result) with a stable error class. */
export function toolInvocationError({ correlationId, tool, errorClass }) {
  return { level: 'error', data: { ...base('tool_invocation_error', { correlationId, tool }), error_class: errorClass } };
}
