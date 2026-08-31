import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { addTicketToQueue, listQueuedTickets, removeTicketFromQueue } from '../src/ticketQueue.js';

// Own subdirectory per file, same reason as the other tests/*.test.js files:
// node --test runs files concurrently, so a shared literal tmp dir name races.
const TMP_DIR = join('tests/tmp', `ticketQueue-${randomUUID()}`);

function tempQueueDir() {
  return join(TMP_DIR, `queue-${randomUUID()}`);
}

/** Capture stderr writes for the duration of `fn`, then restore. */
function captureStderr(fn) {
  const writes = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...args) => {
    writes.push(String(chunk));
    return original(chunk, ...args);
  };
  try {
    fn();
  } finally {
    process.stderr.write = original;
  }
  return writes;
}

function ticket(overrides = {}) {
  return {
    requestId: 'TICKET-1001',
    priority: 'high',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

test.before(() => {
  mkdirSync(TMP_DIR, { recursive: true });
});

test.after(() => {
  rmSync(TMP_DIR, { recursive: true, force: true });
});

// --- addTicketToQueue: happy path ---------------------------------------------

test('adds a ticket to queue/<requestId>.json', () => {
  const queueDir = tempQueueDir();
  const result = addTicketToQueue(ticket(), { queueDir });

  assert.equal(result.ok, true);
  assert.equal(result.saved, true);
  assert.equal(result.path, join(queueDir, 'TICKET-1001.json'));
  assert.equal(existsSync(result.path), true);

  const onDisk = JSON.parse(readFileSync(result.path, 'utf8'));
  assert.equal(onDisk.requestId, 'TICKET-1001');
  assert.equal(onDisk.priority, 'high');
});

test('creates the queue directory when it does not exist yet', () => {
  const queueDir = join(tempQueueDir(), 'nested', 'path');
  const result = addTicketToQueue(ticket(), { queueDir });

  assert.equal(result.ok, true);
  assert.equal(existsSync(queueDir), true);
});

test('adding the same ticket twice overwrites the same file rather than creating a duplicate', () => {
  const queueDir = tempQueueDir();
  addTicketToQueue(ticket(), { queueDir });
  const second = addTicketToQueue(ticket({ priority: 'urgent' }), { queueDir });

  assert.equal(second.ok, true);
  const files = existsSync(queueDir) ? readdirSync(queueDir) : [];
  assert.deepEqual(files, ['TICKET-1001.json']);

  const onDisk = JSON.parse(readFileSync(second.path, 'utf8'));
  assert.equal(onDisk.priority, 'urgent');
});

test('a successful add logs a success entry with the expected shape', () => {
  const queueDir = tempQueueDir();
  const result = addTicketToQueue(ticket(), { queueDir });

  assert.equal(result.logEntry.service, 'ticketQueue');
  assert.equal(result.logEntry.event, 'ticket_queued');
  assert.equal(result.logEntry.outcome, 'success');
  assert.equal(result.logEntry.level, 'info');
  assert.equal(result.logEntry.context.requestId, 'TICKET-1001');
  assert.ok(!Number.isNaN(Date.parse(result.logEntry.timestamp)));
});

// --- addTicketToQueue: failure paths (fails closed) ---------------------------

test('fails closed when requestId is missing', () => {
  const queueDir = tempQueueDir();
  const { requestId, ...withoutRequestId } = ticket();
  const result = addTicketToQueue(withoutRequestId, { queueDir });

  assert.equal(result.ok, false);
  assert.equal(result.saved, false);
  assert.equal(result.logEntry.context.reason, 'invalid_request_id');
});

test('fails closed when requestId contains unsafe filesystem characters', () => {
  const queueDir = tempQueueDir();
  const unsafeIds = ['../../etc/passwd', 'a/b', 'a\\b', 'ticket 1001', ''];
  for (const requestId of unsafeIds) {
    const result = addTicketToQueue(ticket({ requestId }), { queueDir });
    assert.equal(result.ok, false);
    assert.notEqual(result.logEntry.context.reason, undefined);
  }
  assert.equal(existsSync(queueDir), false);
});

test('never throws on completely malformed ticket inputs', () => {
  const queueDir = tempQueueDir();
  const badInputs = [null, undefined, 'not an object', 42, [], []];
  for (const bad of badInputs) {
    const result = addTicketToQueue(bad, { queueDir });
    assert.equal(result.ok, false);
    assert.equal(result.saved, false);
  }
});

test('a malformed-ticket failure is still logged, with a failure outcome', () => {
  const queueDir = tempQueueDir();
  const result = addTicketToQueue(null, { queueDir });
  assert.equal(result.logEntry.service, 'ticketQueue');
  assert.equal(result.logEntry.event, 'ticket_queue_add_failed');
  assert.equal(result.logEntry.outcome, 'failure');
  assert.equal(result.logEntry.level, 'warn');
  assert.equal(result.logEntry.error_class, 'ValidationError');
});

test('an add blocked by a same-named file fails closed with an alert, never throws', () => {
  const blocker = join(TMP_DIR, `blocker-${randomUUID()}`);
  writeFileSync(blocker, 'i am a file, not a directory', 'utf8');

  const writes = captureStderr(() => {
    const result = addTicketToQueue(ticket(), { queueDir: blocker });
    assert.equal(result.ok, false);
    assert.equal(result.saved, false);
    assert.match(result.message, /not added to queue/);
  });
  assert.ok(writes.some((line) => line.startsWith('ALERT: ticket queue write failed')));
});

// --- listQueuedTickets: happy path ---------------------------------------------

test('lists queued tickets sorted by priority, urgent first', () => {
  const queueDir = tempQueueDir();
  addTicketToQueue(ticket({ requestId: 'T-LOW', priority: 'low' }), { queueDir });
  addTicketToQueue(ticket({ requestId: 'T-URGENT', priority: 'urgent' }), { queueDir });
  addTicketToQueue(ticket({ requestId: 'T-MEDIUM', priority: 'medium' }), { queueDir });
  addTicketToQueue(ticket({ requestId: 'T-HIGH', priority: 'high' }), { queueDir });

  const result = listQueuedTickets({ queueDir });
  assert.deepEqual(
    result.map((t) => t.requestId),
    ['T-URGENT', 'T-HIGH', 'T-MEDIUM', 'T-LOW']
  );
  assert.deepEqual(result.skipped, []);
});

test('breaks a priority tie by earliest createdAt', () => {
  const queueDir = tempQueueDir();
  addTicketToQueue(ticket({ requestId: 'T-LATER', priority: 'high', createdAt: '2026-01-02T00:00:00.000Z' }), { queueDir });
  addTicketToQueue(ticket({ requestId: 'T-EARLIER', priority: 'high', createdAt: '2026-01-01T00:00:00.000Z' }), { queueDir });

  const result = listQueuedTickets({ queueDir });
  assert.deepEqual(
    result.map((t) => t.requestId),
    ['T-EARLIER', 'T-LATER']
  );
});

// --- listQueuedTickets: empty queue --------------------------------------------

test('returns an empty array when the queue directory does not exist yet', () => {
  const queueDir = tempQueueDir();
  const result = listQueuedTickets({ queueDir });

  assert.deepEqual(Array.from(result), []);
  assert.deepEqual(result.skipped, []);
});

test('returns an empty array when the queue directory exists but is empty', () => {
  const queueDir = tempQueueDir();
  mkdirSync(queueDir, { recursive: true });
  const result = listQueuedTickets({ queueDir });

  assert.deepEqual(Array.from(result), []);
  assert.deepEqual(result.skipped, []);
});

// --- listQueuedTickets: corrupt file handling (fails closed) ------------------

test('skips a corrupt (non-JSON) file rather than crashing the whole listing', () => {
  const queueDir = tempQueueDir();
  mkdirSync(queueDir, { recursive: true });
  addTicketToQueue(ticket({ requestId: 'T-GOOD' }), { queueDir });
  writeFileSync(join(queueDir, 'T-CORRUPT.json'), '{ not valid json', 'utf8');

  const result = listQueuedTickets({ queueDir });
  assert.deepEqual(
    result.map((t) => t.requestId),
    ['T-GOOD']
  );
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].file, 'T-CORRUPT.json');
  assert.equal(result.skipped[0].reason, 'corrupt_json');
});

