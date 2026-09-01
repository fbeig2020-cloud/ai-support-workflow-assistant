/**
 * STORY-004 — Search Knowledge Base for Troubleshooting Steps (REQ-003, REQ-009).
 *
 * Takes a classified request (the output of classify.js's classifySupportRequest)
 * and searches the small on-disk knowledge base (src/data/knowledgeBase.json) for
 * relevant approved troubleshooting instructions. This module only searches and
 * recommends — it never sends, resolves, or modifies anything, so it does not
 * touch guardrail.js (R4 governs restricted *actions*; read-only retrieval isn't
 * one of RESTRICTED_ACTIONS).
 *
 * Unlike classify.js/reviewClassification.js, this module is NOT pure — it reads
 * a file from disk. It has no side effects (no writes) and is still deterministic
 * for a fixed knowledge-base file, but every call does I/O and can fail the ways
 * I/O fails. This module only builds a logEntry, same as classify.js/
 * reviewClassification.js — it does not persist to the audit trail itself;
 * persistence is the caller-side wrapper in auditedActions.js.
 *
 * Failure paths handled (never throws — every branch returns a result object):
 *  - Malformed/unrecognized classification -> fails closed, ValidationError.
 *  - Knowledge base file missing -> KnowledgeBaseUnavailableError.
 *  - Knowledge base file unreadable (permissions) -> KnowledgeBaseAccessDeniedError.
 *  - Read exceeds the explicit timeout -> KnowledgeBaseTimeoutError.
 *  - Knowledge base file present but not valid JSON / missing shape -> KnowledgeBaseCorruptError.
 *  - No article scores above the relevance threshold -> found:false, indicates uncertainty.
 *  - A weak (low-confidence) match is still returned, but flagged with a caveat
 *    rather than presented as a confident answer -- guards against "incorrect
 *    search results" being trusted at face value.
 *
 * @typedef {Object} KnowledgeBaseArticle
 * @property {string} id
 * @property {string} category
 * @property {string[]} tags
 * @property {string} title
 * @property {string[]} steps
 *
 * @typedef {Object} SearchResultArticle
 * @property {string} id
 * @property {string} title
 * @property {string} category
 * @property {string[]} steps
 * @property {number} score
 * @property {'high'|'medium'|'low'} confidence
 *
 * @typedef {Object} KnowledgeBaseSearchResult
 * @property {boolean} found
 * @property {'high'|'medium'|'low'|'none'} confidence
 * @property {SearchResultArticle[]} results
 * @property {string} [message]     Present when found is false, or as a low-confidence caveat.
 * @property {Object} logEntry      Structured, stdout-log-shaped record of this search
 *                                   (Observability Framework shape). Not persisted here —
 *                                   persistence is auditedActions.js (STORY-003 pattern).
 */

import { readFile } from 'node:fs/promises';
import { CATEGORIES } from './classify.js';

/** Default location of the knowledge base data file. */
export const KNOWLEDGE_BASE_PATH = new URL('./data/knowledgeBase.json', import.meta.url);

/** Every external read gets an explicit timeout — never unbounded (CLAUDE.md Failure-First Design). */
const DEFAULT_TIMEOUT_MS = 5000;

/** Cap how many articles come back — a "small knowledge base" answer, not a data dump. */
const MAX_RESULTS = 3;

/** An article must score at least this high to be considered relevant at all. */
const MIN_RELEVANCE_SCORE = 1;

/** Weight given to an exact category match between the classification and an article. */
const CATEGORY_MATCH_SCORE = 3;

/**
 * @param {{ category: string|undefined, matchedSignals: string[], outcome: 'success'|'failure',
 *   confidence: 'high'|'medium'|'low'|'none', resultIds: string[], errorClass?: string }} fields
 * @returns {Object}
 */
