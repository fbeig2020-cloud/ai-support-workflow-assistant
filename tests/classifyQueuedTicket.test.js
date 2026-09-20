import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { classifyQueuedTicket } from '../src/classifyQueuedTicket.js';

// Own subdirectory per file, same reason as the other tests/*.test.js files:
// node --test runs files concurrently, so a shared literal tmp dir name races.
const TMP_DIR = join('tests/tmp', `classifyQueuedTicket-${randomUUID()}`);

function tempQueueDir() {
  return join(TMP_DIR, `queue-${randomUUID()}`);
}

function tempLogPath() {
  return join(TMP_DIR, `audit-${randomUUID()}.log`);
}

function ticketPath(queueDir, id) {
  return join(queueDir, `${id}.json`);
}

function seedTicket(queueDir, ticket) {
  mkdirSync(queueDir, { recursive: true });
  writeFileSync(ticketPath(queueDir, ticket.requestId), JSON.stringify(ticket, null, 2), 'utf8');
}

function readTicket(queueDir, id) {
  return JSON.parse(readFileSync(ticketPath(queueDir, id), 'utf8'));
}

function readAuditLines(logPath) {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
}

test.before(() => {
  mkdirSync(TMP_DIR, { recursive: true });
});

test.after(() => {
  rmSync(TMP_DIR, { recursive: true, force: true });
});

// --- Recovery case (b): pre-existing unclassified ticket, e.g. TICKET-DEMO-002 --

test('classifies a ticket sitting at status unclassified with no category (pre-existing fixture), and runs search+draft to match', async () => {
  const queueDir = tempQueueDir();
  const logPath = tempLogPath();
  const id = 'TICKET-2001';
  seedTicket(queueDir, {
    requestId: id,
    // Same fixture classify.test.js validates as login_problem/high.
    requestText: "I can't log in to my account, it says I'm locked out after too many attempts.",
    status: 'unclassified',
    priority: null,
    createdAt: '2026-09-19T00:00:00.000Z',
    source: 'demo',
    // Deliberately unreachable in real production data (eligibility requires
    // no prior classification, so a real eligible ticket could never carry
    // this) — seeded anyway to mechanically prove overwrite-not-merge
    // behavior rather than just trusting the code's spread-then-assign order.
    kbSearchResult: 'STALE_PLACEHOLDER',
    draftResponse: 'STALE_PLACEHOLDER',
  });

  const result = await classifyQueuedTicket(id, { queueDir, logPath });

  assert.equal(result.ok, true);
  assert.equal(result.classified, true);
  assert.equal(result.category, 'login_problem');
  assert.equal(result.priority, 'high');
  assert.equal(result.auditResult.ok, true);
  assert.equal(result.preparationAuditResult.ok, true);

  const onDisk = readTicket(queueDir, id);
  assert.equal(onDisk.status, 'classified');
  assert.equal(onDisk.category, 'login_problem');
  assert.equal(onDisk.priority, 'high');
  // Original fields are preserved.
  assert.equal(onDisk.source, 'demo');
  assert.equal(onDisk.createdAt, '2026-09-19T00:00:00.000Z');

  // STORY-013: search and draft ran against the fresh classification and
  // overwrote (never merged with) the stale seeded placeholders.
  assert.notEqual(onDisk.kbSearchResult, 'STALE_PLACEHOLDER');
  assert.notEqual(onDisk.draftResponse, 'STALE_PLACEHOLDER');
  assert.equal(typeof onDisk.kbSearchResult, 'object');
  assert.equal(typeof onDisk.kbSearchResult.found, 'boolean');
  assert.equal(typeof onDisk.draftResponse, 'object');
  assert.equal(typeof onDisk.draftResponse.generated, 'boolean');
  assert.equal('kbSearchFailed' in onDisk, false);
  assert.equal('draftGenerationFailed' in onDisk, false);

  const auditLines = readAuditLines(logPath);
  assert.equal(auditLines.length, 2);
  assert.equal(auditLines[1].entry.event, 'queued_ticket_search_and_draft_prepared');
  assert.equal(auditLines[1].entry.context.requestId, id);
  assert.equal(auditLines[1].entry.context.category, 'login_problem');
});

// --- Recovery case (a): retry after classificationError: true ----------------