test('skips a file whose JSON is valid but not a ticket shape', () => {
  const queueDir = tempQueueDir();
  mkdirSync(queueDir, { recursive: true });
  writeFileSync(join(queueDir, 'T-WRONGSHAPE.json'), JSON.stringify(['not', 'a', 'ticket']), 'utf8');

  const result = listQueuedTickets({ queueDir });
  assert.deepEqual(Array.from(result), []);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].reason, 'invalid_ticket_shape');
});

test('ignores non-JSON files in the queue directory', () => {
  const queueDir = tempQueueDir();
  mkdirSync(queueDir, { recursive: true });
  addTicketToQueue(ticket({ requestId: 'T-GOOD' }), { queueDir });
  writeFileSync(join(queueDir, 'notes.txt'), 'not a ticket file', 'utf8');

  const result = listQueuedTickets({ queueDir });
  assert.deepEqual(
    result.map((t) => t.requestId),
    ['T-GOOD']
  );
  assert.deepEqual(result.skipped, []);
});

// --- removeTicketFromQueue: happy path ------------------------------------------

test('removes a queued ticket by id', () => {
  const queueDir = tempQueueDir();
  addTicketToQueue(ticket(), { queueDir });
  const path = join(queueDir, 'TICKET-1001.json');
  assert.equal(existsSync(path), true);

  const result = removeTicketFromQueue('TICKET-1001', { queueDir });
  assert.equal(result.ok, true);
  assert.equal(existsSync(path), false);
});

