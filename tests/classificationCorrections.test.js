import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  recordClassificationCorrection,
  checkForSuggestedRule,
  SUGGESTION_THRESHOLD,
  FAST_REPEAT_THRESHOLD,
  FAST_REPEAT_WINDOW_DAYS,
} from '../src/classificationCorrections.js';
import { listQueuedTickets } from '../src/ticketQueue.js';

// Own subdirectory per file, same reason as the other tests/*.test.js files:
// node --test runs files concurrently, so a shared literal tmp dir name races.
const TMP_DIR = join('tests/tmp', `classificationCorrections-${randomUUID()}`);

function tempCorrectionsPath(name) {
  return join(TMP_DIR, `${name}-${randomUUID()}.json`);
}

function tempQueueDir(name) {
  return join(TMP_DIR, `${name}-queue-${randomUUID()}`);
}

function daysAgo(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

// Patches a stored correction's recordedAt directly on disk (or removes it
// entirely), the same way the "corrupt file" tests write raw JSON — there is
// no way to control recordedAt through recordClassificationCorrection() itself,
// since it always stamps "now".
function setRecordedAt(correctionsPath, requestId, recordedAt) {
  const data = JSON.parse(readFileSync(correctionsPath, 'utf8'));
  const entry = data.corrections.find((c) => c.requestId === requestId);
  if (recordedAt === undefined) {
    delete entry.recordedAt;
  } else {
    entry.recordedAt = recordedAt;
  }
  writeFileSync(correctionsPath, JSON.stringify(data, null, 2));
}

test.before(() => {
  mkdirSync(TMP_DIR, { recursive: true });
});

test.after(() => {
  rmSync(TMP_DIR, { recursive: true, force: true });
});

const VALID_CORRECTION = {
  requestId: 'REQ-1',
  keyword: 'widget',
  wrongCategory: 'sql_database_issue',
  correctCategory: 'general_support_request',
  reviewer: 'agent.jane',
};

// --- recordClassificationCorrection: happy path -------------------------------

test('records a valid correction and returns the saved entry', () => {
  const correctionsPath = tempCorrectionsPath('happy');
  const result = recordClassificationCorrection(VALID_CORRECTION, { correctionsPath });

  assert.equal(result.ok, true);
  assert.equal(result.recorded, true);
  assert.equal(result.correction.requestId, 'REQ-1');
  assert.equal(result.correction.keyword, 'widget');
  assert.ok(!Number.isNaN(Date.parse(result.correction.recordedAt)));

  const onDisk = JSON.parse(readFileSync(correctionsPath, 'utf8'));
  assert.equal(onDisk.corrections.length, 1);
});

test('a successful record carries a structured, stdout-log-shaped entry', () => {
  const correctionsPath = tempCorrectionsPath('log-shape');
  const result = recordClassificationCorrection(VALID_CORRECTION, { correctionsPath });

  assert.equal(result.logEntry.service, 'classificationCorrections');
  assert.equal(result.logEntry.event, 'classification_correction_recorded');
  assert.equal(result.logEntry.outcome, 'success');
  assert.equal(result.logEntry.level, 'info');
  assert.equal(result.logEntry.context.keyword, 'widget');
  assert.ok(!Number.isNaN(Date.parse(result.logEntry.timestamp)));
});

test('auto-creates the corrections file and its directory when neither exists yet', () => {
  const correctionsPath = tempCorrectionsPath('auto-create');
  assert.doesNotThrow(() => recordClassificationCorrection(VALID_CORRECTION, { correctionsPath }));
  assert.doesNotThrow(() => readFileSync(correctionsPath, 'utf8'));
});

// --- recordClassificationCorrection: malformed input --------------------------

test('malformed correction input fails closed, never throws', () => {
  const correctionsPath = tempCorrectionsPath('malformed');
  const badInputs = [
    null,
    undefined,
    42,
    [],
    {},
    { ...VALID_CORRECTION, requestId: '' },
    { ...VALID_CORRECTION, keyword: '' },
    { ...VALID_CORRECTION, wrongCategory: 'not_a_real_category' },
    { ...VALID_CORRECTION, correctCategory: 'not_a_real_category' },
    { ...VALID_CORRECTION, reviewer: '' },
  ];

  for (const bad of badInputs) {
    assert.doesNotThrow(() => recordClassificationCorrection(bad, { correctionsPath }));
    const result = recordClassificationCorrection(bad, { correctionsPath });
    assert.equal(result.ok, false);
    assert.equal(result.recorded, false);
    assert.equal(result.logEntry.outcome, 'failure');
    assert.equal(result.logEntry.error_class, 'ValidationError');
  }
});

test('a corrupt corrections file fails closed rather than silently overwriting history', () => {
  const correctionsPath = tempCorrectionsPath('corrupt');
  writeFileSync(correctionsPath, '{ not valid json');

  const result = recordClassificationCorrection(VALID_CORRECTION, { correctionsPath });
  assert.equal(result.ok, false);
  assert.equal(result.recorded, false);
  assert.equal(result.logEntry.error_class, 'CorrectionsFileCorruptError');
  // the corrupt file must still be exactly as it was — never blindly overwritten.
  assert.equal(readFileSync(correctionsPath, 'utf8'), '{ not valid json');
});

// --- recordClassificationCorrection: duplicate handling ------------------------

test('recording the same requestId twice does not create a second entry', () => {
  const correctionsPath = tempCorrectionsPath('duplicate');
  const first = recordClassificationCorrection(VALID_CORRECTION, { correctionsPath });
  const second = recordClassificationCorrection(VALID_CORRECTION, { correctionsPath });

  assert.equal(first.recorded, true);
  assert.equal(second.ok, true);
  assert.equal(second.recorded, false);
  assert.equal(second.duplicate, true);
  assert.equal(second.logEntry.event, 'classification_correction_duplicate');
  assert.equal(second.logEntry.outcome, 'success');

  const onDisk = JSON.parse(readFileSync(correctionsPath, 'utf8'));
  assert.equal(onDisk.corrections.length, 1);
});

test('a duplicate requestId with different correction details is still treated as a duplicate (requestId is the key)', () => {
  const correctionsPath = tempCorrectionsPath('duplicate-different-details');
  recordClassificationCorrection(VALID_CORRECTION, { correctionsPath });
  const second = recordClassificationCorrection({ ...VALID_CORRECTION, keyword: 'gadget' }, { correctionsPath });

  assert.equal(second.duplicate, true);
  const onDisk = JSON.parse(readFileSync(correctionsPath, 'utf8'));
  assert.equal(onDisk.corrections.length, 1);
  assert.equal(onDisk.corrections[0].keyword, 'widget');
});

// --- checkForSuggestedRule: threshold boundary ----------------------------------

test('SUGGESTION_THRESHOLD is 3', () => {
  assert.equal(SUGGESTION_THRESHOLD, 3);
});

test('2 occurrences of the same pattern, spaced more than 15 days apart, do NOT trigger a suggestion', () => {
  const correctionsPath = tempCorrectionsPath('boundary-2-spaced-far');
  const queueDir = tempQueueDir('boundary-2-spaced-far');
  recordClassificationCorrection({ ...VALID_CORRECTION, requestId: 'REQ-1' }, { correctionsPath });
  recordClassificationCorrection({ ...VALID_CORRECTION, requestId: 'REQ-2' }, { correctionsPath });
  setRecordedAt(correctionsPath, 'REQ-1', daysAgo(FAST_REPEAT_WINDOW_DAYS + 5));
  setRecordedAt(correctionsPath, 'REQ-2', daysAgo(0));

  const result = checkForSuggestedRule({ correctionsPath, queueDir });
  assert.equal(result.ok, true);
  assert.equal(result.suggested, false);
  assert.deepEqual(result.suggestions, []);
  assert.equal(listQueuedTickets({ queueDir }).length, 0);
});

// --- checkForSuggestedRule: fast-repeat trigger ---------------------------------

test("2 occurrences of the same pattern within FAST_REPEAT_WINDOW_DAYS DO trigger a suggestion, with triggeredBy: 'fast_repeat'", () => {
  const correctionsPath = tempCorrectionsPath('fast-repeat-within-window');
  const queueDir = tempQueueDir('fast-repeat-within-window');
  recordClassificationCorrection({ ...VALID_CORRECTION, requestId: 'REQ-1' }, { correctionsPath });
  recordClassificationCorrection({ ...VALID_CORRECTION, requestId: 'REQ-2' }, { correctionsPath });
  setRecordedAt(correctionsPath, 'REQ-1', daysAgo(FAST_REPEAT_WINDOW_DAYS - 1));
  setRecordedAt(correctionsPath, 'REQ-2', daysAgo(0));

  const result = checkForSuggestedRule({ correctionsPath, queueDir });
  assert.equal(result.ok, true);
  assert.equal(result.suggested, true);
  assert.equal(result.suggestions.length, 1);
  assert.equal(result.suggestions[0].timesSeen, FAST_REPEAT_THRESHOLD);
  assert.equal(result.suggestions[0].triggeredBy, 'fast_repeat');
  assert.equal(result.suggestions[0].queued, true);
});

test("3 occurrences spread far apart in time still trigger via the original threshold, with triggeredBy: 'threshold'", () => {
  const correctionsPath = tempCorrectionsPath('threshold-spread-far');
  const queueDir = tempQueueDir('threshold-spread-far');
  recordClassificationCorrection({ ...VALID_CORRECTION, requestId: 'REQ-1' }, { correctionsPath });
  recordClassificationCorrection({ ...VALID_CORRECTION, requestId: 'REQ-2' }, { correctionsPath });
  recordClassificationCorrection({ ...VALID_CORRECTION, requestId: 'REQ-3' }, { correctionsPath });
  setRecordedAt(correctionsPath, 'REQ-1', daysAgo(200));
  setRecordedAt(correctionsPath, 'REQ-2', daysAgo(100));
  setRecordedAt(correctionsPath, 'REQ-3', daysAgo(0));

  const result = checkForSuggestedRule({ correctionsPath, queueDir });
  assert.equal(result.ok, true);
  assert.equal(result.suggested, true);
  assert.equal(result.suggestions.length, 1);
  assert.equal(result.suggestions[0].timesSeen, 3);
  assert.equal(result.suggestions[0].triggeredBy, 'threshold');
});

test('a correction with a missing/invalid recordedAt still counts toward the 3x-ever threshold, but is excluded from the fast-repeat window check', () => {
  const correctionsPath = tempCorrectionsPath('invalid-recordedat');
  const queueDir = tempQueueDir('invalid-recordedat');
  recordClassificationCorrection({ ...VALID_CORRECTION, requestId: 'REQ-1' }, { correctionsPath });
  recordClassificationCorrection({ ...VALID_CORRECTION, requestId: 'REQ-2' }, { correctionsPath });
  setRecordedAt(correctionsPath, 'REQ-1', 'not-a-valid-date');
  setRecordedAt(correctionsPath, 'REQ-2', daysAgo(0));

  // Only one usable timestamp so far (REQ-1's is unparsable) — below both
  // SUGGESTION_THRESHOLD (2 total) and FAST_REPEAT_THRESHOLD (1 valid timestamp).
  const afterTwo = checkForSuggestedRule({ correctionsPath, queueDir });
  assert.equal(afterTwo.suggested, false);

  recordClassificationCorrection({ ...VALID_CORRECTION, requestId: 'REQ-3' }, { correctionsPath });
  setRecordedAt(correctionsPath, 'REQ-3', undefined);

  // Now 3 total (REQ-1 invalid, REQ-2 valid, REQ-3 missing) — the invalid and
  // missing entries still count toward the 3x-ever total, reaching SUGGESTION_THRESHOLD,
  // even though only one of the three ever contributed a usable timestamp.
  const afterThree = checkForSuggestedRule({ correctionsPath, queueDir });
  assert.equal(afterThree.suggested, true);
  assert.equal(afterThree.suggestions[0].timesSeen, 3);
  assert.equal(afterThree.suggestions[0].triggeredBy, 'threshold');
});

test("a pattern satisfying both triggers at once reports triggeredBy: 'threshold'", () => {
  const correctionsPath = tempCorrectionsPath('both-triggers-overlap');
  const queueDir = tempQueueDir('both-triggers-overlap');
  // Recorded back-to-back with no recordedAt patching, so all three timestamps
  // land within milliseconds of each other — both SUGGESTION_THRESHOLD (3x-ever)
  // and FAST_REPEAT_THRESHOLD (2 within FAST_REPEAT_WINDOW_DAYS) are satisfied at once.
  recordClassificationCorrection({ ...VALID_CORRECTION, requestId: 'REQ-1' }, { correctionsPath });
  recordClassificationCorrection({ ...VALID_CORRECTION, requestId: 'REQ-2' }, { correctionsPath });
  recordClassificationCorrection({ ...VALID_CORRECTION, requestId: 'REQ-3' }, { correctionsPath });

  const result = checkForSuggestedRule({ correctionsPath, queueDir });
  assert.equal(result.suggested, true);
  assert.equal(result.suggestions.length, 1);
  assert.equal(result.suggestions[0].triggeredBy, 'threshold');
});

test('3 occurrences of the same pattern DO trigger a suggestion', () => {
  const correctionsPath = tempCorrectionsPath('boundary-3');
  const queueDir = tempQueueDir('boundary-3');
  recordClassificationCorrection({ ...VALID_CORRECTION, requestId: 'REQ-1' }, { correctionsPath });
  recordClassificationCorrection({ ...VALID_CORRECTION, requestId: 'REQ-2' }, { correctionsPath });
  recordClassificationCorrection({ ...VALID_CORRECTION, requestId: 'REQ-3' }, { correctionsPath });

  const result = checkForSuggestedRule({ correctionsPath, queueDir });
  assert.equal(result.ok, true);
  assert.equal(result.suggested, true);
  assert.equal(result.suggestions.length, 1);

  const suggestion = result.suggestions[0];
  assert.equal(suggestion.type, 'suggested_rule_change');
  assert.equal(suggestion.keyword, 'widget');
  assert.equal(suggestion.wrongCategory, 'sql_database_issue');
  assert.equal(suggestion.correctCategory, 'general_support_request');
  assert.equal(suggestion.timesSeen, 3);
  assert.equal(suggestion.queued, true);
});

// --- checkForSuggestedRule: reaches the human review queue ---------------------

test('a suggestion is added to the existing ticket queue, tagged so it is unmistakably not a student ticket', () => {
  const correctionsPath = tempCorrectionsPath('queue-shape');
  const queueDir = tempQueueDir('queue-shape');
  for (let i = 0; i < SUGGESTION_THRESHOLD; i++) {
    recordClassificationCorrection({ ...VALID_CORRECTION, requestId: `REQ-${i}` }, { correctionsPath });
  }

  checkForSuggestedRule({ correctionsPath, queueDir });

  const queued = listQueuedTickets({ queueDir });
  assert.equal(queued.length, 1);
  assert.equal(queued[0].type, 'suggested_rule_change');
  assert.notEqual(queued[0].type, undefined);
  assert.ok(readdirSync(queueDir)[0].endsWith('.json'));
});

test('rechecking an already-suggested pattern upserts the same queue entry rather than duplicating', () => {
  const correctionsPath = tempCorrectionsPath('queue-upsert');
  const queueDir = tempQueueDir('queue-upsert');
  for (let i = 0; i < SUGGESTION_THRESHOLD; i++) {
    recordClassificationCorrection({ ...VALID_CORRECTION, requestId: `REQ-${i}` }, { correctionsPath });
  }
  checkForSuggestedRule({ correctionsPath, queueDir });

  recordClassificationCorrection({ ...VALID_CORRECTION, requestId: 'REQ-extra' }, { correctionsPath });
  const second = checkForSuggestedRule({ correctionsPath, queueDir });

  assert.equal(second.suggestions[0].timesSeen, 4);
  assert.equal(listQueuedTickets({ queueDir }).length, 1);
});

// --- checkForSuggestedRule: no corrections yet / corrupt file -------------------

test('no corrections file yet means no suggestion, not a failure', () => {
  const correctionsPath = tempCorrectionsPath('missing');
  const queueDir = tempQueueDir('missing');
  const result = checkForSuggestedRule({ correctionsPath, queueDir });
  assert.equal(result.ok, true);
  assert.equal(result.suggested, false);
});

test('a corrupt corrections file fails closed rather than analyzing as if there were zero corrections', () => {
  const correctionsPath = tempCorrectionsPath('check-corrupt');
  const queueDir = tempQueueDir('check-corrupt');
  writeFileSync(correctionsPath, '{ not valid json');

  const result = checkForSuggestedRule({ correctionsPath, queueDir });
  assert.equal(result.ok, false);
  assert.equal(result.suggested, false);
  assert.equal(result.logEntry.outcome, 'failure');
  assert.equal(result.logEntry.error_class, 'CorrectionsFileCorruptError');
});

// --- Different wrongCategory for the same keyword/correctCategory counts separately --

test('grouping is by the exact (keyword, wrongCategory, correctCategory) triple', () => {
  const correctionsPath = tempCorrectionsPath('triple-grouping');
  const queueDir = tempQueueDir('triple-grouping');
  // Same keyword/correctCategory, but a different wrongCategory each time — should not combine into one group of 3.
  recordClassificationCorrection({ requestId: 'A', keyword: 'widget', wrongCategory: 'sql_database_issue', correctCategory: 'general_support_request', reviewer: 'jane' }, { correctionsPath });
  recordClassificationCorrection({ requestId: 'B', keyword: 'widget', wrongCategory: 'data_issue', correctCategory: 'general_support_request', reviewer: 'jane' }, { correctionsPath });
  recordClassificationCorrection({ requestId: 'C', keyword: 'widget', wrongCategory: 'login_problem', correctCategory: 'general_support_request', reviewer: 'jane' }, { correctionsPath });

  const result = checkForSuggestedRule({ correctionsPath, queueDir });
  assert.equal(result.suggested, false);
});
