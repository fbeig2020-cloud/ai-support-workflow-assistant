import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateDraftResponse } from '../src/generateDraftResponse.js';
import { generateDraftResponseAndLog } from '../src/auditedActions.js';
import { classifySupportRequest } from '../src/classify.js';
import { searchKnowledgeBase } from '../src/knowledgeBaseSearch.js';

// Own subdirectory per file, same reason as the other tests/*.test.js files:
// node --test runs files concurrently, so a shared literal tmp dir name races.
const TMP_DIR = join('tests/tmp', `generateDraftResponse-${randomUUID()}`);

function tempPath(name) {
  return join(TMP_DIR, `${name}-${randomUUID()}`);
}

function readLinesFrom(logPath) {
  return readFileSync(logPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
}

/** A minimal, valid template file, so tests that corrupt one field don't need to restate the rest. */
function validTemplateFixture(overrides = {}) {
  return {
    greeting: 'Hello,',
    signOff: 'Best regards,\nSupport Team',
    templates: {
      login_problem: { openingLine: 'Thanks for the login report.', closingLine: 'Let us know if it continues.' },
      default: { openingLine: 'Thanks for contacting support.', closingLine: 'Let us know if you need more help.' },
    },
    stepsSection: {
      foundHeading: 'Steps for "{{articleTitle}}":',
      lowConfidenceCaveat: 'Low-confidence match — please confirm.',
      notFound: 'No specific article found yet.',
    },
    ...overrides,
  };
}

test.before(() => {
  mkdirSync(TMP_DIR, { recursive: true });
});

test.after(() => {
  rmSync(TMP_DIR, { recursive: true, force: true });
});

// --- Happy path -------------------------------------------------------------

test('generates a professional draft with numbered steps for a high-confidence KB match', async () => {
  const classification = classifySupportRequest("I can't log in, I'm locked out of my account.");
  const kbResult = await searchKnowledgeBase(classification);
  assert.equal(kbResult.found, true); // sanity: this test needs a real match to be meaningful

  const draft = await generateDraftResponse(classification, kbResult);

  assert.equal(draft.generated, true);
  assert.equal(draft.editable, true);
  assert.equal(draft.category, 'login_problem');
  assert.equal(draft.templateUsed, 'login_problem');
  assert.match(draft.draftText, /Hello/);
  assert.match(draft.draftText, /1\. /); // numbered steps present
  assert.match(draft.draftText, /Support Team/);
  assert.ok(!draft.draftText.includes('{{'));
});

test('includes the classification summary in the draft when present', async () => {
  const classification = classifySupportRequest('Power BI dashboard refresh failed for the whole team.');
  const kbResult = await searchKnowledgeBase(classification);

  const draft = await generateDraftResponse(classification, kbResult);

  assert.match(draft.draftText, /Specifically:/);
  assert.ok(draft.draftText.includes(classification.summary));
});

test('a low-confidence KB match includes the caveat line in the draft', async () => {
  const classification = { category: 'general_support_request', matchedSignals: ['report'] };
  const kbResult = await searchKnowledgeBase(classification);
  assert.equal(kbResult.confidence, 'low'); // sanity, mirrors knowledgeBaseSearch.test.js's low-confidence case

  const draft = await generateDraftResponse(classification, kbResult);

  assert.equal(draft.generated, true);
  assert.match(draft.draftText, /low-confidence/i);
});

test('a "not found" KB result produces a draft with no fabricated steps', async () => {
  const classification = { category: 'general_support_request', matchedSignals: [] };
  const kbResult = await searchKnowledgeBase(classification);
  assert.equal(kbResult.found, false);

  const draft = await generateDraftResponse(classification, kbResult);

  assert.equal(draft.generated, true);
  assert.match(draft.draftText, /weren't able to find/i);
  assert.ok(!/^\d+\. /m.test(draft.draftText)); // no numbered steps fabricated
});

test('general_support_request falls back to the default template', async () => {
  const classification = { category: 'general_support_request', matchedSignals: [] };
  const kbResult = await searchKnowledgeBase(classification);

  const draft = await generateDraftResponse(classification, kbResult);

  assert.equal(draft.templateUsed, 'default');
});

test('a missing kbSearchResult is treated as not-found rather than throwing', async () => {
  const classification = classifySupportRequest("I can't log in.");
  const draft = await generateDraftResponse(classification, undefined);

  assert.equal(draft.generated, true);
  assert.match(draft.draftText, /weren't able to find/i);
});

// --- Response not generated: malformed classification fails closed ----------

test('fails closed on a missing category', async () => {
  const draft = await generateDraftResponse({ matchedSignals: [] }, undefined);
  assert.equal(draft.generated, false);
  assert.equal(draft.editable, true);
  assert.equal(draft.draftText, '');
  assert.equal(draft.logEntry.error_class, 'ValidationError');
});

test('fails closed on an unrecognized category', async () => {
  const draft = await generateDraftResponse({ category: 'not_a_real_category' }, undefined);
  assert.equal(draft.generated, false);
  assert.equal(draft.logEntry.error_class, 'ValidationError');
});

test('fails closed on non-object classification input without throwing', async () => {
  for (const bad of [null, undefined, 'login_problem', 42, ['login_problem']]) {
    const draft = await generateDraftResponse(bad, undefined);
    assert.equal(draft.generated, false);
    assert.equal(draft.logEntry.outcome, 'failure');
  }
});

// --- Template missing / unavailable ------------------------------------------

test('missing template file surfaces as TemplateUnavailableError', async () => {
  const draft = await generateDraftResponse(
    { category: 'login_problem', matchedSignals: [] },
    undefined,
    { templatesPath: tempPath('does-not-exist') },
  );
  assert.equal(draft.generated, false);
  assert.equal(draft.logEntry.error_class, 'TemplateUnavailableError');
});

test('corrupt (unparseable) template file surfaces as TemplateCorruptError', async () => {
  const templatesPath = tempPath('corrupt.json');
  writeFileSync(templatesPath, 'not valid json {{{', 'utf8');

  const draft = await generateDraftResponse({ category: 'login_problem', matchedSignals: [] }, undefined, { templatesPath });
  assert.equal(draft.generated, false);
  assert.equal(draft.logEntry.error_class, 'TemplateCorruptError');
});

test('valid JSON but wrong shape surfaces as TemplateCorruptError', async () => {
  const templatesPath = tempPath('wrong-shape.json');
  writeFileSync(templatesPath, JSON.stringify({ notTemplates: [] }), 'utf8');

  const draft = await generateDraftResponse({ category: 'login_problem', matchedSignals: [] }, undefined, { templatesPath });
  assert.equal(draft.generated, false);
  assert.equal(draft.logEntry.error_class, 'TemplateCorruptError');
});

test('access-denied read surfaces as TemplateAccessDeniedError', async () => {
  const readFile = async () => {
    throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
  };

  const draft = await generateDraftResponse(
    { category: 'login_problem', matchedSignals: [] },
    undefined,
    { templatesPath: 'irrelevant', readFile },
  );
  assert.equal(draft.generated, false);
  assert.equal(draft.logEntry.error_class, 'TemplateAccessDeniedError');
});

test('a slow read that exceeds the timeout surfaces as TemplateTimeoutError', async () => {
  const readFile = () => new Promise((resolve) => setTimeout(() => resolve(JSON.stringify(validTemplateFixture())), 200));

  const draft = await generateDraftResponse(
    { category: 'login_problem', matchedSignals: [] },
    undefined,
    { templatesPath: 'irrelevant', readFile, timeoutMs: 5 },
  );
  assert.equal(draft.generated, false);
  assert.equal(draft.logEntry.error_class, 'TemplateTimeoutError');
  assert.match(draft.message, /timed out/i);
});

test('category with neither its own template nor a default surfaces as TemplateMissingError', async () => {
  const templatesPath = tempPath('no-default.json');
  const fixture = validTemplateFixture();
  delete fixture.templates.login_problem;
  delete fixture.templates.default;
  writeFileSync(templatesPath, JSON.stringify(fixture), 'utf8');

  const draft = await generateDraftResponse({ category: 'login_problem', matchedSignals: [] }, undefined, { templatesPath });
  assert.equal(draft.generated, false);
  assert.equal(draft.logEntry.error_class, 'TemplateMissingError');
});

// --- Response contains errors: rendering self-check --------------------------

test('an unresolved placeholder left in the rendered draft surfaces as ResponseRenderError', async () => {
  const templatesPath = tempPath('stray-placeholder.json');
  const fixture = validTemplateFixture();
  fixture.templates.login_problem.closingLine = 'Reach out at {{supportEmail}} any time.';
  writeFileSync(templatesPath, JSON.stringify(fixture), 'utf8');

  const draft = await generateDraftResponse({ category: 'login_problem', matchedSignals: [] }, undefined, { templatesPath });
  assert.equal(draft.generated, false);
  assert.equal(draft.logEntry.error_class, 'ResponseRenderError');
  assert.equal(draft.draftText, '');
});

// --- Response not editable: contract check on the returned shape ------------

test('every successful draft is returned as plain, unlocked, editable text', async () => {
  const classification = classifySupportRequest("I can't log in, locked out.");
  const kbResult = await searchKnowledgeBase(classification);
  const draft = await generateDraftResponse(classification, kbResult);

  assert.equal(draft.editable, true);
  assert.equal(typeof draft.draftText, 'string');
  assert.equal(draft.sent, undefined);
  assert.equal(draft.approved, undefined);
  assert.equal(draft.locked, undefined);

  // Nothing prevents the caller from editing it — it's a plain string, not a frozen object.
  const edited = draft.draftText.replace('Hello,', 'Hi there,');
  assert.notEqual(edited, draft.draftText);
});

// --- Trust: draft generation is logged (STORY-005 acceptance) ---------------

test('logEntry captures the category, template used, and draft length on success', async () => {
  const classification = classifySupportRequest("I can't log in, locked out.");
  const kbResult = await searchKnowledgeBase(classification);
  const draft = await generateDraftResponse(classification, kbResult);

  assert.equal(draft.logEntry.event, 'draft_response_generated');
  assert.equal(draft.logEntry.outcome, 'success');
  assert.equal(draft.logEntry.context.category, 'login_problem');
  assert.equal(draft.logEntry.context.templateUsed, 'login_problem');
  assert.equal(draft.logEntry.context.draftLength, draft.draftText.length);
});

// --- Trust: draft generation is persisted (STORY-005 acceptance) ------------

test('generateDraftResponseAndLog persists the draft logEntry to the audit trail', async () => {
  const logPath = tempPath('audit.log');
  const classification = classifySupportRequest("I can't log in, locked out.");
  const kbResult = await searchKnowledgeBase(classification);

  const result = await generateDraftResponseAndLog(classification, kbResult, { logPath });

  assert.equal(result.generated, true);
  assert.equal(result.auditResult.ok, true);
  const [record] = readLinesFrom(logPath);
  assert.equal(record.entry.event, 'draft_response_generated');
  assert.equal(record.entry.context.category, 'login_problem');
});

test('generateDraftResponseAndLog still logs a failure entry when the classification is malformed', async () => {
  const logPath = tempPath('audit.log');
  const result = await generateDraftResponseAndLog({ category: 'nonsense' }, undefined, { logPath });

  assert.equal(result.generated, false);
  assert.equal(result.auditResult.ok, true);
  const [record] = readLinesFrom(logPath);
  assert.equal(record.entry.outcome, 'failure');
  assert.equal(record.entry.error_class, 'ValidationError');
});

// --- onDiskRead observability hook (mcp-server.js's disk-read boundary) -----

test('onDiskRead fires started then finished(success) around a successful read', async () => {
  const events = [];
  const draft = await generateDraftResponse(
    { category: 'login_problem', matchedSignals: [] },
    undefined,
    { onDiskRead: (evt) => events.push(evt) },
  );

  assert.equal(draft.generated, true);
  assert.deepEqual(events.map((e) => e.phase), ['started', 'finished']);
  assert.equal(events[0].file, 'responseTemplates.json');
  assert.equal(events[1].outcome, 'success');
  assert.equal(typeof events[1].durationMs, 'number');
});

test('onDiskRead fires finished(failure) with the tagged error class on a read failure, and does not fire at all when validation fails before any read is attempted', async () => {
  const events = [];
  const draft = await generateDraftResponse(
    { category: 'login_problem', matchedSignals: [] },
    undefined,
    { templatesPath: tempPath('does-not-exist'), onDiskRead: (evt) => events.push(evt) },
  );

  assert.equal(draft.generated, false);
  assert.deepEqual(events.map((e) => e.phase), ['started', 'finished']);
  assert.equal(events[1].outcome, 'failure');
  assert.equal(events[1].errorClass, 'TemplateUnavailableError');

  const validationEvents = [];
  await generateDraftResponse({ category: 'not_a_real_category' }, undefined, {
    onDiskRead: (evt) => validationEvents.push(evt),
  });
  assert.deepEqual(validationEvents, []);
});

// --- Purity / idempotency of the successful generation path ------------------

test('the same classification and KB result always render the same draft (idempotent)', async () => {
  const classification = { category: 'access_permission_issue', matchedSignals: ['access', 'permission'] };
  const kbResult = await searchKnowledgeBase(classification);

  const first = await generateDraftResponse(classification, kbResult);
  const second = await generateDraftResponse(classification, kbResult);

  assert.equal(first.draftText, second.draftText);
  assert.equal(first.templateUsed, second.templateUsed);
});
