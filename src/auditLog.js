/**
 * STORY-003 — Audit Trail Logging.
 *
 * The single sanctioned write path for the audit trail (REQ-010: "the system
 * must keep an audit trail of AI recommendations and human approvals or
 * rejections"). Callers (classify.js, reviewClassification.js, and future
 * stories) already build a structured logEntry — this module is the only
 * place that persists one.
 *
 * Design (per project decision):
 *  - Append-only: entries are written with the 'a' flag and existing lines
 *    are never read back for the purpose of modifying them. One JSON record
 *    per line (JSON Lines).
 *  - Hash-chained: every record carries prevHash (the previous record's
 *    hash, or a fixed genesis value for the first record) and its own hash
 *    computed over prevHash + the entry content + its sequence number.
 *    Editing or deleting any past line breaks the chain for every record
 *    after it, so tampering is detectable by recomputing the chain.
 *  - Fail-loud: if the write fails for any reason (disk full, permission
 *    denied, unreadable/corrupt prior chain, bad input), this never throws
 *    and never silently drops the entry — it prints an "ALERT:" line to
 *    stderr (no external alerting system exists yet) and returns a
 *    fail-closed result so the caller knows persistence did not happen.
 *
 * @typedef {Object} AuditAppendResult
 * @property {boolean} ok
 * @property {Object} [record]   Present when ok === true: { seq, prevHash, hash, entry }.
 * @property {string} [error]    Present when ok === false: a stable error_class-style code.
 * @property {string} [message]  Present when ok === false: human-readable detail (no secrets).
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';

/** Default location of the audit trail. JSON Lines, one immutable record per line. */
export const AUDIT_LOG_PATH = 'audit/audit-trail.log';

/** Hash used as prevHash for the very first record in the chain. */
export const GENESIS_HASH = '0'.repeat(64);

/**
 * @param {string} text
 * @returns {string} hex-encoded SHA-256 digest
 */
function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Reads the tail of the chain (last record's hash + seq) from an existing
 * log file. An absent file is a fresh, empty chain, not a failure.
 *
 * @param {string} logPath
 * @returns {{ hash: string, seq: number }}
 */
function readChainTail(logPath) {
  if (!existsSync(logPath)) {
    return { hash: GENESIS_HASH, seq: 0 };
  }

  const raw = readFileSync(logPath, 'utf8');
  const lines = raw.split('\n').filter((line) => line.trim() !== '');
  if (lines.length === 0) {
    return { hash: GENESIS_HASH, seq: 0 };
  }

  const lastRecord = JSON.parse(lines[lines.length - 1]); // throws on corrupt tail — caller fails closed
  return { hash: lastRecord.hash, seq: lastRecord.seq };
}

/**
 * Append one structured log entry to the audit trail as a new, hash-chained,
 * immutable record. Never throws.
 *
 * @param {unknown} logEntry   A structured log entry (e.g. from classify.js
 *   or reviewClassification.js). Must be a non-null object.
 * @param {{ logPath?: string }} [options]   Override the log file path (tests only).
 * @returns {AuditAppendResult}
 */
export function appendAuditEntry(logEntry, options = {}) {
  const logPath = options.logPath ?? AUDIT_LOG_PATH;

  try {
    if (logEntry === null || typeof logEntry !== 'object' || Array.isArray(logEntry)) {
      throw new Error('logEntry must be a non-null, non-array object');
    }

    const dir = dirname(logPath);
    if (dir && dir !== '.' && !existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const { hash: prevHash, seq: prevSeq } = readChainTail(logPath);
    const seq = prevSeq + 1;
    const hash = sha256(prevHash + JSON.stringify(logEntry) + seq);
    const record = { seq, prevHash, hash, entry: logEntry };

    appendFileSync(logPath, `${JSON.stringify(record)}\n`, { encoding: 'utf8', flag: 'a' });

    return { ok: true, record };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`ALERT: audit log write failed: ${message}\n`);
    return { ok: false, error: 'audit_log_write_failed', message };
  }
}
