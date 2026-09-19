import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { dispatchTool } from '../mcp-server.js';
import { addTicketToQueue } from '../src/ticketQueue.js';

// Own subdirectory per file, same reason as the other tests/*.test.js files:
// node --test runs files concurrently, so a shared literal tmp dir name races.
const TMP_DIR = join('tests/tmp', `mcpServerSubmitReviewDecision-${randomUUID()}`);

function tempQueueDir() {
  return join(TMP_DIR, `queue-${randomUUID()}`);
}

function tempLogPath() {
  return join(TMP_DIR, `audit-${randomUUID()}.log`);
}

test.before(() => {
  mkdirSync(TMP_DIR, { recursive: true });
});

test.after(() => {
  rmSync(TMP_DIR, { recursive: true, force: true });
});

// --- submitReviewDecision reject: reclassification wiring ---------------------

test('reject re-runs classification on the original request text and requeues with the fresh category/priority', async () => {
  const queueDir = tempQueueDir();
  const logPath = tempLogPath();

  // Seeded with a deliberately stale/wrong classification. requestText's
  // real signals ("password", "log in", "urgent") point at
  // login_problem/urgent, not the general_support_request/low it was
  // originally (mis)classified as.
  addTicketToQueue(
    {
      requestId: 'TICKET-2001',
      requestText: "My password is wrong and I can't log in, this is urgent.",
      category: 'general_support_request',
      priority: 'low',
      createdAt: '2026-01-01T00:00:00.000Z',
    },
    { queueDir }
  );

  const result = await dispatchTool(
    'submitReviewDecision',
    { requestId: 'TICKET-2001', decision: { action: 'reject', reviewer: 'Jamie', reason: 'wrong category' } },
    randomUUID(),
    { queueDir, logPath }
  );

  const body = JSON.parse(result.content[0].text);
  assert.equal(body.ok, true);

  const requeuedPath = join(queueDir, 'TICKET-2001.json');
  assert.equal(existsSync(requeuedPath), true);
  const requeued = JSON.parse(readFileSync(requeuedPath, 'utf8'));

  assert.equal(requeued.category, 'login_problem');
  assert.equal(requeued.priority, 'urgent');
  assert.equal(requeued.previouslyRejected, true);
  assert.equal(requeued.rejectionReason, 'wrong category');
  assert.equal(requeued.rejectionCount, 1);
  assert.equal(requeued.reclassificationSkipped, undefined);
});

test('reject falls back to the ticket\'s existing category/priority when there is no requestText to reclassify from', async () => {
  const queueDir = tempQueueDir();
  const logPath = tempLogPath();

  addTicketToQueue(
    {
      requestId: 'TICKET-2002',
      category: 'sql_database_issue',
      priority: 'high',
      createdAt: '2026-01-01T00:00:00.000Z',
    },
    { queueDir }
  );

  const result = await dispatchTool(
    'submitReviewDecision',
    { requestId: 'TICKET-2002', decision: { action: 'reject', reviewer: 'Jamie', reason: 'double check' } },
    randomUUID(),
    { queueDir, logPath }
  );

  const body = JSON.parse(result.content[0].text);
  assert.equal(body.ok, true);

  const requeued = JSON.parse(readFileSync(join(queueDir, 'TICKET-2002.json'), 'utf8'));

  assert.equal(requeued.category, 'sql_database_issue');
  assert.equal(requeued.priority, 'high');
  assert.equal(requeued.reclassificationSkipped, true);
  assert.equal(requeued.previouslyRejected, true);
  assert.equal(requeued.rejectionCount, 1);
});

test('reject fails closed, without requeuing, when the ticket has no valid existing classification', async () => {
  const queueDir = tempQueueDir();
  const logPath = tempLogPath();

  addTicketToQueue(
    {
      requestId: 'TICKET-2003',
      requestText: 'Some request text.',
      status: 'unclassified',
      priority: null,
      createdAt: '2026-01-01T00:00:00.000Z',
    },
    { queueDir }
  );

  const result = await dispatchTool(
    'submitReviewDecision',
    { requestId: 'TICKET-2003', decision: { action: 'reject', reviewer: 'Jamie' } },
    randomUUID(),
    { queueDir, logPath }
  );

  const body = JSON.parse(result.content[0].text);
  assert.equal(body.ok, false);
  assert.equal(body.reviewResult.reason, 'invalid_classification');

  // Never requeued/mutated — the original unclassified ticket is untouched.
  const untouched = JSON.parse(readFileSync(join(queueDir, 'TICKET-2003.json'), 'utf8'));
  assert.equal(untouched.previouslyRejected, undefined);
});
