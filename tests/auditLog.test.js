import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { appendAuditEntry, GENESIS_HASH } from '../src/auditLog.js';

// Each test file gets its own unique subdirectory (not the shared 'tests/tmp'
// root) because node --test runs files concurrently in separate processes;
// a shared literal directory name means one file's cleanup can delete the
// directory out from under another file's still-running test.
const TMP_DIR = join('tests/tmp', `auditLog-${randomUUID()}`);

function tempLogPath() {
  return join(TMP_DIR, `audit-${randomUUID()}.log`);
}

function readLines(logPath) {
  return readFileSync(logPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
}

function recomputeHash(prevHash, entry, seq) {
  return createHash('sha256').update(prevHash + JSON.stringify(entry) + seq, 'utf8').digest('hex');
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

const SAMPLE_ENTRY = {
  timestamp: '2026-08-20T00:00:00.000Z',
  level: 'info',
  service: 'classify',
  event: 'support_request_classified',
  outcome: 'success',
  context: { category: 'login_problem', priority: 'high' },
};

test.before(() => {
  mkdirSync(TMP_DIR, { recursive: true });
});

test.after(() => {
  rmSync(TMP_DIR, { recursive: true, force: true });
});

// --- Happy path: an action is logged -------------------------------------

test('appending the first entry to a fresh log chains from the genesis hash', () => {
  const logPath = tempLogPath();
  const result = appendAuditEntry(SAMPLE_ENTRY, { logPath });

  assert.equal(result.ok, true);
  assert.equal(result.record.seq, 1);
  assert.equal(result.record.prevHash, GENESIS_HASH);
  assert.match(result.record.hash, /^[0-9a-f]{64}$/);
  assert.deepEqual(result.record.entry, SAMPLE_ENTRY);
});

test('the appended entry is actually persisted to disk as one JSON line', () => {
  const logPath = tempLogPath();
  appendAuditEntry(SAMPLE_ENTRY, { logPath });

  const lines = readLines(logPath);
  assert.equal(lines.length, 1);
  assert.deepEqual(lines[0].entry, SAMPLE_ENTRY);
});

test('a second entry chains its prevHash to the first entry\'s hash', () => {
  const logPath = tempLogPath();
  const first = appendAuditEntry(SAMPLE_ENTRY, { logPath });
  const second = appendAuditEntry({ ...SAMPLE_ENTRY, event: 'classification_approved' }, { logPath });

  assert.equal(second.record.seq, 2);
  assert.equal(second.record.prevHash, first.record.hash);
  assert.notEqual(second.record.hash, first.record.hash);
});

test('appending creates the parent directory when it does not exist yet', () => {
  const logPath = join(TMP_DIR, `nested-${randomUUID()}`, 'audit-trail.log');
  const result = appendAuditEntry(SAMPLE_ENTRY, { logPath });

  assert.equal(result.ok, true);
  assert.equal(existsSync(logPath), true);
});

test('repeated identical entries are never deduped — each is its own chained record', () => {
  const logPath = tempLogPath();
  appendAuditEntry(SAMPLE_ENTRY, { logPath });
  appendAuditEntry(SAMPLE_ENTRY, { logPath });

  const lines = readLines(logPath);
  assert.equal(lines.length, 2);
  assert.notEqual(lines[0].hash, lines[1].hash);
});

// --- Trust: hashes are verifiable and tampering is detectable -------------

test('every stored hash matches recomputing sha256(prevHash + entry + seq)', () => {
  const logPath = tempLogPath();
  appendAuditEntry(SAMPLE_ENTRY, { logPath });
  appendAuditEntry({ ...SAMPLE_ENTRY, event: 'classification_approved' }, { logPath });

  for (const record of readLines(logPath)) {
    assert.equal(record.hash, recomputeHash(record.prevHash, record.entry, record.seq));
  }
});

test('editing a past entry breaks its recomputed hash (tampering is detectable)', () => {
  const logPath = tempLogPath();
  appendAuditEntry(SAMPLE_ENTRY, { logPath });

  const [record] = readLines(logPath);
  const tampered = { ...record, entry: { ...record.entry, context: { category: 'data_issue' } } };
  writeFileSync(logPath, `${JSON.stringify(tampered)}\n`, 'utf8');

  const [reread] = readLines(logPath);
  const expected = recomputeHash(reread.prevHash, reread.entry, reread.seq);
  assert.notEqual(reread.hash, expected);
});

// --- Failure path: logging failure raises an alert and fails closed -------

test('a malformed logEntry (null) fails closed and never throws', () => {
  const logPath = tempLogPath();
  assert.doesNotThrow(() => {
    const result = appendAuditEntry(null, { logPath });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'audit_log_write_failed');
  });
});

test('malformed logEntry shapes (array, string, number, undefined) all fail closed', () => {
  const logPath = tempLogPath();
  for (const bad of [[], 'not an object', 42, undefined]) {
    const result = appendAuditEntry(bad, { logPath });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'audit_log_write_failed');
  }
});

test('a failed write prints an ALERT line to stderr', () => {
  const logPath = tempLogPath();
  const writes = captureStderr(() => {
    appendAuditEntry(null, { logPath });
  });
  assert.ok(writes.some((line) => line.startsWith('ALERT: audit log write failed')));
});

test('a healthy append prints nothing to stderr', () => {
  const logPath = tempLogPath();
  const writes = captureStderr(() => {
    appendAuditEntry(SAMPLE_ENTRY, { logPath });
  });
  assert.equal(writes.length, 0);
});

test('a corrupted chain tail is treated as a logging failure, not silently overwritten', () => {
  const logPath = tempLogPath();
  mkdirSync(TMP_DIR, { recursive: true });
  writeFileSync(logPath, 'this is not valid json\n', 'utf8');

  const writes = captureStderr(() => {
    const result = appendAuditEntry(SAMPLE_ENTRY, { logPath });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'audit_log_write_failed');
  });
  assert.ok(writes.some((line) => line.startsWith('ALERT:')));

  // The corrupt line itself was never touched — append-only holds even on failure.
  const raw = readFileSync(logPath, 'utf8');
  assert.equal(raw, 'this is not valid json\n');
});

test('writing to a path blocked by a same-named file fails closed with an alert', () => {
  const blocker = join(TMP_DIR, `blocker-${randomUUID()}`);
  writeFileSync(blocker, 'i am a file, not a directory', 'utf8');
  const logPath = join(blocker, 'audit-trail.log');

  const writes = captureStderr(() => {
    const result = appendAuditEntry(SAMPLE_ENTRY, { logPath });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'audit_log_write_failed');
  });
  assert.ok(writes.some((line) => line.startsWith('ALERT:')));
});
