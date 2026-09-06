import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ingestSupportTicket } from '../src/ingestSupportTicket.js';

// Own subdirectory per file, same reason as the other tests/*.test.js files:
// node --test runs files concurrently, so a shared literal tmp dir name races.
const TMP_DIR = join('tests/tmp', `ingestSupportTicket-${randomUUID()}`);

function tempQueueDir() {
  return join(TMP_DIR, `queue-${randomUUID()}`);
}

function ticketPath(queueDir, id) {
  return join(queueDir, `${id}.json`);
}

function studentPath(queueDir, id) {
  return join(queueDir, `${id}.student.json`);
}

/** logEntry must never carry student contact info, in any shape. */
function assertLogEntryHasNoStudentInfo(logEntry) {
  assert.doesNotMatch(JSON.stringify(logEntry), /studentEmail|studentName/);
}

test.before(() => {
  mkdirSync(TMP_DIR, { recursive: true });
});

test.after(() => {
  rmSync(TMP_DIR, { recursive: true, force: true });
});

// --- Happy path -----------------------------------------------------------

test('valid input creates both the ticket file and the student-info file', () => {
  const queueDir = tempQueueDir();
  const id = 'TICKET-1001';

  const result = ingestSupportTicket(
    {
      ticketId: id,
      requestText: 'My financial aid disbursement has not arrived.',
      studentEmail: 'student@example.edu',
    },
    { queueDir }
  );

  assert.equal(result.ok, true);
  assert.equal(result.saved, true);
  assert.equal(result.path, ticketPath(queueDir, id));
  assert.equal(result.studentPath, studentPath(queueDir, id));
  assert.equal(existsSync(result.path), true);
  assert.equal(existsSync(result.studentPath), true);

  const onDisk = JSON.parse(readFileSync(result.path, 'utf8'));
  assert.equal(onDisk.status, 'unclassified');
  assert.equal(onDisk.priority, null);
  assert.equal('studentEmail' in onDisk, false);
  assert.equal('studentName' in onDisk, false);

  assertLogEntryHasNoStudentInfo(result.logEntry);
});

// --- Failure paths (fails closed) ------------------------------------------

test('fails closed when ticketId is missing or blank', () => {
  const queueDir = tempQueueDir();
  for (const ticketId of [undefined, '', '   ']) {
    const result = ingestSupportTicket(
      {
        ticketId,
        requestText: 'Some request text.',
        studentEmail: 'student@example.edu',
      },
      { queueDir }
    );
    assert.equal(result.ok, false);
    assert.equal(result.saved, false);
    assertLogEntryHasNoStudentInfo(result.logEntry);
  }
});

test('fails closed when ticketId is unsafe (path separators or ..)', () => {
  const queueDir = tempQueueDir();
  for (const ticketId of ['../../etc/passwd', 'a/b', 'a\\b', '..']) {
    const result = ingestSupportTicket(
      {
        ticketId,
        requestText: 'Some request text.',
        studentEmail: 'student@example.edu',
      },
      { queueDir }
    );
    assert.equal(result.ok, false);
    assert.equal(result.saved, false);
    assertLogEntryHasNoStudentInfo(result.logEntry);
  }
});

test('fails closed when requestText is missing or blank', () => {
  const queueDir = tempQueueDir();
  for (const requestText of [undefined, '', '   ']) {
    const result = ingestSupportTicket({ ticketId: 'TICKET-1001', requestText, studentEmail: 'student@example.edu' }, { queueDir });
    assert.equal(result.ok, false);
    assert.equal(result.saved, false);
    assertLogEntryHasNoStudentInfo(result.logEntry);
  }
});

test('fails closed when studentEmail is missing or blank', () => {
  const queueDir = tempQueueDir();
  for (const studentEmail of [undefined, '', '   ']) {
    const result = ingestSupportTicket({ ticketId: 'TICKET-1001', requestText: 'Some request text.', studentEmail }, { queueDir });
    assert.equal(result.ok, false);
    assert.equal(result.saved, false);
    assertLogEntryHasNoStudentInfo(result.logEntry);
  }
});

test('fails closed when studentName or source is not a string', () => {
  const queueDir = tempQueueDir();

  const nameResult = ingestSupportTicket(
    {
      ticketId: 'TICKET-1001',
      requestText: 'Some request text.',
      studentEmail: 'student@example.edu',
      studentName: 12345,
    },
    { queueDir }
  );
  assert.equal(nameResult.ok, false);
  assert.equal(nameResult.saved, false);
  assertLogEntryHasNoStudentInfo(nameResult.logEntry);

  const sourceResult = ingestSupportTicket(
    {
      ticketId: 'TICKET-1002',
      requestText: 'Some request text.',
      studentEmail: 'student@example.edu',
      source: 999,
    },
    { queueDir }
  );
  assert.equal(sourceResult.ok, false);
  assert.equal(sourceResult.saved, false);
  assertLogEntryHasNoStudentInfo(sourceResult.logEntry);
});

// --- addTicketToQueue failure passes through --------------------------------

test('an addTicketToQueue failure passes through as-is, without writing student info', () => {
  const queueDir = tempQueueDir();
  const id = 'TICKET-1001';
  // Pre-occupy the ticket's own target path as a directory so
  // addTicketToQueue's writeFileSync fails.
  mkdirSync(ticketPath(queueDir, id), { recursive: true });

  const result = ingestSupportTicket(
    {
      ticketId: id,
      requestText: 'Some request text.',
      studentEmail: 'student@example.edu',
    },
    { queueDir }
  );

  assert.equal(result.ok, false);
  assert.equal(result.saved, false);
  assert.equal(existsSync(studentPath(queueDir, id)), false);
  assertLogEntryHasNoStudentInfo(result.logEntry);
});
