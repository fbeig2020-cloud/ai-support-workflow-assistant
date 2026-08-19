import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifySupportRequest, CATEGORIES, PRIORITIES } from '../src/classify.js';

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
