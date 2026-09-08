/**
 * STORY-009 — Knowledge Base Learning from Human-Solved Tickets.
 *
 * Mirrors STORY-008's classification-learning feature
 * (src/classificationCorrections.js, src/reviewSuggestedRule.js) for the
 * knowledge base: when a human manually solves a ticket that had a "no
 * match" or weak-confidence knowledgeBaseSearch() result, that solution is
 * worth keeping. proposeKnowledgeBaseArticle() records it as a proposal;
 * reviewKnowledgeBaseProposal() is the human-approval gate. Only approval
 * writes it into src/data/knowledgeBase.json, where knowledgeBaseSearch.js
 * picks it up automatically on the next search — no changes needed there.
 *
 * Deliberate shape difference from reviewSuggestedRule.js: this module's
 * review function takes a proposalId, not the full proposal object. That
 * means, unlike reviewClassification.js/reviewEscalation.js/
 * reviewSuggestedRule.js (all pure), reviewKnowledgeBaseProposal() is NOT
 * pure — its first step is looking up the proposal by id from the ticket
 * queue (reusing ticketQueue.js's listQueuedTickets(), not reimplementing
 * lookup), the same category of module as knowledgeBaseSearch.js: not pure,
 * does real I/O, still deterministic, still never throws. And because the
 * KB write happens inside this same function on approve (per this story's
 * spec — one file, two exports, no separate applyApproved... step), approve
 * can genuinely fail: if the write to knowledgeBase.json fails, the result
 * must not claim "approved" when nothing was actually written. A decided
 * proposal (approve or reject) is removed from the ticket queue afterward
 * (via ticketQueue.js's removeTicketFromQueue) — confirmed with the user,
 * matching the existing submitReviewDecision MCP tool's behavior rather
 * than STORY-008's reviewSuggestedRuleAndLog, which currently leaves
 * decided suggestions in place.
 *
 * The same person who proposed an article is allowed to approve it
 * themselves — a deliberate, already-agreed decision (this project has only
 * one reviewer role) — reviewKnowledgeBaseProposal() does not compare
 * decision.reviewer against the proposal's proposedBy.
 *
 * ID assignment (STORY-009): proposeKnowledgeBaseArticle() auto-assigns the
 * next KB-NNN id. Scanning only knowledgeBase.json is not enough — two
 * proposals made before either is approved would otherwise compute the same
 * next id from the same (unapproved) file — so the next id is computed from
 * the union of knowledgeBase.json's existing ids and any already-queued
 * suggested_kb_article proposals' ids. On approve, a defensive check also
 * refuses to add an id that already exists in knowledgeBase.json (a
 * corrupted/tampered queue entry, or a proposal approved twice), rather than
 * silently overwriting or duplicating an article.
 *
 * Known limitation, same class as STORY-008's: src/data/knowledgeBase.json
 * and the ticket queue are shared, read-modify-write state with no locking.
 * Concurrent proposals or concurrent decisions could still race in a true
 * simultaneous-write sense. Accepted for this repo's single-user-prototype
 * scope, same as documented for src/data/classificationCorrections.json.
 *
 * Failure paths handled (never throws — every branch returns a result object):
 *  - proposeKnowledgeBaseArticle: malformed proposal (missing/blank
 *    sourceTicketId or proposedBy, invalid category, empty/invalid tags or
 *    steps, missing/blank title) -> fails closed, ValidationError.
 *  - proposeKnowledgeBaseArticle: same sourceTicketId already has a pending
 *    proposal -> idempotent no-op (`proposed: false, duplicate: true`).
 *  - proposeKnowledgeBaseArticle: knowledgeBase.json missing or corrupt ->
 *    fails closed rather than guessing the next id.
 *  - proposeKnowledgeBaseArticle: queue write fails -> fails closed,
 *    surfaced via `queued: false`.
 *  - reviewKnowledgeBaseProposal: invalid proposalId, malformed decision,
 *    proposal not found in the queue, or a corrupt/malformed queued
 *    proposal -> fails closed, never throws.
 *  - reviewKnowledgeBaseProposal (approve): knowledgeBase.json corrupt, the
 *    id already exists, or the write fails -> fails closed; the result is
 *    NOT reported as approved unless the write actually succeeded.
 *
 * @typedef {Object} KnowledgeBaseArticleProposal
 * @property {string} sourceTicketId  The ticket a human manually solved. Also the idempotency key.
 * @property {string} proposedBy      Non-empty. Who wrote the proposal — required for the audit trail.
 * @property {import('./classify.js').Category} category
 * @property {string[]} tags
 * @property {string} title
 * @property {string[]} steps
 *
 * @typedef {Object} ProposeArticleResult
 * @property {boolean} ok
 * @property {boolean} proposed
 * @property {boolean} [duplicate]
 * @property {string} [proposalId]    Present when proposed is true — the auto-assigned KB-NNN id.
 * @property {string} [message]
 * @property {Object} logEntry
 *
 * @typedef {Object} KnowledgeBaseReviewDecision
 * @property {'approve'|'reject'} action
 * @property {string} reviewer
 * @property {string} [reason]
 *
 * @typedef {Object} KnowledgeBaseReviewResult
 * @property {boolean} ok
 * @property {'approved'|'rejected'|'error'} outcome
 * @property {string} [reason]
 * @property {Object} [article]       Present on approve — the article as written to knowledgeBase.json.
 * @property {string} [sourceTicketId] Present on approve — carried from the original proposal, for
 *                                       a caller (auditedActions.js) that wants to summarize the
 *                                       approval without a second, redundant queue lookup.
 * @property {string} [proposedBy]    Present on approve, same reasoning as sourceTicketId.
 * @property {Object} logEntry
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CATEGORIES } from './classify.js';
import { addTicketToQueue, listQueuedTickets, removeTicketFromQueue } from './ticketQueue.js';

/** Default location of the knowledge base data file (reused from knowledgeBaseSearch.js's convention). */
export const KNOWLEDGE_BASE_PATH = new URL('./data/knowledgeBase.json', import.meta.url);

