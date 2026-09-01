import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  toolInvocationStarted,
  toolInvocationFinished,
  diskReadStarted,
  diskReadFinished,
  requestRejected,
  toolInvocationError,
} from '../src/mcpLogEvents.js';

/** Every event this module builds must carry these, and nothing free-text. */
function assertCommonShape(event, expectedEventName, correlationId, tool) {
  assert.equal(event.data.event, expectedEventName);
  assert.equal(event.data.correlationId, correlationId);
  assert.equal(event.data.tool, tool);
  assert.equal(typeof event.data.timestamp, 'string');
}

test('toolInvocationStarted is an info-level, stably-named event carrying the correlation id and tool', () => {
  const event = toolInvocationStarted({ correlationId: 'corr-1', tool: 'classify' });
  assert.equal(event.level, 'info');
  assertCommonShape(event, 'tool_invocation_started', 'corr-1', 'classify');
});

test('toolInvocationFinished is info on success and carries durationMs', () => {
  const event = toolInvocationFinished({ correlationId: 'corr-1', tool: 'classify', outcome: 'success', durationMs: 12 });
  assert.equal(event.level, 'info');
  assertCommonShape(event, 'tool_invocation_finished', 'corr-1', 'classify');
  assert.equal(event.data.outcome, 'success');
  assert.equal(event.data.durationMs, 12);
});

test('toolInvocationFinished is warning-level on failure', () => {
  const event = toolInvocationFinished({ correlationId: 'corr-1', tool: 'classify', outcome: 'failure', durationMs: 5 });
  assert.equal(event.level, 'warning');
  assert.equal(event.data.outcome, 'failure');
});

test('diskReadStarted names the file being read', () => {
  const event = diskReadStarted({ correlationId: 'corr-2', tool: 'knowledgeBaseSearch', file: 'knowledgeBase.json' });
  assert.equal(event.level, 'info');
  assertCommonShape(event, 'disk_read_started', 'corr-2', 'knowledgeBaseSearch');
  assert.equal(event.data.file, 'knowledgeBase.json');
});

test('diskReadFinished carries outcome, durationMs, and an error class only on failure', () => {
  const success = diskReadFinished({
    correlationId: 'corr-2',
    tool: 'knowledgeBaseSearch',
    file: 'knowledgeBase.json',
    outcome: 'success',
    durationMs: 3,
  });
  assert.equal(success.level, 'info');
  assert.equal(success.data.outcome, 'success');
  assert.equal('error_class' in success.data, false);

  const failure = diskReadFinished({
    correlationId: 'corr-2',
    tool: 'knowledgeBaseSearch',
    file: 'knowledgeBase.json',
    outcome: 'failure',
    durationMs: 3,
    errorClass: 'KnowledgeBaseUnavailableError',
  });
  assert.equal(failure.level, 'warning');
  assert.equal(failure.data.error_class, 'KnowledgeBaseUnavailableError');
});

test('requestRejected carries a stable reason code, not free text', () => {
  const event = requestRejected({ correlationId: 'corr-3', tool: 'submitReviewDecision', reason: 'ticket_not_found' });
  assert.equal(event.level, 'warning');
  assertCommonShape(event, 'request_rejected', 'corr-3', 'submitReviewDecision');
  assert.equal(event.data.reason, 'ticket_not_found');
});

test('toolInvocationError is error-level and carries a stable error class', () => {
  const event = toolInvocationError({ correlationId: 'corr-4', tool: 'submitReviewDecision', errorClass: 'QueueWriteFailedError' });
  assert.equal(event.level, 'error');
  assertCommonShape(event, 'tool_invocation_error', 'corr-4', 'submitReviewDecision');
  assert.equal(event.data.error_class, 'QueueWriteFailedError');
});

// --- Never leak free text into a log payload ---------------------------------

test('none of the builders accept or echo back a free-text field a user typed', () => {
  const events = [
    toolInvocationStarted({ correlationId: 'c', tool: 'classify' }),
    toolInvocationFinished({ correlationId: 'c', tool: 'classify', outcome: 'success', durationMs: 1 }),
    diskReadStarted({ correlationId: 'c', tool: 'knowledgeBaseSearch', file: 'knowledgeBase.json' }),
    diskReadFinished({ correlationId: 'c', tool: 'knowledgeBaseSearch', file: 'knowledgeBase.json', outcome: 'success', durationMs: 1 }),
    requestRejected({ correlationId: 'c', tool: 'submitReviewDecision', reason: 'ticket_not_found' }),
    toolInvocationError({ correlationId: 'c', tool: 'submitReviewDecision', errorClass: 'ValidationError' }),
  ];

  const forbiddenKeys = ['summary', 'requestText', 'draftText', 'reviewer', 'decision', 'args'];
  for (const event of events) {
    for (const key of forbiddenKeys) {
      assert.equal(key in event.data, false, `${event.data.event} must not carry a "${key}" field`);
    }
  }
});
