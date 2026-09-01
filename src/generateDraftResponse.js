/**
 * STORY-005 — Generate Draft Response for Agent Review (REQ-004).
 *
 * Takes a classified request (classify.js, STORY-001) and a knowledge-base
 * search result (knowledgeBaseSearch.js, STORY-004) — both reused, not
 * rebuilt — and assembles a professional draft response from
 * src/data/responseTemplates.json. Per CLAUDE.md's core principle ("LLMs
 * are probabilistic. Production systems must be deterministic."), this is
 * template assembly, not a model call — the same approach classify.js and
 * knowledgeBaseSearch.js already use.
 *
 * responseTemplates.json has an entry for each of the 6 specific-issue
 * categories classify.js recognizes; general_support_request intentionally
 * has none and falls through to the mandatory `default` template — the
 * same catch-all convention knowledgeBaseSearch.js's KB file already
 * established for that category.
 *
 * This module only drafts and recommends. It never sends anything, so it
 * does not touch guardrail.js (R4 governs restricted *actions* like
 * send_message; producing editable draft text for a human to review and
 * send is not one of RESTRICTED_ACTIONS). The returned draft is always
 * plain, unlocked data (`editable: true`, `draftText` a plain string) —
 * nothing here marks it sent, approved, or final.
 *
 * Like knowledgeBaseSearch.js, this module is NOT pure (it reads a file)
 * but has no side effects and is deterministic for a fixed template file.
 * It only builds a logEntry — persistence is the caller-side wrapper in
 * auditedActions.js (STORY-003 pattern).
 *
 * Failure paths handled (never throws — every branch returns a result object):
 *  - Malformed/unrecognized classification -> fails closed, ValidationError ("Response not generated").
 *  - Template file missing -> TemplateUnavailableError ("Template missing").
 *  - Template file unreadable (permissions) -> TemplateAccessDeniedError ("Template missing").
 *  - Template read exceeds the explicit timeout -> TemplateTimeoutError ("Template missing").
 *  - Template file present but not valid JSON / missing shape -> TemplateCorruptError ("Template missing").
 *  - Neither the category template nor the `default` fallback exists -> TemplateMissingError ("Template missing").
 *  - Assembled draft still contains an unresolved `{{...}}` placeholder or
 *    is empty after rendering -> ResponseRenderError ("Response contains errors").
 *
 * @typedef {Object} DraftResponseResult
 * @property {boolean} generated
 * @property {boolean} editable        Always true — the draft is plain, mutable text for a human to edit.
 * @property {string} draftText        '' when generated is false.
 * @property {string} [category]
 * @property {string} [templateUsed]   Which template key was applied ('default' on fallback).
 * @property {'high'|'medium'|'low'|'none'} [kbConfidence]
 * @property {string} [message]        Present when generated is false.
 * @property {Object} logEntry         Structured, stdout-log-shaped record (Observability Framework
 *                                       shape). Not persisted here — persistence is auditedActions.js.
 */

import { readFile } from 'node:fs/promises';
import { CATEGORIES } from './classify.js';

/** Default location of the response template data file. */
export const RESPONSE_TEMPLATES_PATH = new URL('./data/responseTemplates.json', import.meta.url);

/** Every external read gets an explicit timeout — never unbounded (CLAUDE.md Failure-First Design). */
const DEFAULT_TIMEOUT_MS = 5000;

/**
 * @param {{ category: string|undefined, templateUsed?: string, kbConfidence?: string,
 *   outcome: 'success'|'failure', draftLength: number, errorClass?: string }} fields
 * @returns {Object}
 */
function buildLogEntry({ category, templateUsed, kbConfidence, outcome, draftLength, errorClass }) {
  const entry = {
    timestamp: new Date().toISOString(),
    level: outcome === 'success' ? 'info' : 'warn',
    service: 'generateDraftResponse',
    event: 'draft_response_generated',
    outcome,
    context: { category, templateUsed, kbConfidence, draftLength },
  };
  if (errorClass) entry.error_class = errorClass;
  return entry;
}

