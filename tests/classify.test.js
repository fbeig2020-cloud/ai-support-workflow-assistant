import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync, readFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { classifySupportRequest, CATEGORIES, PRIORITIES, applyApprovedClassificationRule, revokeApprovedRule } from '../src/classify.js';

// Own subdirectory per file, same reason as the other tests/*.test.js files:
// node --test runs files concurrently, so a shared literal tmp dir name races.
const TMP_DIR = join('tests/tmp', `classify-${randomUUID()}`);

function tempRulesPath(name) {
  return join(TMP_DIR, `${name}-${randomUUID()}.json`);
}

test.before(() => {
  mkdirSync(TMP_DIR, { recursive: true });
});

test.after(() => {
  rmSync(TMP_DIR, { recursive: true, force: true });
});

// --- Happy path: one representative request per category --------------------

const CATEGORY_SAMPLES = {
  login_problem: "I can't log in to my account, it says I'm locked out after too many attempts.",
  access_permission_issue: 'I need access granted to the finance folder, currently getting access denied.',
  power_bi_report_issue: 'My Power BI dashboard report is blank after the dataset refresh failed.',
  sql_database_issue: 'The SQL query is failing with a deadlock on the database connection.',
  data_issue: "The data is missing for last month and the numbers don't match the source system.",
  technical_question: 'How do I change my display language in the app?',
  general_support_request: 'Hi, just wanted to say thanks for the help last week.',
};

test('each predefined category is reachable from a representative request', () => {
  for (const category of CATEGORIES) {
    const result = classifySupportRequest(CATEGORY_SAMPLES[category]);
    assert.equal(result.category, category, `expected "${category}" sample to classify as "${category}"`);
  }
});

test('classification result always uses a predefined category and priority', () => {
  for (const text of Object.values(CATEGORY_SAMPLES)) {
    const result = classifySupportRequest(text);
    assert.ok(CATEGORIES.includes(result.category));
    assert.ok(PRIORITIES.includes(result.priority));
  }
});

// --- Priority tiers -----------------------------------------------------------

test('urgent signals are detected', () => {
  const result = classifySupportRequest(
    "This is urgent — production is down and it's blocking my work for the entire team."
  );
  assert.equal(result.priority, 'urgent');
});

test('high signals are detected', () => {
  const result = classifySupportRequest('My report is broken and not working, I get an error every time I open it.');
  assert.equal(result.priority, 'high');
});

test('low signals are detected', () => {
  const result = classifySupportRequest('No rush, whenever you get a chance — just curious about a setting.');
  assert.equal(result.priority, 'low');
});

test('no priority signal defaults to medium', () => {
  const result = classifySupportRequest('I need access granted to the shared drive.');
  assert.equal(result.priority, 'medium');
});

// --- Failure paths: missing category / missing priority ----------------------

test('a request with no recognizable category signal falls back to general_support_request, not a crash', () => {
  const result = classifySupportRequest('Just checking in, no real issue here.');
  assert.equal(result.category, 'general_support_request');
});

test('a request with no recognizable priority signal falls back to medium, not undefined', () => {
  const result = classifySupportRequest('My Power BI report looks a little off.');
  assert.equal(result.priority, 'medium');
});

// --- Malformed input (fail closed to safe defaults, never throw) -------------

test('empty or non-string input never throws and yields safe defaults', () => {
  for (const bad of ['', '   ', null, undefined, 42, [], {}]) {
    assert.doesNotThrow(() => classifySupportRequest(bad));
    const result = classifySupportRequest(bad);
    assert.equal(result.category, 'general_support_request');
    assert.equal(result.priority, 'medium');
    assert.equal(result.summary, '');
    assert.equal(result.logEntry.outcome, 'failure');
    assert.equal(result.logEntry.error_class, 'ValidationError');
  }
});

// --- Tie-breaking is deterministic --------------------------------------------

