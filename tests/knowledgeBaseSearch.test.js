import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { searchKnowledgeBase } from '../src/knowledgeBaseSearch.js';
import { searchKnowledgeBaseAndLog } from '../src/auditedActions.js';
import { classifySupportRequest } from '../src/classify.js';

// Own subdirectory per file, same reason as auditedActions.test.js/auditLog.test.js:
// node --test runs files concurrently, so a shared literal tmp dir name races.
const TMP_DIR = join('tests/tmp', `knowledgeBaseSearch-${randomUUID()}`);

function tempPath(name) {
  return join(TMP_DIR, `${name}-${randomUUID()}`);
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

// --- Happy path -------------------------------------------------------------

test('returns relevant troubleshooting steps for a classified login problem', async () => {
  const classification = classifySupportRequest("I can't log in, I'm locked out of my account.");
  const result = await searchKnowledgeBase(classification);

  assert.equal(result.found, true);
  assert.equal(result.confidence, 'high');
  assert.ok(result.results.length > 0);
  assert.equal(result.results[0].category, 'login_problem');
  assert.ok(result.results[0].steps.length > 0);
});

test('a bare category with no matched signals still returns a category-based (medium) match', async () => {
  const result = await searchKnowledgeBase({ category: 'sql_database_issue', matchedSignals: [] });

  assert.equal(result.found, true);
  assert.equal(result.confidence, 'medium');
  assert.ok(result.results.every((r) => r.category === 'sql_database_issue'));
});

// --- No results found / uncertainty -----------------------------------------

test('indicates uncertainty when no article is relevant to the category', async () => {
  const result = await searchKnowledgeBase({ category: 'general_support_request', matchedSignals: [] });

  assert.equal(result.found, false);
  assert.equal(result.confidence, 'none');
  assert.deepEqual(result.results, []);
  assert.match(result.message, /no relevant troubleshooting steps/i);
});

test('a weak, category-mismatched signal overlap is flagged low-confidence, not presented as certain', async () => {
  // general_support_request has no matching article, so no article gets the
  // category-match bonus; 'report' only overlaps one tag on the Power BI
  // article, giving a weak score that should be flagged, not trusted outright.
  const result = await searchKnowledgeBase({
    category: 'general_support_request',
    matchedSignals: ['report'],
  });

  assert.equal(result.found, true);
  assert.equal(result.confidence, 'low');
  assert.match(result.message, /low-confidence/i);
});

// --- Malformed / incorrect input fails closed --------------------------------

test('fails closed on a missing category', async () => {
  const result = await searchKnowledgeBase({ matchedSignals: [] });
  assert.equal(result.found, false);
  assert.equal(result.logEntry.error_class, 'ValidationError');
});

test('fails closed on an unrecognized category', async () => {
  const result = await searchKnowledgeBase({ category: 'not_a_real_category' });
  assert.equal(result.found, false);
  assert.equal(result.logEntry.error_class, 'ValidationError');
});

test('fails closed on non-object input without throwing', async () => {
  for (const bad of [null, undefined, 'login_problem', 42, ['login_problem']]) {
    const result = await searchKnowledgeBase(bad);
    assert.equal(result.found, false);
    assert.equal(result.logEntry.outcome, 'failure');
  }
});

// --- Knowledge base access failures ------------------------------------------

test('missing knowledge base file surfaces as KnowledgeBaseUnavailableError', async () => {
  const result = await searchKnowledgeBase(
    { category: 'login_problem', matchedSignals: [] },
    { kbPath: tempPath('does-not-exist') },
  );
  assert.equal(result.found, false);
  assert.equal(result.logEntry.error_class, 'KnowledgeBaseUnavailableError');
});

test('corrupt (unparseable) knowledge base file surfaces as KnowledgeBaseCorruptError', async () => {
  const kbPath = tempPath('corrupt.json');
  writeFileSync(kbPath, 'not valid json {{{', 'utf8');

  const result = await searchKnowledgeBase({ category: 'login_problem', matchedSignals: [] }, { kbPath });
  assert.equal(result.found, false);
  assert.equal(result.logEntry.error_class, 'KnowledgeBaseCorruptError');
});

test('valid JSON but wrong shape (no articles array) surfaces as KnowledgeBaseCorruptError', async () => {
  const kbPath = tempPath('wrong-shape.json');
  writeFileSync(kbPath, JSON.stringify({ notArticles: [] }), 'utf8');

  const result = await searchKnowledgeBase({ category: 'login_problem', matchedSignals: [] }, { kbPath });
  assert.equal(result.found, false);
  assert.equal(result.logEntry.error_class, 'KnowledgeBaseCorruptError');
});

test('access-denied read surfaces as KnowledgeBaseAccessDeniedError', async () => {
  const readFile = async () => {
    throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
  };

  const result = await searchKnowledgeBase(
    { category: 'login_problem', matchedSignals: [] },
    { kbPath: 'irrelevant', readFile },
  );
  assert.equal(result.found, false);
  assert.equal(result.logEntry.error_class, 'KnowledgeBaseAccessDeniedError');
});

test('a slow read that exceeds the timeout surfaces as KnowledgeBaseTimeoutError', async () => {
  const readFile = () => new Promise((resolve) => setTimeout(() => resolve('{"articles":[]}'), 200));

  const result = await searchKnowledgeBase(
    { category: 'login_problem', matchedSignals: [] },
    { kbPath: 'irrelevant', readFile, timeoutMs: 5 },
  );
  assert.equal(result.found, false);
  assert.equal(result.logEntry.error_class, 'KnowledgeBaseTimeoutError');
  assert.match(result.message, /timed out/i);
});

// --- Trust: search query and results are logged (STORY-004 acceptance) ------

test('search logEntry captures the query and result ids on a match', async () => {
  const classification = classifySupportRequest('Power BI dashboard refresh failed.');
  const result = await searchKnowledgeBase(classification);

  assert.equal(result.logEntry.event, 'knowledge_base_searched');
  assert.deepEqual(result.logEntry.context.query.category, classification.category);
  assert.ok(result.logEntry.context.resultIds.length > 0);
});

test('searchKnowledgeBaseAndLog persists the search logEntry to the audit trail', async () => {
  const logPath = tempPath('audit.log');
  const classification = classifySupportRequest("I can't log in, locked out.");
  const result = await searchKnowledgeBaseAndLog(classification, { logPath });

  assert.equal(result.auditResult.ok, true);
  const [record] = readLines(logPath);
  assert.equal(record.entry.event, 'knowledge_base_searched');
  assert.deepEqual(record.entry.context.resultIds, result.results.map((r) => r.id));
});

test('searchKnowledgeBaseAndLog still logs a failure entry when the classification is malformed', async () => {
  const logPath = tempPath('audit.log');
  const result = await searchKnowledgeBaseAndLog({ category: 'nonsense' }, { logPath });

  assert.equal(result.found, false);
  assert.equal(result.auditResult.ok, true);
  const [record] = readLines(logPath);
  assert.equal(record.entry.outcome, 'failure');
  assert.equal(record.entry.error_class, 'ValidationError');
});

// --- Purity / idempotency of the successful search path ---------------------

test('the same classification always returns the same search result (idempotent)', async () => {
  const classification = { category: 'access_permission_issue', matchedSignals: ['access', 'permission'] };
  const first = await searchKnowledgeBase(classification);
  const second = await searchKnowledgeBase(classification);

  assert.deepEqual(
    first.results.map((r) => r.id),
    second.results.map((r) => r.id),
  );
  assert.equal(first.confidence, second.confidence);
});