test('retries a ticket that has classificationError: true, clearing the flag on success, and runs search+draft to match', async () => {
  const queueDir = tempQueueDir();
  const logPath = tempLogPath();
  const id = 'TICKET-2002';
  seedTicket(queueDir, {
    requestId: id,
    // Same fixture classify.test.js validates as power_bi_report_issue.
    requestText: 'My Power BI dashboard report is blank after the dataset refresh failed.',
    status: 'unclassified',
    priority: null,
    createdAt: '2026-09-19T00:00:00.000Z',
    classificationError: true,
    classificationErrorMessage: 'classifySupportRequest returned a malformed result',
  });

  const result = await classifyQueuedTicket(id, { queueDir, logPath });

  assert.equal(result.ok, true);
  assert.equal(result.classified, true);
  assert.equal(result.category, 'power_bi_report_issue');
  assert.equal(result.preparationAuditResult.ok, true);

  const onDisk = readTicket(queueDir, id);
  assert.equal(onDisk.status, 'classified');
  assert.equal('classificationError' in onDisk, false);
  assert.equal('classificationErrorMessage' in onDisk, false);

  // STORY-013: a recovered ticket ends up just as complete as a
  // freshly-ingested one — search and draft ran against the new
  // classification, not left permanently missing.
  assert.equal(typeof onDisk.kbSearchResult, 'object');
  assert.equal(typeof onDisk.kbSearchResult.found, 'boolean');
  assert.equal(typeof onDisk.draftResponse, 'object');
  assert.equal(typeof onDisk.draftResponse.generated, 'boolean');
});

// --- Already classified: skip quietly, never overwrite -----------------------

test('skips quietly and does not overwrite a ticket already at status classified', async () => {
  const queueDir = tempQueueDir();
  const logPath = tempLogPath();
  const id = 'TICKET-2003';
  const original = {
    requestId: id,
    requestText: 'I need access to the reporting database.',
    status: 'classified',
    category: 'access_permission_issue',
    priority: 'medium',
    createdAt: '2026-09-19T00:00:00.000Z',
  };
  seedTicket(queueDir, original);

  const result = await classifyQueuedTicket(id, { queueDir, logPath });

  assert.equal(result.ok, true);
  assert.equal(result.skipped, true);
  assert.equal(result.status, 'classified');

  const onDisk = readTicket(queueDir, id);
  assert.deepEqual(onDisk, original);
  assert.equal(existsSync(logPath), false); // nothing was classified, nothing was audited
});

test('skips quietly when status is neither "unclassified" nor flagged with classificationError (e.g. a legacy fixture with no status field)', async () => {
  const queueDir = tempQueueDir();
  const logPath = tempLogPath();
  const id = 'TICKET-2004';
  // Mirrors TICKET-DEMO-001's real shape: already has a category from the
  // old reject-reclassify flow, but the 'status' field was never set.
  const original = {
    requestId: id,
    category: 'login_problem',
    priority: 'high',
    summary: "I can't log into my account.",
    createdAt: '2026-09-19T00:00:00.000Z',
  };
  seedTicket(queueDir, original);

  const result = await classifyQueuedTicket(id, { queueDir, logPath });

  assert.equal(result.ok, true);
  assert.equal(result.skipped, true);
  assert.equal(result.status, null);

  const onDisk = readTicket(queueDir, id);
  assert.deepEqual(onDisk, original);
});

// --- Fail closed: no requestText to classify from -----------------------------

test('fails closed when an eligible ticket has no requestText', async () => {
  const queueDir = tempQueueDir();
  const logPath = tempLogPath();
  const id = 'TICKET-2005';
  const original = {
    requestId: id,
    status: 'unclassified',
    priority: null,
    createdAt: '2026-09-19T00:00:00.000Z',
  };
  seedTicket(queueDir, original);

  const result = await classifyQueuedTicket(id, { queueDir, logPath });

  assert.equal(result.ok, false);
  assert.equal(result.classified, false);
  assert.equal(result.errorClass, 'ValidationError');
  assert.match(result.message, /no requestText/);

  const onDisk = readTicket(queueDir, id);
  assert.deepEqual(onDisk, original);
  assert.equal(existsSync(logPath), false);
});

// --- Not found / invalid id ---------------------------------------------------

test('reports found: false for a requestId not in the queue', async () => {
  const queueDir = tempQueueDir();
  const result = await classifyQueuedTicket('TICKET-DOES-NOT-EXIST', { queueDir });
  assert.equal(result.ok, false);
  assert.equal(result.found, false);
});

test('fails closed for a missing, blank, or unsafe requestId', async () => {
  const queueDir = tempQueueDir();
  for (const requestId of [undefined, '', '   ', '../../etc/passwd', 'a/b']) {
    const result = await classifyQueuedTicket(requestId, { queueDir });
    assert.equal(result.ok, false);
    assert.equal(result.errorClass, 'ValidationError');
  }
});
