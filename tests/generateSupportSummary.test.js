import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateSupportSummary } from '../src/generateSupportSummary.js';
import { generateSupportSummaryAndLog } from '../src/auditedActions.js';

// Own subdirectory per file, same reason as the other tests/*.test.js files:
// node --test runs files concurrently, so a shared literal tmp dir name races.
const TMP_DIR = join('tests/tmp', `generateSupportSummary-${randomUUID()}`);

function tempPath(name) {
  return join(TMP_DIR, `${name}-${randomUUID()}`);
}

function readLinesFrom(logPath) {
  return readFileSync(logPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
}

const VALID_CLASSIFICATION = {
  category: 'sql_database_issue',
  priority: 'high',
  summary: 'Query is timing out on the reporting database.',
  matchedSignals: ['sql', 'query timeout'],
};

const APPROVED_CLASSIFICATION_REVIEW = {
  ok: true,
  outcome: 'approved',
  classification: VALID_CLASSIFICATION,
  logEntry: {
    timestamp: new Date().toISOString(),
    level: 'info',
    service: 'reviewClassification',
    event: 'classification_approved',
    outcome: 'success',
    context: { category: 'sql_database_issue', priority: 'high', action: 'approve', reviewer: 'Jane Agent' },
  },
};

const GENERATED_DRAFT_RESPONSE = {
  generated: true,
  editable: true,
  draftText: 'Hi,\n\nHere are the steps...\n\nThanks',
  category: 'sql_database_issue',
  templateUsed: 'sql_database_issue',
  kbConfidence: 'high',
  logEntry: {
    timestamp: new Date().toISOString(),
    level: 'info',
    service: 'generateDraftResponse',
    event: 'draft_response_generated',
    outcome: 'success',
    context: { category: 'sql_database_issue', templateUsed: 'sql_database_issue', kbConfidence: 'high', draftLength: 42 },
  },
};

const FOUND_KB_RESULT = {
  found: true,
  confidence: 'high',
  results: [
    { id: 'kb-1', title: 'Reporting DB timeout fix', category: 'sql_database_issue', steps: ['Restart the connector'], score: 4, confidence: 'high' },
  ],
};

const NOT_FOUND_KB_RESULT = {
  found: false,
  confidence: 'none',
  results: [],
  message: 'No relevant troubleshooting steps were found in the knowledge base for this request.',
};

const RECOMMENDED_ESCALATION = {
  ok: true,
  recommended: true,
  reason: 'no_knowledge_base_match',
  explanation: 'No relevant troubleshooting steps were found in the knowledge base for this SQL/database issue. Escalating to a specialist is recommended.',
  action: { type: 'escalate', description: 'Escalating to a specialist is recommended.', requiresApproval: true, status: 'proposed' },
  logEntry: {
    timestamp: new Date().toISOString(),
    level: 'info',
    service: 'generateEscalationRecommendation',
    event: 'escalation_recommended',
    outcome: 'success',
    context: { category: 'sql_database_issue', recommended: true, reason: 'no_knowledge_base_match' },
  },
};

const APPROVED_ESCALATION_REVIEW = {
  ok: true,
  outcome: 'approved',
  recommendation: RECOMMENDED_ESCALATION,
  logEntry: {
    timestamp: new Date().toISOString(),
    level: 'info',
    service: 'reviewEscalation',
    event: 'escalation_approved',
    outcome: 'success',
    context: { escalationReason: 'no_knowledge_base_match', action: 'approve', reviewer: 'Jane Agent' },
  },
};

function baseWorkflow(overrides = {}) {
  return {
    ticketId: 'TICKET-1001',
    requestText: 'My reporting database query keeps timing out.',
    classification: VALID_CLASSIFICATION,
    classificationReview: APPROVED_CLASSIFICATION_REVIEW,
    draftResponse: GENERATED_DRAFT_RESPONSE,
    kbSearchResult: FOUND_KB_RESULT,
    ...overrides,
  };
}

// --- Happy path: resolved without escalation ---------------------------------

test('generates a complete summary for a resolved ticket (no escalation)', () => {
  const result = generateSupportSummary(baseWorkflow());
  assert.equal(result.generated, true);
  assert.equal(result.ticketId, 'TICKET-1001');
  assert.match(result.summaryText, /TICKET-1001/);
  assert.match(result.summaryText, /My reporting database query keeps timing out\./);
  assert.match(result.summaryText, /Category: sql_database_issue/);
  assert.match(result.summaryText, /Priority: high/);
  assert.match(result.summaryText, /Approved by Jane Agent\./);
  assert.match(result.summaryText, /Found \(confidence: high\)\. Articles used: Reporting DB timeout fix\./);
  assert.match(result.summaryText, /Generated \(template: sql_database_issue\)\./);
  assert.match(result.summaryText, /Not recommended — issue was resolved without escalation\./);
});

// --- Happy path: resolved with an escalation ---------------------------------

test('generates a complete summary including the escalation recommendation and decision', () => {
  const workflow = baseWorkflow({
    kbSearchResult: NOT_FOUND_KB_RESULT,
    escalationRecommendation: RECOMMENDED_ESCALATION,
    escalationReview: APPROVED_ESCALATION_REVIEW,
  });
  const result = generateSupportSummary(workflow);
  assert.equal(result.generated, true);
  assert.match(result.summaryText, /No relevant knowledge-base match was found\./);
  assert.match(result.summaryText, /Recommended: No relevant troubleshooting steps/);
  assert.match(result.summaryText, /Decision: Approved by Jane Agent\./);
});

test('a not-recommended escalation result (no escalation object) still renders a clear explanation', () => {
  const notRecommended = {
    ok: true,
    recommended: false,
    reason: 'resolved_by_knowledge_base',
    explanation: 'Relevant troubleshooting steps were found, so escalation is not recommended.',
    action: null,
    logEntry: { timestamp: new Date().toISOString(), level: 'info', service: 'generateEscalationRecommendation', event: 'escalation_not_recommended', outcome: 'success', context: {} },
  };
  const result = generateSupportSummary(baseWorkflow({ escalationRecommendation: notRecommended }));
  assert.equal(result.generated, true);
  assert.match(result.summaryText, /Not recommended: Relevant troubleshooting steps were found/);
});

// --- Graceful degradation: no KB search recorded -----------------------------

test('degrades gracefully when kbSearchResult is absent, rather than failing', () => {
  const workflow = baseWorkflow();
  delete workflow.kbSearchResult;
  const result = generateSupportSummary(workflow);
  assert.equal(result.generated, true);
  assert.match(result.summaryText, /No knowledge-base search recorded for this ticket\./);
});

// --- Failure path: incomplete workflow (fails closed) ------------------------

test('fails closed when ticketId is missing', () => {
  const workflow = baseWorkflow({ ticketId: undefined });
  const result = generateSupportSummary(workflow);
  assert.equal(result.generated, false);
  assert.equal(result.summaryText, '');
  assert.equal(result.logEntry.context.reason, 'invalid_ticket_id');
});

test('fails closed when ticketId is a blank string', () => {
  const result = generateSupportSummary(baseWorkflow({ ticketId: '   ' }));
  assert.equal(result.generated, false);
  assert.equal(result.logEntry.context.reason, 'invalid_ticket_id');
});

test('fails closed when requestText is missing', () => {
  const result = generateSupportSummary(baseWorkflow({ requestText: undefined }));
  assert.equal(result.generated, false);
  assert.equal(result.logEntry.context.reason, 'invalid_request_text');
});

test('fails closed when classification is malformed', () => {
  const result = generateSupportSummary(baseWorkflow({ classification: { category: 'not_a_real_category' } }));
  assert.equal(result.generated, false);
  assert.equal(result.logEntry.context.reason, 'invalid_classification');
});

test('fails closed when classificationReview is missing the reviewer', () => {
  const badReview = { ...APPROVED_CLASSIFICATION_REVIEW, logEntry: { ...APPROVED_CLASSIFICATION_REVIEW.logEntry, context: { ...APPROVED_CLASSIFICATION_REVIEW.logEntry.context, reviewer: '' } } };
  const result = generateSupportSummary(baseWorkflow({ classificationReview: badReview }));
  assert.equal(result.generated, false);
  assert.equal(result.logEntry.context.reason, 'invalid_classification_review');
});

test('fails closed when draftResponse is malformed (missing generated flag)', () => {
  const result = generateSupportSummary(baseWorkflow({ draftResponse: { draftText: 'oops' } }));
  assert.equal(result.generated, false);
  assert.equal(result.logEntry.context.reason, 'invalid_draft_response');
});

test('fails closed when kbSearchResult is present but malformed (missing found)', () => {
  const result = generateSupportSummary(baseWorkflow({ kbSearchResult: { results: [] } }));
  assert.equal(result.generated, false);
  assert.equal(result.logEntry.context.reason, 'invalid_kb_search_result');
});

test('never throws on completely malformed workflow inputs', () => {
  const badInputs = [null, undefined, 'not an object', 42, [], []];
  for (const bad of badInputs) {
    const result = generateSupportSummary(bad);
    assert.equal(result.generated, false);
    assert.equal(result.summaryText, '');
  }
});

// --- Failure path: escalation data present but inconsistent (fails closed) ---

test('fails closed when an escalationReview is present without any escalationRecommendation', () => {
  const result = generateSupportSummary(baseWorkflow({ escalationReview: APPROVED_ESCALATION_REVIEW }));
  assert.equal(result.generated, false);
  assert.equal(result.logEntry.context.reason, 'escalation_review_without_recommendation');
  assert.equal(result.logEntry.error_class, 'EscalationMismatchError');
});

test('fails closed when escalation was recommended but no escalationReview was provided', () => {
  const result = generateSupportSummary(baseWorkflow({ kbSearchResult: NOT_FOUND_KB_RESULT, escalationRecommendation: RECOMMENDED_ESCALATION }));
  assert.equal(result.generated, false);
  assert.equal(result.logEntry.context.reason, 'escalation_recommended_without_review');
});

test('fails closed when escalation was NOT recommended but an escalationReview was provided anyway', () => {
  const notRecommended = { ...RECOMMENDED_ESCALATION, recommended: false, reason: 'resolved_by_knowledge_base', action: null };
  const result = generateSupportSummary(baseWorkflow({ escalationRecommendation: notRecommended, escalationReview: APPROVED_ESCALATION_REVIEW }));
  assert.equal(result.generated, false);
  assert.equal(result.logEntry.context.reason, 'escalation_review_without_recommendation');
});

test('fails closed when the escalationReview references a different recommendation than the one in the workflow', () => {
  const otherRecommendation = { ...RECOMMENDED_ESCALATION, explanation: 'A completely different explanation.' };
  const mismatchedReview = { ...APPROVED_ESCALATION_REVIEW, recommendation: otherRecommendation };
  const result = generateSupportSummary(baseWorkflow({ kbSearchResult: NOT_FOUND_KB_RESULT, escalationRecommendation: RECOMMENDED_ESCALATION, escalationReview: mismatchedReview }));
  assert.equal(result.generated, false);
  assert.equal(result.logEntry.context.reason, 'escalation_review_mismatch');
  assert.equal(result.logEntry.error_class, 'EscalationMismatchError');
});

// --- logEntry shape -----------------------------------------------------------

test('a successful summary logs a success entry with the expected shape', () => {
  const result = generateSupportSummary(baseWorkflow({ kbSearchResult: NOT_FOUND_KB_RESULT, escalationRecommendation: RECOMMENDED_ESCALATION, escalationReview: APPROVED_ESCALATION_REVIEW }));
  assert.equal(result.logEntry.service, 'generateSupportSummary');
  assert.equal(result.logEntry.event, 'support_summary_generated');
  assert.equal(result.logEntry.outcome, 'success');
  assert.equal(result.logEntry.level, 'info');
  assert.equal(result.logEntry.context.ticketId, 'TICKET-1001');
  assert.equal(result.logEntry.context.category, 'sql_database_issue');
  assert.equal(result.logEntry.context.escalated, true);
  assert.ok(result.logEntry.context.summaryLength > 0);
  assert.ok(!Number.isNaN(Date.parse(result.logEntry.timestamp)));
});

test('escalated is false in the log entry when no escalation was recommended', () => {
  const result = generateSupportSummary(baseWorkflow());
  assert.equal(result.logEntry.context.escalated, false);
});

test('a failed summary logs a failure entry with a warn level', () => {
  const result = generateSupportSummary(baseWorkflow({ ticketId: undefined }));
  assert.equal(result.logEntry.outcome, 'failure');
  assert.equal(result.logEntry.level, 'warn');
});

// --- Trust: the summary generation is persisted (STORY-007 acceptance) --------

test('generateSupportSummaryAndLog persists the summary logEntry to the audit trail', () => {
  const logPath = tempPath('audit.log');
  const result = generateSupportSummaryAndLog(baseWorkflow(), { logPath });

  assert.equal(result.generated, true);
  assert.equal(result.auditResult.ok, true);
  const [record] = readLinesFrom(logPath);
  assert.equal(record.entry.event, 'support_summary_generated');
  assert.equal(record.entry.context.ticketId, 'TICKET-1001');
});

test('generateSupportSummaryAndLog still logs a failure entry when the workflow is incomplete', () => {
  const logPath = tempPath('audit.log');
  const result = generateSupportSummaryAndLog(baseWorkflow({ ticketId: undefined }), { logPath });

  assert.equal(result.generated, false);
  assert.equal(result.auditResult.ok, true);
  const [record] = readLinesFrom(logPath);
  assert.equal(record.entry.outcome, 'failure');
  assert.equal(record.entry.context.reason, 'invalid_ticket_id');
});

// --- Purity / idempotency ------------------------------------------------------

test('generateSupportSummary is pure: same input yields the same summary text on repeat calls', () => {
  const workflow = baseWorkflow();
  const first = generateSupportSummary(workflow);
  const second = generateSupportSummary(workflow);
  assert.equal(first.generated, second.generated);
  assert.equal(first.summaryText, second.summaryText);
});
