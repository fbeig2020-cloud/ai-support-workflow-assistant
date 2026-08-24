import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { saveSupportSummary } from '../src/saveSupportSummary.js';
import { saveSupportSummaryAndLog } from '../src/auditedActions.js';

function readLinesFrom(logPath) {
  return readFileSync(logPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
}

// Own subdirectory per file, same reason as the other tests/*.test.js files:
// node --test runs files concurrently, so a shared literal tmp dir name races.
const TMP_DIR = join('tests/tmp', `saveSupportSummary-${randomUUID()}`);

function tempSummariesDir() {
  return join(TMP_DIR, `summaries-${randomUUID()}`);
}

function tempPath(name) {
  return join(TMP_DIR, `${name}-${randomUUID()}`);
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

const GENERATED_SUMMARY = {
  generated: true,
  summaryText: 'Support Summary — Ticket TICKET-1001\n\n...',
  ticketId: 'TICKET-1001',
  logEntry: { timestamp: new Date().toISOString(), level: 'info', service: 'generateSupportSummary', event: 'support_summary_generated', outcome: 'success', context: {} },
};

test.before(() => {
  mkdirSync(TMP_DIR, { recursive: true });
});

test.after(() => {
  rmSync(TMP_DIR, { recursive: true, force: true });
});

// --- Happy path: a generated summary is saved --------------------------------

test('saves a generated summary to summaries/<ticketId>.json', () => {
  const summariesDir = tempSummariesDir();
  const result = saveSupportSummary(GENERATED_SUMMARY, { summariesDir });

  assert.equal(result.ok, true);
  assert.equal(result.saved, true);
  assert.equal(result.path, join(summariesDir, 'TICKET-1001.json'));
  assert.equal(existsSync(result.path), true);

  const onDisk = JSON.parse(readFileSync(result.path, 'utf8'));
  assert.equal(onDisk.ticketId, 'TICKET-1001');
  assert.equal(onDisk.summaryText, GENERATED_SUMMARY.summaryText);
  assert.ok(!Number.isNaN(Date.parse(onDisk.savedAt)));
});

test('creates the summaries directory when it does not exist yet', () => {
  const summariesDir = join(tempSummariesDir(), 'nested', 'path');
  const result = saveSupportSummary(GENERATED_SUMMARY, { summariesDir });

  assert.equal(result.ok, true);
  assert.equal(existsSync(summariesDir), true);
});

// --- Idempotency: saving twice overwrites, never duplicates -------------------

test('saving the same ticket twice overwrites the same file rather than creating a duplicate', () => {
  const summariesDir = tempSummariesDir();
  saveSupportSummary(GENERATED_SUMMARY, { summariesDir });
  const second = saveSupportSummary({ ...GENERATED_SUMMARY, summaryText: 'Updated summary text.' }, { summariesDir });

  assert.equal(second.ok, true);
  const files = existsSync(summariesDir) ? readdirSync(summariesDir) : [];
  assert.deepEqual(files, ['TICKET-1001.json']);

  const onDisk = JSON.parse(readFileSync(second.path, 'utf8'));
  assert.equal(onDisk.summaryText, 'Updated summary text.');
});

// --- Failure path: malformed summary (fails closed) ---------------------------

test('fails closed when the summary was not actually generated', () => {
  const summariesDir = tempSummariesDir();
  const result = saveSupportSummary({ ...GENERATED_SUMMARY, generated: false }, { summariesDir });

  assert.equal(result.ok, false);
  assert.equal(result.saved, false);
  assert.equal(existsSync(join(summariesDir, 'TICKET-1001.json')), false);
});

test('fails closed when ticketId is missing', () => {
  const summariesDir = tempSummariesDir();
  const { ticketId, ...withoutTicketId } = GENERATED_SUMMARY;
  const result = saveSupportSummary(withoutTicketId, { summariesDir });

  assert.equal(result.ok, false);
  assert.equal(result.logEntry.context.reason, 'invalid_ticket_id');
});

test('fails closed when ticketId contains unsafe filesystem characters', () => {
  const summariesDir = tempSummariesDir();
  const unsafeIds = ['../../etc/passwd', 'a/b', 'a\\b', 'ticket 1001', ''];
  for (const ticketId of unsafeIds) {
    const result = saveSupportSummary({ ...GENERATED_SUMMARY, ticketId }, { summariesDir });
    assert.equal(result.ok, false);
    assert.notEqual(result.logEntry.context.reason, undefined);
  }
});

test('fails closed when summaryText is missing or blank', () => {
  const summariesDir = tempSummariesDir();
  for (const summaryText of [undefined, '', '   ']) {
    const result = saveSupportSummary({ ...GENERATED_SUMMARY, summaryText }, { summariesDir });
    assert.equal(result.ok, false);
    assert.equal(result.logEntry.context.reason, 'invalid_summary_text');
  }
});

test('never throws on completely malformed summary inputs', () => {
  const summariesDir = tempSummariesDir();
  const badInputs = [null, undefined, 'not an object', 42, [], []];
  for (const bad of badInputs) {
    const result = saveSupportSummary(bad, { summariesDir });
    assert.equal(result.ok, false);
    assert.equal(result.saved, false);
  }
});

test('a malformed-summary failure is still logged, with a failure outcome', () => {
  const summariesDir = tempSummariesDir();
  const result = saveSupportSummary(null, { summariesDir });
  assert.equal(result.logEntry.service, 'saveSupportSummary');
  assert.equal(result.logEntry.event, 'support_summary_save_failed');
  assert.equal(result.logEntry.outcome, 'failure');
  assert.equal(result.logEntry.level, 'warn');
  assert.equal(result.logEntry.error_class, 'ValidationError');
});

// --- Failure path: write failure (fails closed, alerted) ----------------------

test('a save blocked by a same-named file fails closed with an alert, never throws', () => {
  const blocker = join(TMP_DIR, `blocker-${randomUUID()}`);
  writeFileSync(blocker, 'i am a file, not a directory', 'utf8');

  const writes = captureStderr(() => {
    const result = saveSupportSummary(GENERATED_SUMMARY, { summariesDir: blocker });
    assert.equal(result.ok, false);
    assert.equal(result.saved, false);
    assert.match(result.message, /not saved/);
  });
  assert.ok(writes.some((line) => line.startsWith('ALERT: support summary save failed')));
});

test('a healthy save prints nothing to stderr', () => {
  const summariesDir = tempSummariesDir();
  const writes = captureStderr(() => {
    saveSupportSummary(GENERATED_SUMMARY, { summariesDir });
  });
  assert.equal(writes.length, 0);
});

// --- logEntry shape -------------------------------------------------------------

test('a successful save logs a success entry with the expected shape', () => {
  const summariesDir = tempSummariesDir();
  const result = saveSupportSummary(GENERATED_SUMMARY, { summariesDir });

  assert.equal(result.logEntry.service, 'saveSupportSummary');
  assert.equal(result.logEntry.event, 'support_summary_saved');
  assert.equal(result.logEntry.outcome, 'success');
  assert.equal(result.logEntry.level, 'info');
  assert.equal(result.logEntry.context.ticketId, 'TICKET-1001');
  assert.ok(!Number.isNaN(Date.parse(result.logEntry.timestamp)));
});

// --- Trust: the save action is persisted (STORY-007 acceptance) ---------------

test('saveSupportSummaryAndLog persists the save logEntry to the audit trail', () => {
  const summariesDir = tempSummariesDir();
  const logPath = tempPath('audit.log');
  const result = saveSupportSummaryAndLog(GENERATED_SUMMARY, { summariesDir, logPath });

  assert.equal(result.saved, true);
  assert.equal(result.auditResult.ok, true);
  const [record] = readLinesFrom(logPath);
  assert.equal(record.entry.event, 'support_summary_saved');
  assert.equal(record.entry.context.ticketId, 'TICKET-1001');
});

test('saveSupportSummaryAndLog still logs a failure entry when the summary is malformed', () => {
  const summariesDir = tempSummariesDir();
  const logPath = tempPath('audit.log');
  const result = saveSupportSummaryAndLog({ ...GENERATED_SUMMARY, generated: false }, { summariesDir, logPath });

  assert.equal(result.saved, false);
  assert.equal(result.auditResult.ok, true);
  const [record] = readLinesFrom(logPath);
  assert.equal(record.entry.outcome, 'failure');
  assert.equal(record.entry.error_class, 'ValidationError');
});