test('a successful remove logs a success entry with the expected shape', () => {
  const queueDir = tempQueueDir();
  addTicketToQueue(ticket(), { queueDir });
  const result = removeTicketFromQueue('TICKET-1001', { queueDir });

  assert.equal(result.logEntry.service, 'ticketQueue');
  assert.equal(result.logEntry.event, 'ticket_removed_from_queue');
  assert.equal(result.logEntry.outcome, 'success');
  assert.equal(result.logEntry.context.requestId, 'TICKET-1001');
});

// --- removeTicketFromQueue: failure paths (fails closed) ------------------------

test('fails closed when the ticket does not exist, never throws', () => {
  const queueDir = tempQueueDir();
  mkdirSync(queueDir, { recursive: true });

  const result = removeTicketFromQueue('NOT-A-REAL-TICKET', { queueDir });
  assert.equal(result.ok, false);
  assert.notEqual(result.message, undefined);
});

test('fails closed when the queue directory does not exist yet, never throws', () => {
  const queueDir = tempQueueDir();
  const result = removeTicketFromQueue('TICKET-1001', { queueDir });
  assert.equal(result.ok, false);
});

test('rejects an unsafe ticket id without ever touching the filesystem', () => {
  const queueDir = tempQueueDir();
  const unsafeIds = ['../../etc/passwd', 'a/b', 'a\\b', 'ticket 1001', ''];
  for (const id of unsafeIds) {
    const result = removeTicketFromQueue(id, { queueDir });
    assert.equal(result.ok, false);
  }
});

test('never throws on completely malformed ticketId inputs', () => {
  const queueDir = tempQueueDir();
  const badInputs = [null, undefined, 42, {}, []];
  for (const bad of badInputs) {
    const result = removeTicketFromQueue(bad, { queueDir });
    assert.equal(result.ok, false);
  }
});

// --- Purity / idempotency -------------------------------------------------------

test('removing a ticket twice is safe: second call fails closed rather than throwing', () => {
  const queueDir = tempQueueDir();
  addTicketToQueue(ticket(), { queueDir });

  const first = removeTicketFromQueue('TICKET-1001', { queueDir });
  const second = removeTicketFromQueue('TICKET-1001', { queueDir });

  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
});
