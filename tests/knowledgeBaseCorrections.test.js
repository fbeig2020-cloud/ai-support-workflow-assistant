import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { proposeKnowledgeBaseArticle, reviewKnowledgeBaseProposal } from '../src/knowledgeBaseCorrections.js';
import { listQueuedTickets } from '../src/ticketQueue.js';
import { searchKnowledgeBase } from '../src/knowledgeBaseSearch.js';

// Own subdirectory per file, same reason as the other tests/*.test.js files:
// node --test runs files concurrently, so a shared literal tmp dir name races.
const TMP_DIR = join('tests/tmp', `knowledgeBaseCorrections-${randomUUID()}`);

function tempKbPath(name, articles = SEED_ARTICLES) {
  const kbPath = join(TMP_DIR, `${name}-${randomUUID()}.json`);
  writeFileSync(kbPath, JSON.stringify({ articles }));
  return kbPath;
}

function tempQueueDir(name) {
  return join(TMP_DIR, `${name}-queue-${randomUUID()}`);
}

test.before(() => {
  mkdirSync(TMP_DIR, { recursive: true });
});

test.after(() => {
  rmSync(TMP_DIR, { recursive: true, force: true });
});

const SEED_ARTICLES = [
  { id: 'KB-001', category: 'login_problem', tags: ['password', 'locked out'], title: 'Reset a password', steps: ['do it'], source: 'original' },
  { id: 'KB-002', category: 'data_issue', tags: ['missing data'], title: 'Data is missing', steps: ['check it'], source: 'original' },
];

const VALID_PROPOSAL = {
  sourceTicketId: 'TICKET-9001',
  proposedBy: 'agent.jane',
  category: 'sql_database_issue',
  tags: ['widget', 'sync error'],
  title: 'Widget fails to sync with the SQL backend',
  steps: ['Restart the sync worker.', 'Re-run the widget sync job manually.'],
};

// --- proposeKnowledgeBaseArticle: happy path -----------------------------------

test('proposes a valid article, auto-assigning the next KB id', () => {
  const kbPath = tempKbPath('propose-happy');
  const queueDir = tempQueueDir('propose-happy');
  const result = proposeKnowledgeBaseArticle(VALID_PROPOSAL, { kbPath, queueDir });

  assert.equal(result.ok, true);
  assert.equal(result.proposed, true);
  assert.equal(result.proposalId, 'KB-003');
  assert.equal(result.logEntry.service, 'knowledgeBaseCorrections');
  assert.equal(result.logEntry.event, 'kb_article_proposed');
  assert.equal(result.logEntry.outcome, 'success');
  assert.ok(!Number.isNaN(Date.parse(result.logEntry.timestamp)));
});

test('a proposal is added to the existing ticket queue, tagged so it is unmistakably not a real article or a student ticket', () => {
  const kbPath = tempKbPath('propose-queue');
  const queueDir = tempQueueDir('propose-queue');
  proposeKnowledgeBaseArticle(VALID_PROPOSAL, { kbPath, queueDir });

  const queued = listQueuedTickets({ queueDir });
  assert.equal(queued.length, 1);
  assert.equal(queued[0].type, 'suggested_kb_article');
  assert.equal(queued[0].requestId, 'KB-003');
  assert.equal(queued[0].sourceTicketId, 'TICKET-9001');
});

// --- proposeKnowledgeBaseArticle: auto-assigned id never collides --------------

test('auto-assigned id accounts for existing articles already in knowledgeBase.json', () => {
  const kbPath = tempKbPath('id-existing', [
    { id: 'KB-001', category: 'login_problem', tags: ['x'], title: 'a', steps: ['s'] },
    { id: 'KB-005', category: 'data_issue', tags: ['y'], title: 'b', steps: ['s'] },
  ]);
  const queueDir = tempQueueDir('id-existing');
  const result = proposeKnowledgeBaseArticle(VALID_PROPOSAL, { kbPath, queueDir });
  assert.equal(result.proposalId, 'KB-006');
});

test('auto-assigned id also accounts for already-queued pending proposals, not just knowledgeBase.json', () => {
  const kbPath = tempKbPath('id-pending');
  const queueDir = tempQueueDir('id-pending');
  const first = proposeKnowledgeBaseArticle(VALID_PROPOSAL, { kbPath, queueDir });
  const second = proposeKnowledgeBaseArticle({ ...VALID_PROPOSAL, sourceTicketId: 'TICKET-9002' }, { kbPath, queueDir });

  assert.equal(first.proposalId, 'KB-003');
  assert.equal(second.proposalId, 'KB-004');
  assert.notEqual(first.proposalId, second.proposalId);
});

// --- proposeKnowledgeBaseArticle: malformed input (fail closed, never throw) --