test('category match ties break toward the earlier entry in CATEGORIES', () => {
  // Matches 2 login_problem signals ("log in", "can't log") and 2
  // access_permission_issue signals ("access", "need access"). login_problem
  // is earlier in CATEGORIES, so it must win.
  const result = classifySupportRequest("I can't log in, and I also need access to the shared drive.");
  assert.equal(result.category, 'login_problem');
});

// --- Summary -------------------------------------------------------------------

test('short text is summarized verbatim (whitespace collapsed)', () => {
  const result = classifySupportRequest('  Report   is\n\nblank.  ');
  assert.equal(result.summary, 'Report is blank.');
});

test('long text is truncated to a bounded summary with an ellipsis', () => {
  const longText = 'word '.repeat(60).trim();
  const result = classifySupportRequest(longText);
  assert.ok(result.summary.length <= 141, 'summary must stay near the 140-char bound plus ellipsis');
  assert.ok(result.summary.endsWith('…'));
});

// --- Structured log entry -------------------------------------------------------

test('every successful classification carries a structured, stdout-log-shaped entry', () => {
  const result = classifySupportRequest(CATEGORY_SAMPLES.login_problem);
  assert.equal(result.logEntry.service, 'classify');
  assert.equal(result.logEntry.event, 'support_request_classified');
  assert.equal(result.logEntry.outcome, 'success');
  assert.equal(result.logEntry.level, 'info');
  assert.equal(result.logEntry.context.category, result.category);
  assert.equal(result.logEntry.context.priority, result.priority);
  assert.match(result.logEntry.timestamp, /^\d{4}-\d{2}-\d{2}T/);
});

// --- Idempotency / purity --------------------------------------------------------

test('classification is pure: same input twice yields the same category, priority, and summary', () => {
  const input = CATEGORY_SAMPLES.sql_database_issue;
  const first = classifySupportRequest(input);
  const second = classifySupportRequest(input);
  assert.equal(first.category, second.category);
  assert.equal(first.priority, second.priority);
  assert.equal(first.summary, second.summary);
  assert.deepEqual(first.matchedSignals, second.matchedSignals);
});

// --- STORY-008: approved classification overrides -----------------------------

test('with no approved-overrides file, classification is unaffected (default behavior preserved)', () => {
  const rulesPath = tempRulesPath('missing');
  const result = classifySupportRequest("There's a widget issue on the homepage.", { rulesPath });
  assert.equal(result.category, 'general_support_request');
  assert.equal(result.logEntry.context.overrideApplied, false);
});

test('an approved override keyword takes precedence over the static signal tables', () => {
  const rulesPath = tempRulesPath('override');
  writeFileSync(rulesPath, JSON.stringify({ rules: [{ keyword: 'widget', category: 'sql_database_issue' }] }));

  const result = classifySupportRequest("There's a widget issue on the homepage.", { rulesPath });
  assert.equal(result.category, 'sql_database_issue');
  assert.ok(result.matchedSignals.includes('widget'));
  assert.equal(result.logEntry.context.overrideApplied, true);
});

test('an unrelated request is unaffected by an approved override for a different keyword', () => {
  const rulesPath = tempRulesPath('override-unrelated');
  writeFileSync(rulesPath, JSON.stringify({ rules: [{ keyword: 'widget', category: 'sql_database_issue' }] }));

  const result = classifySupportRequest('How do I change my display language?', { rulesPath });
  assert.equal(result.category, 'technical_question');
});

test('a corrupt approved-overrides file fails closed to "no overrides" rather than crashing classification', () => {
  const rulesPath = tempRulesPath('corrupt');
  writeFileSync(rulesPath, '{ not valid json');

  assert.doesNotThrow(() => classifySupportRequest("There's a widget issue.", { rulesPath }));
  const result = classifySupportRequest("There's a widget issue.", { rulesPath });
  assert.equal(result.category, 'general_support_request');
});

