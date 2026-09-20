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

function tempLogPath() {
  return join(TMP_DIR, `audit-${randomUUID()}.log`);
}

function ticketPath(queueDir, id) {
  return join(queueDir, `${id}.json`);
}

function studentPath(queueDir, id) {
  return join(queueDir, `${id}.student.json`);
}

function readAuditLines(logPath) {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
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

test('valid input creates both the ticket file and the student-info file, already classified, searched, and drafted', async () => {
  const queueDir = tempQueueDir();
  const logPath = tempLogPath();
  const id = 'TICKET-1001';

  const result = await ingestSupportTicket(
    {
      ticketId: id,
      // Matches none of classify.js's category/priority signal tables, so
      // this deterministically lands on the documented defaults — and
      // general_support_request has neither a knowledge-base article nor a
      // dedicated response template, so this also deterministically
      // exercises the "not found" / "default template" branches of
      // knowledgeBaseSearch.js / generateDraftResponse.js.
      requestText: 'My financial aid disbursement has not arrived.',
      studentEmail: 'student@example.edu',
    },
    { queueDir, logPath }
  );

  assert.equal(result.ok, true);
  assert.equal(result.saved, true);
  assert.equal(result.path, ticketPath(queueDir, id));
  assert.equal(result.studentPath, studentPath(queueDir, id));
  assert.equal(existsSync(result.path), true);
  assert.equal(existsSync(result.studentPath), true);

  const onDisk = JSON.parse(readFileSync(result.path, 'utf8'));
  assert.equal(onDisk.status, 'classified');
  assert.equal(onDisk.category, 'general_support_request');
  assert.equal(onDisk.priority, 'medium');
  assert.equal('classificationError' in onDisk, false);
  assert.equal('studentEmail' in onDisk, false);
  assert.equal('studentName' in onDisk, false);

  // STORY-013: search and draft ran automatically as part of ingestion and
  // landed on the ticket alongside its classification.
  assert.equal('kbSearchFailed' in onDisk, false);
  assert.equal('draftGenerationFailed' in onDisk, false);
  assert.equal(onDisk.kbSearchResult.found, false);
  assert.equal(onDisk.kbSearchResult.confidence, 'none');
  assert.equal(onDisk.draftResponse.generated, true);
  assert.equal(onDisk.draftResponse.templateUsed, 'default');
  assert.equal(typeof onDisk.draftResponse.draftText, 'string');
  assert.notEqual(onDisk.draftResponse.draftText, '');

  assertLogEntryHasNoStudentInfo(result.logEntry);

  // Exactly one combined audit entry for the auto-classify-search-draft
  // step — not three separate rows for classify/search/draft.
  assert.equal(result.classificationAuditResult.ok, true);
  const auditLines = readAuditLines(logPath);
  assert.equal(auditLines.length, 1);
  assert.equal(auditLines[0].entry.event, 'support_ticket_ingested_classified_and_prepared');
  assert.equal(auditLines[0].entry.outcome, 'success');
  assert.equal(auditLines[0].entry.context.requestId, id);
  assert.equal(auditLines[0].entry.context.category, 'general_support_request');
  assert.equal(auditLines[0].entry.context.priority, 'medium');
  assert.equal(auditLines[0].entry.context.kbSearchFound, false);
  assert.equal(auditLines[0].entry.context.kbSearchConfidence, 'none');
  assert.equal(auditLines[0].entry.context.draftGenerated, true);
  assert.equal('kbSearchFailed' in auditLines[0].entry.context, false);
  assert.equal('draftGenerationFailed' in auditLines[0].entry.context, false);
  assert.match(auditLines[0].entry.humanSummary, /automatically classified/);
  assertLogEntryHasNoStudentInfo(auditLines[0].entry);
});

// --- Failure paths (fails closed) ------------------------------------------

test('fails closed when ticketId is missing or blank', async () => {
  const queueDir = tempQueueDir();
  for (const ticketId of [undefined, '', '   ']) {
    const result = await ingestSupportTicket(
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

test('fails closed when ticketId is unsafe (path separators or ..)', async () => {
  const queueDir = tempQueueDir();
  for (const ticketId of ['../../etc/passwd', 'a/b', 'a\\b', '..']) {
    const result = await ingestSupportTicket(
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

test('fails closed when requestText is missing or blank', async () => {
  const queueDir = tempQueueDir();
  for (const requestText of [undefined, '', '   ']) {
    const result = await ingestSupportTicket({ ticketId: 'TICKET-1001', requestText, studentEmail: 'student@example.edu' }, { queueDir });
    assert.equal(result.ok, false);
    assert.equal(result.saved, false);
    assertLogEntryHasNoStudentInfo(result.logEntry);
  }
});

test('fails closed when studentEmail is missing or blank', async () => {
  const queueDir = tempQueueDir();
  for (const studentEmail of [undefined, '', '   ']) {
    const result = await ingestSupportTicket({ ticketId: 'TICKET-1001', requestText: 'Some request text.', studentEmail }, { queueDir });
    assert.equal(result.ok, false);
    assert.equal(result.saved, false);
    assertLogEntryHasNoStudentInfo(result.logEntry);
  }
});

test('fails closed when studentName or source is not a string', async () => {
  const queueDir = tempQueueDir();

  const nameResult = await ingestSupportTicket(
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

  const sourceResult = await ingestSupportTicket(
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

test('an addTicketToQueue failure passes through as-is, without writing student info', async () => {
  const queueDir = tempQueueDir();
  const logPath = tempLogPath();
  const id = 'TICKET-1001';
  // Pre-occupy the ticket's own target path as a directory so
  // addTicketToQueue's writeFileSync fails.
  mkdirSync(ticketPath(queueDir, id), { recursive: true });

  const result = await ingestSupportTicket(
    {
      ticketId: id,
      requestText: 'Some request text.',
      studentEmail: 'student@example.edu',
    },
    { queueDir, logPath }
  );

  assert.equal(result.ok, false);
  assert.equal(result.saved, false);
  assert.equal(existsSync(studentPath(queueDir, id)), false);
  assertLogEntryHasNoStudentInfo(result.logEntry);

  // Classification itself still ran and was still audited, even though the
  // queue write that would have persisted its result failed afterward.
  assert.equal(result.classificationAuditResult.ok, true);
});

// --- Classification failure (classificationError: true) --------------------
//
// No test exercises the classificationError: true branch itself: every fs
// interaction inside classify.js's classifySupportRequest() (loadApprovedOverrides'
// existsSync/readFileSync) is already wrapped in its own fail-closed try/catch,
// and requestText is guaranteed to be a non-blank string by validateInput()
// above before classification ever runs — so there is no legitimate input that
// makes classifySupportRequest() throw or return a malformed result today.
// The guard in ingestSupportTicket() is defensive (Failure-First Design: the
// ticket must never be lost even if that changes later), not exercised by a
// real input here. Forcing it would require mocking classify.js's export,
// which needs Node's --experimental-test-module-mocks flag — not enabled for
// this suite (`npm test` runs plain `node --test`), so that isn't done here.