const REVIEW_ACTIONS = ['approve', 'reject'];
const KB_ID_PATTERN = /^KB-(\d+)$/;

/**
 * @param {string|URL} path
 * @returns {string}
 */
function dirOf(path) {
  return dirname(path instanceof URL ? fileURLToPath(path) : path);
}

/**
 * @param {{ event: string, outcome: 'success'|'failure', context: Object, errorClass?: string }} fields
 * @returns {Object}
 */
function buildLogEntry({ event, outcome, context, errorClass }) {
  const entry = {
    timestamp: new Date().toISOString(),
    level: outcome === 'success' ? 'info' : 'warn',
    service: 'knowledgeBaseCorrections',
    event,
    outcome,
    context,
  };
  if (errorClass) entry.error_class = errorClass;
  return entry;
}

/**
 * @param {unknown} proposal
 * @returns {boolean}
 */
function isValidProposal(proposal) {
  return (
    proposal !== null &&
    typeof proposal === 'object' &&
    !Array.isArray(proposal) &&
    typeof proposal.sourceTicketId === 'string' &&
    proposal.sourceTicketId.trim() !== '' &&
    typeof proposal.proposedBy === 'string' &&
    proposal.proposedBy.trim() !== '' &&
    typeof proposal.category === 'string' &&
    CATEGORIES.includes(proposal.category) &&
    Array.isArray(proposal.tags) &&
    proposal.tags.length > 0 &&
    proposal.tags.every((t) => typeof t === 'string' && t.trim() !== '') &&
    typeof proposal.title === 'string' &&
    proposal.title.trim() !== '' &&
    Array.isArray(proposal.steps) &&
    proposal.steps.length > 0 &&
    proposal.steps.every((s) => typeof s === 'string' && s.trim() !== '')
  );
}

/**
 * @param {unknown} decision
 * @returns {boolean}
 */
function isValidDecision(decision) {
  return (
    decision !== null &&
    typeof decision === 'object' &&
    !Array.isArray(decision) &&
    REVIEW_ACTIONS.includes(decision.action) &&
    typeof decision.reviewer === 'string' &&
    decision.reviewer.trim() !== ''
  );
}

/**
 * Load and shape-check knowledgeBase.json. Distinguishes "articles array"
 * from "corrupt/missing" so callers never guess in the face of bad data.
 *
 * @param {string|URL} kbPath
 * @returns {{ ok: true, articles: Object[] } | { ok: false, message: string }}
 */
function loadKnowledgeBase(kbPath) {
  if (!existsSync(kbPath)) {
    return { ok: false, message: 'knowledge base file is missing.' };
  }
  try {
    const parsed = JSON.parse(readFileSync(kbPath, 'utf8'));
    if (!parsed || !Array.isArray(parsed.articles)) {
      return { ok: false, message: 'knowledge base file is missing an articles array.' };
    }
    return { ok: true, articles: parsed.articles };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `knowledge base file is not valid JSON: ${message}` };
  }
}

/**
 * @param {string[]} ids
 * @returns {string} the next KB-NNN id, zero-padded to match the existing pattern
 */
function nextArticleId(ids) {
  let maxN = 0;
  for (const id of ids) {
    const match = typeof id === 'string' ? KB_ID_PATTERN.exec(id) : null;
    if (match) maxN = Math.max(maxN, parseInt(match[1], 10));
  }
  return `KB-${String(maxN + 1).padStart(3, '0')}`;
}