test('malformed proposal shapes fail closed, never throw', () => {
  const kbPath = tempKbPath('malformed');
  const queueDir = tempQueueDir('malformed');
  const badProposals = [
    null,
    undefined,
    42,
    [],
    {},
    { ...VALID_PROPOSAL, sourceTicketId: '' },
    { ...VALID_PROPOSAL, proposedBy: '' },
    { ...VALID_PROPOSAL, category: 'not_a_real_category' },
    { ...VALID_PROPOSAL, tags: [] },
    { ...VALID_PROPOSAL, tags: ['', '  '] },
    { ...VALID_PROPOSAL, title: '' },
    { ...VALID_PROPOSAL, steps: [] },
  ];

  for (const bad of badProposals) {
    assert.doesNotThrow(() => proposeKnowledgeBaseArticle(bad, { kbPath, queueDir }));
    const result = proposeKnowledgeBaseArticle(bad, { kbPath, queueDir });
    assert.equal(result.ok, false);
    assert.equal(result.proposed, false);
    assert.equal(result.logEntry.outcome, 'failure');
    assert.equal(result.logEntry.error_class, 'ValidationError');
  }
});

// --- proposeKnowledgeBaseArticle: duplicate handling ---------------------------

test('proposing twice for the same sourceTicketId is an idempotent no-op, not a second proposal', () => {
  const kbPath = tempKbPath('duplicate');
  const queueDir = tempQueueDir('duplicate');
  const first = proposeKnowledgeBaseArticle(VALID_PROPOSAL, { kbPath, queueDir });
  const second = proposeKnowledgeBaseArticle(VALID_PROPOSAL, { kbPath, queueDir });

  assert.equal(first.proposed, true);
  assert.equal(second.ok, true);
  assert.equal(second.proposed, false);
  assert.equal(second.duplicate, true);
  assert.equal(second.proposalId, first.proposalId);
  assert.equal(listQueuedTickets({ queueDir }).length, 1);
});

// --- reviewKnowledgeBaseProposal: happy path (approve) -------------------------

test('approve adds a real, searchable article to knowledgeBase.json', () => {
  const kbPath = tempKbPath('approve-happy');
  const queueDir = tempQueueDir('approve-happy');
  const { proposalId } = proposeKnowledgeBaseArticle(VALID_PROPOSAL, { kbPath, queueDir });

  const result = reviewKnowledgeBaseProposal(proposalId, { action: 'approve', reviewer: 'agent.jane' }, { kbPath, queueDir });

  assert.equal(result.ok, true);
  assert.equal(result.outcome, 'approved');
  assert.equal(result.article.id, proposalId);
  assert.equal(result.article.category, 'sql_database_issue');
  assert.equal(result.article.source, 'human_approved_correction');
  assert.equal(result.logEntry.event, 'kb_proposal_approved');

  const onDisk = JSON.parse(readFileSync(kbPath, 'utf8'));
  assert.equal(onDisk.articles.length, SEED_ARTICLES.length + 1);
  assert.ok(onDisk.articles.some((a) => a.id === proposalId));
});

test('the same person who proposed an article may approve it themselves', () => {
  const kbPath = tempKbPath('self-approve');
  const queueDir = tempQueueDir('self-approve');
  const { proposalId } = proposeKnowledgeBaseArticle(VALID_PROPOSAL, { kbPath, queueDir });

  const result = reviewKnowledgeBaseProposal(proposalId, { action: 'approve', reviewer: VALID_PROPOSAL.proposedBy }, { kbPath, queueDir });
  assert.equal(result.outcome, 'approved');
});

// --- reviewKnowledgeBaseProposal: search finds the newly added article --------

test('a search performed after approval finds the newly added article', async () => {
  const kbPath = tempKbPath('searchable');
  const queueDir = tempQueueDir('searchable');
  const { proposalId } = proposeKnowledgeBaseArticle(VALID_PROPOSAL, { kbPath, queueDir });
  reviewKnowledgeBaseProposal(proposalId, { action: 'approve', reviewer: 'agent.jane' }, { kbPath, queueDir });

  const searchResult = await searchKnowledgeBase(
    { category: 'sql_database_issue', matchedSignals: ['widget', 'sync error'] },
    { kbPath },
  );

  assert.equal(searchResult.found, true);
  assert.ok(searchResult.results.some((r) => r.id === proposalId));
});

// --- reviewKnowledgeBaseProposal: reject leaves knowledgeBase.json untouched --

