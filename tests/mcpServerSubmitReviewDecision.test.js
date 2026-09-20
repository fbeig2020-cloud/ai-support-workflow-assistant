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

function tempSummariesDir() {
  return join(TMP_DIR, `summaries-${randomUUID()}`);
}

test.before(() => {
  mkdirSync(TMP_DIR, { recursive: true });
});

test.after(() => {
  rmSync(TMP_DIR, { recursive: true, force: true });
});

function readAuditLines(logPath) {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
}

// --- submitReviewDecision reject: reclassification wiring ---------------------

test('reject re-runs classification on the original request text and requeues with the fresh category/priority, and regenerates search/draft to match — never leaving them tied to the old category', async () => {
  const queueDir = tempQueueDir();
  const logPath = tempLogPath();

  // Seeded with a deliberately stale/wrong classification, AND a
  // deliberately stale kbSearchResult/draftResponse tied to that wrong
  // category — proving the reject path overwrites them to match the fresh
  // classification rather than leaving them mismatched. requestText's real
  // signals ("password", "log in", "urgent") point at login_problem/urgent,
  // not the general_support_request/low it was originally (mis)classified
  // as.
  addTicketToQueue(
    {
      requestId: 'TICKET-2001',
      requestText: "My password is wrong and I can't log in, this is urgent.",
      category: 'general_support_request',
      priority: 'low',
      createdAt: '2026-01-01T00:00:00.000Z',
      kbSearchResult: { found: false, confidence: 'none', results: [] },
      draftResponse: { generated: true, editable: true, draftText: 'stale draft for general_support_request', category: 'general_support_request', templateUsed: 'default', kbConfidence: 'none' },
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

  // STORY-013: kbSearchResult/draftResponse now match the NEW category,
  // not the stale general_support_request data seeded above.
  assert.equal(requeued.kbSearchResult.found, true);
  assert.ok(requeued.kbSearchResult.results.every((r) => r.category === 'login_problem'));
  assert.equal(requeued.draftResponse.generated, true);
  assert.equal(requeued.draftResponse.category, 'login_problem');
  assert.notEqual(requeued.draftResponse.draftText, 'stale draft for general_support_request');
  assert.equal('kbSearchFailed' in requeued, false);
  assert.equal('draftGenerationFailed' in requeued, false);
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

// --- submitReviewDecision approve: STORY-013 wiring ---------------------------

test('approve: a fully-prepared ticket (classified, searched, drafted) produces and saves a complete summary, and is removed from the queue', async () => {
  const queueDir = tempQueueDir();
  const logPath = tempLogPath();
  const summariesDir = tempSummariesDir();
  const id = 'TICKET-3001';

  addTicketToQueue(
    {
      requestId: id,
      requestText: "I can't log into my account, it keeps saying my password is wrong.",
      status: 'classified',
      category: 'login_problem',
      priority: 'high',
      createdAt: '2026-01-01T00:00:00.000Z',
      kbSearchResult: {
        found: true,
        confidence: 'medium',
        results: [
          {
            id: 'KB-000',
            title: 'Reset a forgotten password',
            category: 'login_problem',
            steps: ['Go to account settings.', 'Click "Reset password".'],
            score: 3,
            confidence: 'medium',
          },
        ],
      },
      draftResponse: {
        generated: true,
        editable: true,
        draftText: 'Hi,\n\nThanks for reaching out about your login issue.\n\nBest,\nSupport Team',
        category: 'login_problem',
        templateUsed: 'login_problem',
        kbConfidence: 'medium',
      },
    },
    { queueDir }
  );

  const result = await dispatchTool(
    'submitReviewDecision',
    { requestId: id, decision: { action: 'approve', reviewer: 'Jamie' } },
    randomUUID(),
    { queueDir, logPath, summariesDir }
  );

  const body = JSON.parse(result.content[0].text);
  assert.equal(body.generated, true);
  assert.match(body.summaryText, new RegExp(`Support Summary — Ticket ${id}`));
  assert.match(body.summaryText, /Review: Approved by Jamie\./);
  assert.match(body.summaryText, /Found \(confidence: medium\)\. Articles used: Reset a forgotten password\./);
  assert.match(body.summaryText, /Generated \(template: login_problem\)\./);

  // Saved to disk under the real saveSupportSummary.js shape.
  const savedPath = join(summariesDir, `${id}.json`);
  assert.equal(existsSync(savedPath), true);
  const saved = JSON.parse(readFileSync(savedPath, 'utf8'));
  assert.equal(saved.ticketId, id);
  assert.equal(saved.summaryText, body.summaryText);
  assert.equal(typeof saved.savedAt, 'string');

  // Ticket removed from the queue on a successful approve.
  assert.equal(existsSync(join(queueDir, `${id}.json`)), false);

  const auditLines = readAuditLines(logPath);
  assert.ok(auditLines.some((l) => l.entry.event === 'support_summary_generated'));
  assert.ok(auditLines.some((l) => l.entry.event === 'support_summary_saved'));
});

test('approve: a ticket predating search/draft (classified, has requestText, no kbSearchResult/draftResponse) still approves — honest fallback, never fails closed', async () => {
  const queueDir = tempQueueDir();
  const logPath = tempLogPath();
  const summariesDir = tempSummariesDir();
  const id = 'TICKET-3002';

  addTicketToQueue(
    {
      requestId: id,
      requestText: 'I need help resetting my password.',
      status: 'classified',
      category: 'login_problem',
      priority: 'medium',
      createdAt: '2026-01-01T00:00:00.000Z',
    },
    { queueDir }
  );

  const result = await dispatchTool(
    'submitReviewDecision',
    { requestId: id, decision: { action: 'approve', reviewer: 'Jamie' } },
    randomUUID(),
    { queueDir, logPath, summariesDir }
  );

  const body = JSON.parse(result.content[0].text);
  assert.equal(body.generated, true);
  assert.match(body.summaryText, /No knowledge-base search recorded for this ticket\./);
  assert.match(body.summaryText, /Not generated — This ticket predates automatic draft-response generation\./);

  assert.equal(existsSync(join(summariesDir, `${id}.json`)), true);
  assert.equal(existsSync(join(queueDir, `${id}.json`)), false);
});

test('approve fails closed, without saving or dequeuing, when the ticket has no valid existing classification', async () => {
  const queueDir = tempQueueDir();
  const logPath = tempLogPath();
  const summariesDir = tempSummariesDir();
  const id = 'TICKET-3003';

  addTicketToQueue(
    {
      requestId: id,
      requestText: 'Some request text.',
      status: 'unclassified',
      priority: null,
      createdAt: '2026-01-01T00:00:00.000Z',
    },
    { queueDir }
  );

  const result = await dispatchTool(
    'submitReviewDecision',
    { requestId: id, decision: { action: 'approve', reviewer: 'Jamie' } },
    randomUUID(),
    { queueDir, logPath, summariesDir }
  );

  const body = JSON.parse(result.content[0].text);
  assert.equal(body.ok, false);
  assert.equal(body.classificationReviewResult.reason, 'invalid_classification');

  assert.equal(existsSync(join(summariesDir, `${id}.json`)), false);
  assert.equal(existsSync(join(queueDir, `${id}.json`)), true); // never dequeued
});