/**
 * Propose a new knowledge base article from a human-solved ticket. Never
 * throws. Idempotent on sourceTicketId: proposing again for a ticket that
 * already has a pending proposal is a no-op, not a second proposal.
 *
 * @param {unknown} proposal
 * @param {{ kbPath?: string|URL, queueDir?: string }} [options]   Overrides for tests only.
 * @returns {ProposeArticleResult}
 */
export function proposeKnowledgeBaseArticle(proposal, options = {}) {
  if (!isValidProposal(proposal)) {
    return {
      ok: false,
      proposed: false,
      message: 'Proposal not recorded: invalid proposal shape.',
      logEntry: buildLogEntry({
        event: 'kb_article_proposal_rejected',
        outcome: 'failure',
        context: { proposal },
        errorClass: 'ValidationError',
      }),
    };
  }

  const kbPath = options.kbPath ?? KNOWLEDGE_BASE_PATH;
  const loaded = loadKnowledgeBase(kbPath);
  if (!loaded.ok) {
    return {
      ok: false,
      proposed: false,
      message: `Proposal not recorded: ${loaded.message}`,
      logEntry: buildLogEntry({
        event: 'kb_article_proposal_failed',
        outcome: 'failure',
        context: { sourceTicketId: proposal.sourceTicketId },
        errorClass: 'KnowledgeBaseCorruptError',
      }),
    };
  }

  const queued = listQueuedTickets({ queueDir: options.queueDir });
  const pendingProposals = queued.filter((t) => t.type === 'suggested_kb_article');

  const alreadyProposed = pendingProposals.find((p) => p.sourceTicketId === proposal.sourceTicketId);
  if (alreadyProposed) {
    return {
      ok: true,
      proposed: false,
      duplicate: true,
      proposalId: alreadyProposed.requestId,
      message: `Proposal not recorded: ticket ${proposal.sourceTicketId} already has a pending proposal (${alreadyProposed.requestId}).`,
      logEntry: buildLogEntry({
        event: 'kb_article_proposal_duplicate',
        outcome: 'success',
        context: { sourceTicketId: proposal.sourceTicketId, proposalId: alreadyProposed.requestId },
      }),
    };
  }

  const proposalId = nextArticleId([...loaded.articles.map((a) => a.id), ...pendingProposals.map((p) => p.requestId)]);
  const { sourceTicketId, proposedBy, category, tags, title, steps } = proposal;
  const queueEntry = {
    type: 'suggested_kb_article',
    requestId: proposalId,
    sourceTicketId,
    proposedBy,
    category,
    tags,
    title,
    steps,
    createdAt: new Date().toISOString(),
  };

  const queueResult = addTicketToQueue(queueEntry, { queueDir: options.queueDir });
  if (!queueResult.saved) {
    return {
      ok: false,
      proposed: false,
      message: `Proposal not recorded: ${queueResult.message}`,
      logEntry: buildLogEntry({
        event: 'kb_article_proposal_failed',
        outcome: 'failure',
        context: { sourceTicketId, proposalId },
        errorClass: 'QueueWriteFailedError',
      }),
    };
  }

  return {
    ok: true,
    proposed: true,
    proposalId,
    logEntry: buildLogEntry({
      event: 'kb_article_proposed',
      outcome: 'success',
      context: { sourceTicketId, proposedBy, proposalId, category, title },
    }),
  };
}

/**
 * @param {unknown} proposal   A queued item already filtered to type === 'suggested_kb_article'.
 * @returns {boolean}
 */
function isValidQueuedProposal(proposal) {
  return (
    proposal !== null &&
    typeof proposal === 'object' &&
    typeof proposal.requestId === 'string' &&
    proposal.requestId.trim() !== '' &&
    typeof proposal.category === 'string' &&
    CATEGORIES.includes(proposal.category) &&
    Array.isArray(proposal.tags) &&
    proposal.tags.length > 0 &&
    typeof proposal.title === 'string' &&
    proposal.title.trim() !== '' &&
    Array.isArray(proposal.steps) &&
    proposal.steps.length > 0
  );
}

/**
 * Review a knowledge base article proposal by id: approve it (writing a new,
 * real article into knowledgeBase.json), reject it (discarding it, no write
 * at all), or fail closed on malformed input. The same person who proposed
 * an article may approve it themselves — this project has one reviewer
 * role, by design. Either decision removes the proposal from the ticket
 * queue. Never throws.
 *
 * @param {unknown} proposalId
 * @param {unknown} decision
 * @param {{ kbPath?: string|URL, queueDir?: string }} [options]   Overrides for tests only.
 * @returns {KnowledgeBaseReviewResult}
 */