function buildLogEntry({ category, matchedSignals, outcome, confidence, resultIds, errorClass }) {
  const entry = {
    timestamp: new Date().toISOString(),
    level: outcome === 'success' ? 'info' : 'warn',
    service: 'knowledgeBaseSearch',
    event: 'knowledge_base_searched',
    outcome,
    context: { query: { category, matchedSignals }, resultCount: resultIds.length, resultIds, confidence },
  };
  if (errorClass) entry.error_class = errorClass;
  return entry;
}

/**
 * @param {{ category: string|undefined, matchedSignals: string[], outcome: 'success'|'failure',
 *   confidence: 'none', message: string, errorClass?: string }} fields
 * @returns {KnowledgeBaseSearchResult}
 */
function uncertainResult({ category, matchedSignals, outcome, message, errorClass }) {
  return {
    found: false,
    confidence: 'none',
    results: [],
    message,
    logEntry: buildLogEntry({ category, matchedSignals, outcome, confidence: 'none', resultIds: [], errorClass }),
  };
}

/**
 * Race a promise against an explicit timeout. Rejects with a tagged error on timeout
 * instead of leaving the caller hanging indefinitely.
 * @param {Promise<any>} promise
 * @param {number} timeoutMs
 */
function withTimeout(promise, timeoutMs) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(Object.assign(new Error('knowledge base read timed out'), { errorClass: 'KnowledgeBaseTimeoutError' }));
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Load and parse the knowledge base file. Throws a tagged error (with an
 * `errorClass` property) on any failure — the caller always catches this.
 * @param {string|URL} kbPath
 * @param {number} timeoutMs
 * @param {(path: string|URL, encoding: string) => Promise<string>} readFileImpl
 *   Defaults to node:fs/promises readFile. Overridable only so tests can
 *   deterministically simulate a slow or permission-denied read without
 *   depending on real disk timing or OS-specific file permissions.
 * @param {(event: { phase: 'started'|'finished', file: string, outcome?: 'success'|'failure',
 *   durationMs?: number, errorClass?: string }) => (void|Promise<void>)} [onDiskRead]
 *   Optional observability hook fired exactly at this disk-read boundary (not
 *   on validation failures upstream, which never reach here). Real callers
 *   are mcp-server.js, wiring this to a structured log notification; tests
 *   may pass a spy. Never affects the read itself.
 * @returns {Promise<KnowledgeBaseArticle[]>}
 */
async function loadKnowledgeBase(kbPath, timeoutMs, readFileImpl = readFile, onDiskRead) {
  const file = 'knowledgeBase.json';
  const startedAt = Date.now();
  await onDiskRead?.({ phase: 'started', file });

  let raw;
  try {
    raw = await withTimeout(readFileImpl(kbPath, 'utf8'), timeoutMs);
  } catch (error) {
    let tagged = error;
    if (!error.errorClass) {
      if (error.code === 'EACCES' || error.code === 'EPERM') {
        tagged = Object.assign(new Error('knowledge base access denied'), { errorClass: 'KnowledgeBaseAccessDeniedError' });
      } else if (error.code === 'ENOENT') {
        tagged = Object.assign(new Error('knowledge base file not found'), { errorClass: 'KnowledgeBaseUnavailableError' });
      } else {
        tagged = Object.assign(new Error(`knowledge base read failed: ${error.message}`), {
          errorClass: 'KnowledgeBaseUnavailableError',
        });
      }
    }
    await onDiskRead?.({ phase: 'finished', file, outcome: 'failure', durationMs: Date.now() - startedAt, errorClass: tagged.errorClass });
    throw tagged;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const tagged = Object.assign(new Error('knowledge base file is not valid JSON'), { errorClass: 'KnowledgeBaseCorruptError' });
    await onDiskRead?.({ phase: 'finished', file, outcome: 'failure', durationMs: Date.now() - startedAt, errorClass: tagged.errorClass });
    throw tagged;
  }

  if (!parsed || !Array.isArray(parsed.articles)) {
    const tagged = Object.assign(new Error('knowledge base file is missing an articles array'), {
      errorClass: 'KnowledgeBaseCorruptError',
    });
    await onDiskRead?.({ phase: 'finished', file, outcome: 'failure', durationMs: Date.now() - startedAt, errorClass: tagged.errorClass });
    throw tagged;
  }

  await onDiskRead?.({ phase: 'finished', file, outcome: 'success', durationMs: Date.now() - startedAt });
  return parsed.articles;
}