/**
 * @param {{ category: string|undefined, templateUsed?: string, kbConfidence?: string,
 *   message: string, errorClass: string }} fields
 * @returns {DraftResponseResult}
 */
function notGenerated({ category, templateUsed, kbConfidence, message, errorClass }) {
  return {
    generated: false,
    editable: true,
    draftText: '',
    message,
    logEntry: buildLogEntry({ category, templateUsed, kbConfidence, outcome: 'failure', draftLength: 0, errorClass }),
  };
}

/**
 * Race a promise against an explicit timeout. Rejects with a tagged error on
 * timeout instead of leaving the caller hanging indefinitely.
 * @param {Promise<any>} promise
 * @param {number} timeoutMs
 */
function withTimeout(promise, timeoutMs) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(Object.assign(new Error('response template read timed out'), { errorClass: 'TemplateTimeoutError' }));
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Load and parse the response template file. Throws a tagged error (with an
 * `errorClass` property) on any failure — the caller always catches this.
 * @param {string|URL} templatesPath
 * @param {number} timeoutMs
 * @param {(path: string|URL, encoding: string) => Promise<string>} readFileImpl
 *   Defaults to node:fs/promises readFile. Overridable only so tests can
 *   deterministically simulate a slow or permission-denied read.
 * @param {(event: { phase: 'started'|'finished', file: string, outcome?: 'success'|'failure',
 *   durationMs?: number, errorClass?: string }) => (void|Promise<void>)} [onDiskRead]
 *   Optional observability hook fired exactly at this disk-read boundary (not
 *   on validation failures upstream, which never reach here). Real callers
 *   are mcp-server.js, wiring this to a structured log notification; tests
 *   may pass a spy. Never affects the read itself.
 */