test('an approved-overrides file with the wrong shape (no rules array) is ignored, not crashed on', () => {
  const rulesPath = tempRulesPath('wrong-shape');
  writeFileSync(rulesPath, JSON.stringify({ notRules: [] }));

  assert.doesNotThrow(() => classifySupportRequest("There's a widget issue.", { rulesPath }));
});

// --- STORY-008: applyApprovedClassificationRule -------------------------------

test('applyApprovedClassificationRule writes a rule that a later classification then honors', () => {
  const rulesPath = tempRulesPath('apply-happy');
  const applyResult = applyApprovedClassificationRule({ keyword: 'gizmo', category: 'data_issue' }, { rulesPath });

  assert.equal(applyResult.ok, true);
  assert.equal(applyResult.applied, true);
  assert.equal(applyResult.logEntry.event, 'approved_classification_rule_applied');
  assert.equal(applyResult.logEntry.outcome, 'success');

  const result = classifySupportRequest('The gizmo report is off.', { rulesPath });
  assert.equal(result.category, 'data_issue');
});

test('applying a rule for the same keyword twice upserts (overwrites), never duplicates', () => {
  const rulesPath = tempRulesPath('apply-upsert');
  applyApprovedClassificationRule({ keyword: 'gizmo', category: 'data_issue' }, { rulesPath });
  applyApprovedClassificationRule({ keyword: 'gizmo', category: 'sql_database_issue' }, { rulesPath });

  const result = classifySupportRequest('The gizmo report is off.', { rulesPath });
  assert.equal(result.category, 'sql_database_issue');
});

test('applyApprovedClassificationRule fails closed on malformed input, never throws', () => {
  const rulesPath = tempRulesPath('apply-malformed');
  for (const bad of [null, undefined, {}, { keyword: '' }, { keyword: 'x', category: 'not_a_real_category' }, { category: 'data_issue' }]) {
    assert.doesNotThrow(() => applyApprovedClassificationRule(bad, { rulesPath }));
    const result = applyApprovedClassificationRule(bad, { rulesPath });
    assert.equal(result.ok, false);
    assert.equal(result.applied, false);
    assert.equal(result.logEntry.outcome, 'failure');
    assert.equal(result.logEntry.error_class, 'ValidationError');
  }
});

// --- STORY-010: revokeApprovedRule ---------------------------------------------

test('revokeApprovedRule marks an existing approved rule as revoked, without deleting it', () => {
  const rulesPath = tempRulesPath('revoke-happy');
  applyApprovedClassificationRule({ keyword: 'widget', category: 'sql_database_issue' }, { rulesPath });

  const result = revokeApprovedRule(
    { keyword: 'widget', reason: 'Too broad, causing misclassifications.', reviewer: 'agent.jane' },
    { rulesPath },
  );

  assert.equal(result.ok, true);
  assert.equal(result.revoked, true);
  assert.equal(result.rule.keyword, 'widget');
  assert.equal(result.rule.revoked, true);
  assert.equal(result.rule.revokedBy, 'agent.jane');
  assert.equal(result.rule.revokedReason, 'Too broad, causing misclassifications.');
  assert.ok(!Number.isNaN(Date.parse(result.rule.revokedAt)));
  assert.equal(result.logEntry.service, 'classify');
  assert.equal(result.logEntry.event, 'approved_classification_rule_revoked');
  assert.equal(result.logEntry.outcome, 'success');
  assert.equal(result.logEntry.context.keyword, 'widget');
  assert.equal(result.logEntry.context.reviewer, 'agent.jane');

  // Marked, not deleted: the original keyword/category/approvedAt survive alongside the new fields.
  const onDisk = JSON.parse(readFileSync(rulesPath, 'utf8')).rules;
  assert.equal(onDisk.length, 1);
  assert.equal(onDisk[0].keyword, 'widget');
  assert.equal(onDisk[0].category, 'sql_database_issue');
  assert.equal(onDisk[0].revoked, true);
});