export function reviewKnowledgeBaseProposal(proposalId, decision, options = {}) {
  if (typeof proposalId !== 'string' || proposalId.trim() === '') {
    return buildErrorResult('invalid_proposal_id', proposalId, decision);
  }
  if (!isValidDecision(decision)) {
    return buildErrorResult('invalid_decision', proposalId, decision);
  }

  const queued = listQueuedTickets({ queueDir: options.queueDir });
  const proposal = queued.find((t) => t.type === 'suggested_kb_article' && t.requestId === proposalId);
  if (!proposal) {
    return buildErrorResult('proposal_not_found', proposalId, decision);
  }
  if (!isValidQueuedProposal(proposal)) {
    return buildErrorResult('corrupt_proposal', proposalId, decision);
  }

  if (decision.action === 'reject') {
    removeTicketFromQueue(proposalId, { queueDir: options.queueDir });
    return {
      ok: true,
      outcome: 'rejected',
      reason: decision.reason ?? null,
      logEntry: buildLogEntry({
        event: 'kb_proposal_rejected',
        outcome: 'success',
        context: { proposalId, action: 'reject', reviewer: decision.reviewer, reason: decision.reason ?? null },
      }),
    };
  }

  // action === 'approve'
  const kbPath = options.kbPath ?? KNOWLEDGE_BASE_PATH;
  const loaded = loadKnowledgeBase(kbPath);
  if (!loaded.ok) {
    return {
      ok: false,
      outcome: 'error',
      reason: 'kb_write_failed',
      message: `Proposal not applied: ${loaded.message}`,
      logEntry: buildLogEntry({
        event: 'kb_proposal_apply_failed',
        outcome: 'failure',
        context: { proposalId, action: 'approve', reviewer: decision.reviewer },
        errorClass: 'KnowledgeBaseCorruptError',
      }),
    };
  }
  if (loaded.articles.some((a) => a.id === proposalId)) {
    return {
      ok: false,
      outcome: 'error',
      reason: 'article_id_already_exists',
      message: `Proposal not applied: an article with id ${proposalId} already exists.`,
      logEntry: buildLogEntry({
        event: 'kb_proposal_apply_failed',
        outcome: 'failure',
        context: { proposalId, action: 'approve', reviewer: decision.reviewer },
        errorClass: 'ArticleIdConflictError',
      }),
    };
  }

  const article = {
    id: proposalId,
    category: proposal.category,
    tags: proposal.tags,
    title: proposal.title,
    steps: proposal.steps,
    source: 'human_approved_correction',
  };
  const nextArticles = [...loaded.articles, article];

  try {
    const dir = dirOf(kbPath);
    if (dir && dir !== '.' && !existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(kbPath, JSON.stringify({ articles: nextArticles }, null, 2), { encoding: 'utf8' });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const errorClass = error.code === 'EACCES' || error.code === 'EPERM' ? 'KnowledgeBaseAccessDeniedError' : 'KnowledgeBaseWriteFailedError';
    process.stderr.write(`ALERT: knowledge base write failed: ${message}\n`);
    return {
      ok: false,
      outcome: 'error',
      reason: 'kb_write_failed',
      message: `Proposal not applied: ${message}`,
      logEntry: buildLogEntry({ event: 'kb_proposal_apply_failed', outcome: 'failure', context: { proposalId, action: 'approve', reviewer: decision.reviewer }, errorClass }),
    };
  }

  removeTicketFromQueue(proposalId, { queueDir: options.queueDir });

  return {
    ok: true,
    outcome: 'approved',
    article,
    sourceTicketId: proposal.sourceTicketId,
    proposedBy: proposal.proposedBy,
    logEntry: buildLogEntry({
      event: 'kb_proposal_approved',
      outcome: 'success',
      context: { proposalId, action: 'approve', reviewer: decision.reviewer, category: article.category, title: article.title },
    }),
  };
}

const REVIEW_ERROR_CLASSES = {
  invalid_proposal_id: 'ValidationError',
  invalid_decision: 'ValidationError',
  proposal_not_found: 'NotFoundError',
  corrupt_proposal: 'CorruptProposalError',
};

/**
 * @param {'invalid_proposal_id'|'invalid_decision'|'proposal_not_found'|'corrupt_proposal'} reason
 * @param {unknown} proposalId
 * @param {unknown} decision
 * @returns {KnowledgeBaseReviewResult}
 */
function buildErrorResult(reason, proposalId, decision) {
  return {
    ok: false,
    outcome: 'error',
    reason,
    logEntry: buildLogEntry({
      event: 'kb_proposal_review_failed',
      outcome: 'failure',
      context: {
        proposalId: typeof proposalId === 'string' ? proposalId : undefined,
        action: decision && typeof decision === 'object' ? decision.action : undefined,
        reviewer: decision && typeof decision === 'object' ? decision.reviewer : undefined,
      },
      errorClass: REVIEW_ERROR_CLASSES[reason] ?? 'ValidationError',
    }),
  };
}