/**
 * @param {KnowledgeBaseArticle} article
 * @param {string} category
 * @param {Set<string>} signalSet   Lowercased matchedSignals from the classification.
 * @returns {number}
 */
function scoreArticle(article, category, signalSet) {
  let score = 0;
  if (article.category === category) score += CATEGORY_MATCH_SCORE;
  const tags = Array.isArray(article.tags) ? article.tags : [];
  for (const tag of tags) {
    if (signalSet.has(String(tag).toLowerCase())) score += 1;
  }
  return score;
}

/**
 * @param {number} score
 * @returns {'high'|'medium'|'low'}
 */
function confidenceForScore(score) {
  if (score >= CATEGORY_MATCH_SCORE + 1) return 'high';
  if (score >= 2) return 'medium';
  return 'low';
}

/**
 * Search the knowledge base for troubleshooting steps relevant to a classified
 * support request. Never throws.
 *
 * @param {unknown} classification   Output of classify.js's classifySupportRequest
 *   (must have at least a recognized `category`; `matchedSignals` is optional).
 * @param {{ kbPath?: string|URL, timeoutMs?: number, readFile?: Function, onDiskRead?: Function }} [options]
 *   `readFile` is an override for tests only. `onDiskRead` is the disk-read
 *   observability hook (see loadKnowledgeBase) — real callers are mcp-server.js.
 * @returns {Promise<KnowledgeBaseSearchResult>}
 */
export async function searchKnowledgeBase(classification, options = {}) {
  const kbPath = options.kbPath ?? KNOWLEDGE_BASE_PATH;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const hasValidCategory =
    classification !== null &&
    typeof classification === 'object' &&
    !Array.isArray(classification) &&
    typeof classification.category === 'string' &&
    CATEGORIES.includes(classification.category);

  if (!hasValidCategory) {
    return uncertainResult({
      category: classification && typeof classification === 'object' ? classification.category : undefined,
      matchedSignals: [],
      outcome: 'failure',
      message: 'Cannot search the knowledge base: the classification is missing or has an unrecognized category.',
      errorClass: 'ValidationError',
    });
  }

  const { category } = classification;
  const matchedSignals = Array.isArray(classification.matchedSignals) ? classification.matchedSignals : [];
  const signalSet = new Set(matchedSignals.map((s) => String(s).toLowerCase()));

  let articles;
  try {
    articles = await loadKnowledgeBase(kbPath, timeoutMs, options.readFile, options.onDiskRead);
  } catch (error) {
    return uncertainResult({
      category,
      matchedSignals,
      outcome: 'failure',
      message: `Knowledge base search failed: ${error.message}`,
      errorClass: error.errorClass,
    });
  }

  const scored = articles
    .map((article) => ({ article, score: scoreArticle(article, category, signalSet) }))
    .filter(({ score }) => score >= MIN_RELEVANCE_SCORE)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_RESULTS);

  if (scored.length === 0) {
    return uncertainResult({
      category,
      matchedSignals,
      outcome: 'success',
      message: 'No relevant troubleshooting steps were found in the knowledge base for this request.',
    });
  }

  const confidence = confidenceForScore(scored[0].score);
  const results = scored.map(({ article, score }) => ({
    id: article.id,
    title: article.title,
    category: article.category,
    steps: article.steps,
    score,
    confidence: confidenceForScore(score),
  }));

  const result = {
    found: true,
    confidence,
    results,
    logEntry: buildLogEntry({
      category,
      matchedSignals,
      outcome: 'success',
      confidence,
      resultIds: results.map((r) => r.id),
    }),
  };

  if (confidence === 'low') {
    result.message = 'Low-confidence match — recommend human review before relying on these steps.';
  }

  return result;
}