test('revokeApprovedRule fails closed on missing keyword, reason, or reviewer, never throws', () => {
  const rulesPath = tempRulesPath('revoke-malformed');
  applyApprovedClassificationRule({ keyword: 'widget', category: 'sql_database_issue' }, { rulesPath });

  const badInputs = [
    null,
    undefined,
    42,
    [],
    {},
    { reason: 'no longer valid', reviewer: 'agent.jane' }, // missing keyword
    { keyword: '', reason: 'no longer valid', reviewer: 'agent.jane' }, // blank keyword
    { keyword: 'widget', reviewer: 'agent.jane' }, // missing reason
    { keyword: 'widget', reason: '', reviewer: 'agent.jane' }, // blank reason
    { keyword: 'widget', reason: 'no longer valid' }, // missing reviewer
    { keyword: 'widget', reason: 'no longer valid', reviewer: '' }, // blank reviewer
  ];

  for (const bad of badInputs) {
    assert.doesNotThrow(() => revokeApprovedRule(bad, { rulesPath }));
    const result = revokeApprovedRule(bad, { rulesPath });
    assert.equal(result.ok, false);
    assert.equal(result.revoked, false);
    assert.equal(result.logEntry.outcome, 'failure');
    assert.equal(result.logEntry.event, 'approved_classification_rule_revoke_rejected');
    assert.equal(result.logEntry.error_class, 'ValidationError');
  }

  // None of the rejected attempts touched the rule on disk.
  const onDisk = JSON.parse(readFileSync(rulesPath, 'utf8')).rules;
  assert.equal(onDisk[0].revoked, undefined);
});

test('revokeApprovedRule fails closed when no approved rule matches the keyword', () => {
  const rulesPath = tempRulesPath('revoke-not-found');
  applyApprovedClassificationRule({ keyword: 'widget', category: 'sql_database_issue' }, { rulesPath });

  const result = revokeApprovedRule({ keyword: 'nonexistent', reason: 'irrelevant', reviewer: 'agent.jane' }, { rulesPath });

  assert.equal(result.ok, false);
  assert.equal(result.revoked, false);
  assert.equal(result.notFound, true);
  assert.equal(result.logEntry.event, 'approved_classification_rule_revoke_failed');
  assert.equal(result.logEntry.error_class, 'RuleNotFoundError');
});

test('revokeApprovedRule fails closed with not-found when the rules file does not exist yet', () => {
  const rulesPath = tempRulesPath('revoke-no-file');

  assert.doesNotThrow(() => revokeApprovedRule({ keyword: 'widget', reason: 'irrelevant', reviewer: 'agent.jane' }, { rulesPath }));
  const result = revokeApprovedRule({ keyword: 'widget', reason: 'irrelevant', reviewer: 'agent.jane' }, { rulesPath });
  assert.equal(result.ok, false);
  assert.equal(result.notFound, true);
});

test('revoking an already-revoked rule is an idempotent no-op, not an error', () => {
  const rulesPath = tempRulesPath('revoke-duplicate');
  applyApprovedClassificationRule({ keyword: 'widget', category: 'sql_database_issue' }, { rulesPath });

  const first = revokeApprovedRule({ keyword: 'widget', reason: 'first reason', reviewer: 'agent.jane' }, { rulesPath });
  const second = revokeApprovedRule({ keyword: 'widget', reason: 'second reason', reviewer: 'agent.bob' }, { rulesPath });

  assert.equal(first.ok, true);
  assert.equal(first.revoked, true);

  assert.equal(second.ok, true);
  assert.equal(second.revoked, false);
  assert.equal(second.alreadyRevoked, true);
  assert.equal(second.logEntry.event, 'approved_classification_rule_revoke_duplicate');
  assert.equal(second.logEntry.outcome, 'success');

  // The second, no-op call must not overwrite the first revocation's details.
  const onDisk = JSON.parse(readFileSync(rulesPath, 'utf8')).rules[0];
  assert.equal(onDisk.revokedReason, 'first reason');
  assert.equal(onDisk.revokedBy, 'agent.jane');
});