test('reject leaves knowledgeBase.json completely unchanged', () => {
  const kbPath = tempKbPath('reject-happy');
  const queueDir = tempQueueDir('reject-happy');
  const before = readFileSync(kbPath, 'utf8');
  const { proposalId } = proposeKnowledgeBaseArticle(VALID_PROPOSAL, { kbPath, queueDir });

  const result = reviewKnowledgeBaseProposal(proposalId, { action: 'reject', reviewer: 'agent.jane', reason: 'duplicate of KB-002' }, { kbPath, queueDir });

  assert.equal(result.ok, true);
  assert.equal(result.outcome, 'rejected');
  assert.equal(result.reason, 'duplicate of KB-002');
  assert.equal(readFileSync(kbPath, 'utf8'), before, 'knowledgeBase.json must be byte-for-byte unchanged on reject');
});

// --- reviewKnowledgeBaseProposal: decided proposals are removed from the queue -

test('an approved proposal is removed from the ticket queue', () => {
  const kbPath = tempKbPath('cleanup-approve');
  const queueDir = tempQueueDir('cleanup-approve');
  const { proposalId } = proposeKnowledgeBaseArticle(VALID_PROPOSAL, { kbPath, queueDir });
  reviewKnowledgeBaseProposal(proposalId, { action: 'approve', reviewer: 'agent.jane' }, { kbPath, queueDir });

  assert.equal(listQueuedTickets({ queueDir }).length, 0);
});

test('a rejected proposal is removed from the ticket queue', () => {
  const kbPath = tempKbPath('cleanup-reject');
  const queueDir = tempQueueDir('cleanup-reject');
  const { proposalId } = proposeKnowledgeBaseArticle(VALID_PROPOSAL, { kbPath, queueDir });
  reviewKnowledgeBaseProposal(proposalId, { action: 'reject', reviewer: 'agent.jane' }, { kbPath, queueDir });

  assert.equal(listQueuedTickets({ queueDir }).length, 0);
});

// --- reviewKnowledgeBaseProposal: malformed input / not found (fail closed) ---

test('an unknown proposalId fails closed with proposal_not_found, never throws', () => {
  const kbPath = tempKbPath('not-found');
  const queueDir = tempQueueDir('not-found');
  assert.doesNotThrow(() => reviewKnowledgeBaseProposal('KB-999', { action: 'approve', reviewer: 'agent.jane' }, { kbPath, queueDir }));
  const result = reviewKnowledgeBaseProposal('KB-999', { action: 'approve', reviewer: 'agent.jane' }, { kbPath, queueDir });
  assert.equal(result.ok, false);
  assert.equal(result.outcome, 'error');
  assert.equal(result.reason, 'proposal_not_found');
});

test('malformed proposalId values fail closed, never throw', () => {
  const kbPath = tempKbPath('bad-id');
  const queueDir = tempQueueDir('bad-id');
  for (const bad of [null, undefined, 42, '', '   ', {}]) {
    assert.doesNotThrow(() => reviewKnowledgeBaseProposal(bad, { action: 'approve', reviewer: 'agent.jane' }, { kbPath, queueDir }));
    const result = reviewKnowledgeBaseProposal(bad, { action: 'approve', reviewer: 'agent.jane' }, { kbPath, queueDir });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'invalid_proposal_id');
  }
});

test('malformed decision shapes fail closed, never throw', () => {
  const kbPath = tempKbPath('bad-decision');
  const queueDir = tempQueueDir('bad-decision');
  const { proposalId } = proposeKnowledgeBaseArticle(VALID_PROPOSAL, { kbPath, queueDir });

  for (const bad of [null, undefined, {}, { action: 'delete', reviewer: 'agent.jane' }, { action: 'approve', reviewer: '' }]) {
    const result = reviewKnowledgeBaseProposal(proposalId, bad, { kbPath, queueDir });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'invalid_decision');
  }
  // the proposal must still be sitting in the queue, untouched by any of the failed attempts above.
  assert.equal(listQueuedTickets({ queueDir }).length, 1);
});

// --- reviewKnowledgeBaseProposal: approve fails closed on an id conflict ------

test('approve fails closed rather than overwriting an existing article with the same id', () => {
  const kbPath = tempKbPath('id-conflict');
  const queueDir = tempQueueDir('id-conflict');
  const { proposalId } = proposeKnowledgeBaseArticle(VALID_PROPOSAL, { kbPath, queueDir });

  // Simulate the id already existing in knowledgeBase.json by the time approval runs.
  const current = JSON.parse(readFileSync(kbPath, 'utf8'));
  current.articles.push({ id: proposalId, category: 'data_issue', tags: ['x'], title: 'already here', steps: ['s'] });
  writeFileSync(kbPath, JSON.stringify(current));

  const result = reviewKnowledgeBaseProposal(proposalId, { action: 'approve', reviewer: 'agent.jane' }, { kbPath, queueDir });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'article_id_already_exists');

  const onDisk = JSON.parse(readFileSync(kbPath, 'utf8'));
  assert.equal(onDisk.articles.filter((a) => a.id === proposalId).length, 1, 'must not duplicate the article');
});
