import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { classifyAndLog, reviewAndLog } from '../src/auditedActions.js';
import { classifySupportRequest } from '../src/classify.js';

// Each test file gets its own unique subdirectory (not the shared 'tests/tmp'
// root) because node --test runs files concurrently in separate processes;
// a shared literal directory name means one file's cleanup can delete the
// directory out from under another file's still-running test.
const TMP_DIR = join('tests/tmp', `auditedActions-${randomUUID()}`);

function tempLogPath() {
  return join(TMP_DIR, `audit-${randomUUID()}.log`);
}

function readLines(logPath) {
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

// --- classifyAndLog: an action is logged when it occurs -------------------

test('classifyAndLog returns the same shape classifySupportRequest would', () => {
  const logPath = tempLogPath();
  const direct = classifySupportRequest("I can't log in, locked out.");
  const wrapped = classifyAndLog("I can't log in, locked out.", { logPath });

  assert.equal(wrapped.category, direct.category);
  assert.equal(wrapped.priority, direct.priority);
  assert.equal(wrapped.summary, direct.summary);
});

test('classifyAndLog persists the classification logEntry to the audit trail', () => {
  const logPath = tempLogPath();
  const result = classifyAndLog('Power BI dashboard is blank.', { logPath });

  assert.equal(result.auditResult.ok, true);
  const [record] = readLines(logPath);
  assert.deepEqual(record.entry, result.logEntry);
  assert.equal(record.entry.event, 'support_request_classified');
});

test('classifyAndLog logs even a failed classification (empty input)', () => {
  const logPath = tempLogPath();
  const result = classifyAndLog('', { logPath });

  assert.equal(result.auditResult.ok, true);
  const [record] = readLines(logPath);
  assert.equal(record.entry.outcome, 'failure');
});

// --- reviewAndLog: an action is logged when it occurs ----------------------

const VALID_CLASSIFICATION = { category: 'login_problem', priority: 'high', summary: 'locked out' };

test('reviewAndLog returns the same shape reviewClassification would, for approve', () => {
  const logPath = tempLogPath();
  const decision = { action: 'approve', reviewer: 'agent.jane' };
  const result = reviewAndLog(VALID_CLASSIFICATION, decision, { logPath });

  assert.equal(result.ok, true);
  assert.equal(result.outcome, 'approved');
  assert.deepEqual(result.classification, VALID_CLASSIFICATION);
});

test('reviewAndLog persists the approval logEntry to the audit trail', () => {
  const logPath = tempLogPath();
  const decision = { action: 'approve', reviewer: 'agent.jane' };
  const result = reviewAndLog(VALID_CLASSIFICATION, decision, { logPath });

  assert.equal(result.auditResult.ok, true);
  const [record] = readLines(logPath);
  assert.equal(record.entry.event, 'classification_approved');
  assert.equal(record.entry.context.reviewer, 'agent.jane');
});

test('reviewAndLog persists the rejection logEntry to the audit trail', () => {
  const logPath = tempLogPath();
  const decision = { action: 'reject', reviewer: 'agent.jane', reason: 'wrong category' };
  const result = reviewAndLog(VALID_CLASSIFICATION, decision, { logPath });

  assert.equal(result.outcome, 'rejected');
  assert.equal(result.auditResult.ok, true);
  const [record] = readLines(logPath);
  assert.equal(record.entry.event, 'classification_rejected');
});

test('reviewAndLog still logs a failure entry for malformed decisions (fails closed)', () => {
  const logPath = tempLogPath();
  const result = reviewAndLog(VALID_CLASSIFICATION, { action: 'approve' }, { logPath });

  assert.equal(result.ok, false);
  assert.equal(result.auditResult.ok, true);
  const [record] = readLines(logPath);
  assert.equal(record.entry.event, 'classification_review_failed');
});

// --- Multiple actions on one request chain into one trail -----------------

test('a classify-then-review sequence produces two chained records in order', () => {
  const logPath = tempLogPath();
  const classified = classifyAndLog("Can't log in, account is locked out.", { logPath });
  reviewAndLog(classified, { action: 'approve', reviewer: 'agent.jane' }, { logPath });

  const lines = readLines(logPath);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].entry.event, 'support_request_classified');
  assert.equal(lines[1].entry.event, 'classification_approved');
  assert.equal(lines[1].prevHash, lines[0].hash);
});

// --- Logging failure does not block the underlying action -----------------

test('a blocked audit write still returns the classification result, with auditResult.ok false', () => {
  const blocker = join(TMP_DIR, `blocker-${randomUUID()}`);
  writeFileSync(blocker, 'i am a file, not a directory', 'utf8');
  const logPath = join(blocker, 'audit-trail.log');

  const result = classifyAndLog("I can't log in.", { logPath });

  assert.equal(result.category, 'login_problem');
  assert.equal(result.auditResult.ok, false);
  assert.equal(result.auditResult.error, 'audit_log_write_failed');
});