test('a corrupt approved-overrides file fails closed rather than crashing revocation', () => {
  const rulesPath = tempRulesPath('revoke-corrupt');
  writeFileSync(rulesPath, '{ not valid json');

  assert.doesNotThrow(() => revokeApprovedRule({ keyword: 'widget', reason: 'irrelevant', reviewer: 'agent.jane' }, { rulesPath }));
  const result = revokeApprovedRule({ keyword: 'widget', reason: 'irrelevant', reviewer: 'agent.jane' }, { rulesPath });
  assert.equal(result.ok, false);
  assert.equal(result.revoked, false);
  assert.equal(result.logEntry.event, 'approved_classification_rule_revoke_failed');
  assert.equal(result.logEntry.error_class, 'RulesFileCorruptError');
  // the corrupt file must still be exactly as it was — never blindly overwritten.
  assert.equal(readFileSync(rulesPath, 'utf8'), '{ not valid json');
});

test('a write failure fails closed with an alert, mirroring applyApprovedClassificationRule\'s own write-failure handling', () => {
  const rulesPath = tempRulesPath('revoke-write-failure');
  applyApprovedClassificationRule({ keyword: 'widget', category: 'sql_database_issue' }, { rulesPath });
  chmodSync(rulesPath, 0o444); // read-only: the read that finds the rule still succeeds, only the write fails.

  const writes = [];
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...args) => {
    writes.push(String(chunk));
    return originalStderrWrite(chunk, ...args);
  };

  let result;
  try {
    result = revokeApprovedRule({ keyword: 'widget', reason: 'irrelevant', reviewer: 'agent.jane' }, { rulesPath });
  } finally {
    process.stderr.write = originalStderrWrite;
    chmodSync(rulesPath, 0o666); // restore so cleanup can remove it
  }

  assert.equal(result.ok, false);
  assert.equal(result.revoked, false);
  assert.equal(result.logEntry.event, 'approved_classification_rule_revoke_failed');
  assert.ok(['RulesAccessDeniedError', 'RulesWriteFailedError'].includes(result.logEntry.error_class));
  assert.ok(writes.some((line) => line.startsWith('ALERT: approved classification rule revoke write failed')));
});

// --- STORY-010: revokeApprovedRule x classify.js integration -------------------

test('revoking an approved rule stops it from matching new requests, without altering a classification already produced under it', () => {
  const rulesPath = tempRulesPath('revoke-integration');
  applyApprovedClassificationRule({ keyword: 'widget', category: 'sql_database_issue' }, { rulesPath });

  // A ticket classified while the rule was still active.
  const classifiedBeforeRevocation = classifySupportRequest("There's a widget issue on the homepage.", { rulesPath });
  assert.equal(classifiedBeforeRevocation.category, 'sql_database_issue');
  assert.equal(classifiedBeforeRevocation.logEntry.context.overrideApplied, true);

  const revokeResult = revokeApprovedRule(
    { keyword: 'widget', reason: 'Too broad, causing misclassifications.', reviewer: 'agent.jane' },
    { rulesPath },
  );
  assert.equal(revokeResult.ok, true);
  assert.equal(revokeResult.revoked, true);

  // The already-produced result is an ordinary object — revocation never reaches back
  // to rewrite it; nothing re-runs or re-classifies past tickets.
  assert.equal(classifiedBeforeRevocation.category, 'sql_database_issue');
  assert.equal(classifiedBeforeRevocation.logEntry.context.overrideApplied, true);

  // A new ticket with identical wording now falls through to the static signal tables.
  const classifiedAfterRevocation = classifySupportRequest("There's a widget issue on the homepage.", { rulesPath });
  assert.equal(classifiedAfterRevocation.category, 'general_support_request');
  assert.equal(classifiedAfterRevocation.logEntry.context.overrideApplied, false);
});