async function loadTemplates(templatesPath, timeoutMs, readFileImpl = readFile, onDiskRead) {
  const file = 'responseTemplates.json';
  const startedAt = Date.now();
  await onDiskRead?.({ phase: 'started', file });

  let raw;
  try {
    raw = await withTimeout(readFileImpl(templatesPath, 'utf8'), timeoutMs);
  } catch (error) {
    let tagged = error;
    if (!error.errorClass) {
      if (error.code === 'EACCES' || error.code === 'EPERM') {
        tagged = Object.assign(new Error('response template access denied'), { errorClass: 'TemplateAccessDeniedError' });
      } else if (error.code === 'ENOENT') {
        tagged = Object.assign(new Error('response template file not found'), { errorClass: 'TemplateUnavailableError' });
      } else {
        tagged = Object.assign(new Error(`response template read failed: ${error.message}`), {
          errorClass: 'TemplateUnavailableError',
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
    const tagged = Object.assign(new Error('response template file is not valid JSON'), { errorClass: 'TemplateCorruptError' });
    await onDiskRead?.({ phase: 'finished', file, outcome: 'failure', durationMs: Date.now() - startedAt, errorClass: tagged.errorClass });
    throw tagged;
  }

  if (
    !parsed ||
    typeof parsed.greeting !== 'string' ||
    typeof parsed.signOff !== 'string' ||
    !parsed.templates ||
    typeof parsed.templates !== 'object' ||
    !parsed.stepsSection ||
    typeof parsed.stepsSection !== 'object'
  ) {
    const tagged = Object.assign(new Error('response template file is missing required shape'), {
      errorClass: 'TemplateCorruptError',
    });
    await onDiskRead?.({ phase: 'finished', file, outcome: 'failure', durationMs: Date.now() - startedAt, errorClass: tagged.errorClass });
    throw tagged;
  }

  await onDiskRead?.({ phase: 'finished', file, outcome: 'success', durationMs: Date.now() - startedAt });
  return parsed;
}

/**
 * @param {{ foundHeading: string, lowConfidenceCaveat: string, notFound: string }} stepsSection
 * @param {unknown} kbSearchResult
 * @returns {string}
 */
function buildStepsSection(stepsSection, kbSearchResult) {
  const hasResults =
    kbSearchResult &&
    typeof kbSearchResult === 'object' &&
    kbSearchResult.found === true &&
    Array.isArray(kbSearchResult.results) &&
    kbSearchResult.results.length > 0;

  if (!hasResults) return stepsSection.notFound;

  const top = kbSearchResult.results[0];
  const heading = stepsSection.foundHeading.replace('{{articleTitle}}', top.title ?? '');
  const steps = (Array.isArray(top.steps) ? top.steps : []).map((step, i) => `${i + 1}. ${step}`).join('\n');
  const caveat = top.confidence === 'low' ? `\n\n${stepsSection.lowConfidenceCaveat}` : '';

  return `${heading}\n${steps}${caveat}`;
}

/**
 * Generate a professional draft response for a support agent to review and
 * edit before sending. Never throws — every branch returns a result object.
 * Never marks anything sent, approved, or final; nothing here bypasses R4.
 *
 * @param {unknown} classification   Output of classify.js's classifySupportRequest
 *   (must have at least a recognized `category`; `summary` is optional).
 * @param {unknown} kbSearchResult   Output of knowledgeBaseSearch.js's searchKnowledgeBase
 *   (optional — treated as "not found" if missing or malformed).
 * @param {{ templatesPath?: string|URL, timeoutMs?: number, readFile?: Function, onDiskRead?: Function }} [options]
 *   `readFile` is an override for tests only. `onDiskRead` is the disk-read
 *   observability hook (see loadTemplates) — real callers are mcp-server.js.
 * @returns {Promise<DraftResponseResult>}
 */
export async function generateDraftResponse(classification, kbSearchResult, options = {}) {
  const templatesPath = options.templatesPath ?? RESPONSE_TEMPLATES_PATH;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const hasValidCategory =
    classification !== null &&
    typeof classification === 'object' &&
    !Array.isArray(classification) &&
    typeof classification.category === 'string' &&
    CATEGORIES.includes(classification.category);

  if (!hasValidCategory) {
    return notGenerated({
      category: classification && typeof classification === 'object' ? classification.category : undefined,
      message: 'Cannot generate a draft response: the classification is missing or has an unrecognized category.',
      errorClass: 'ValidationError',
    });
  }

  const { category } = classification;
  const summary = typeof classification.summary === 'string' ? classification.summary.trim() : '';
  const kbConfidence =
    kbSearchResult && typeof kbSearchResult === 'object' && typeof kbSearchResult.confidence === 'string'
      ? kbSearchResult.confidence
      : 'none';

  let templateData;
  try {
    templateData = await loadTemplates(templatesPath, timeoutMs, options.readFile, options.onDiskRead);
  } catch (error) {
    return notGenerated({
      category,
      kbConfidence,
      message: `Draft response generation failed: ${error.message}`,
      errorClass: error.errorClass,
    });
  }

  const templateUsed = templateData.templates[category] ? category : 'default';
  const template = templateData.templates[templateUsed];

  if (!template || typeof template.openingLine !== 'string' || typeof template.closingLine !== 'string') {
    return notGenerated({
      category,
      kbConfidence,
      message: 'Draft response generation failed: no usable template exists for this category and no default template exists.',
      errorClass: 'TemplateMissingError',
    });
  }

  const summarySentence = summary ? ` Specifically: "${summary}"` : '';
  const stepsSection = buildStepsSection(templateData.stepsSection, kbSearchResult);

  const draftText = [
    templateData.greeting,
    '',
    `${template.openingLine}${summarySentence}`,
    '',
    stepsSection,
    '',
    template.closingLine,
    '',
    templateData.signOff,
  ].join('\n');

  if (draftText.includes('{{') || draftText.trim() === '') {
    return notGenerated({
      category,
      templateUsed,
      kbConfidence,
      message: 'Draft response generation failed: the rendered response contains an unresolved template placeholder or is empty.',
      errorClass: 'ResponseRenderError',
    });
  }

  return {
    generated: true,
    editable: true,
    draftText,
    category,
    templateUsed,
    kbConfidence,
    logEntry: buildLogEntry({ category, templateUsed, kbConfidence, outcome: 'success', draftLength: draftText.length }),
  };
}
