/**
 * Persistent cache for app moderation verdicts, backed by a
 * HuggingFace dataset. Twin of `categoryCache.js` - same rationale
 * (the Docker Space filesystem is wiped on every rebuild, so we
 * persist to a dataset to avoid re-running the whole LLM sweep on
 * each cold start), same in-memory-hot / dataset-cold tiering.
 *
 * Storage shape
 * ─────────────
 *   <dataset>/cache/moderation.json
 *
 *   {
 *     "version": 1,
 *     "policyVersion": 1,
 *     "updatedAt": "2026-05-29T09:00:00Z",
 *     "entries": {
 *       "<spaceId>": {
 *         "lastModified": "2026-05-08T22:13:01Z",
 *         "decision": "allow" | "block" | "review",
 *         "category": "none",
 *         "reason": "llm: allow/none",
 *         "severity": null | "hard" | "soft",
 *         "source": "regex" | "llm",
 *         "moderatedAt": "2026-05-29T09:00:00Z",
 *         "policyVersion": 1
 *       }
 *     }
 *   }
 *
 * `entries` holds the automated verdicts (regex + LLM), re-computed
 * when a Space's README changes or the policy version bumps. The
 * MANUAL killswitch lives elsewhere: a hand-edited
 * `config/block-list.json` on the official dataset (see `index.js`),
 * so anyone with dataset write access can block an app without
 * touching this cache.
 */

import { commit, createRepo } from '@huggingface/hub';

import { MODERATION_POLICY_VERSION } from './moderate.js';

// Single store control-plane dataset (shared with app-list.json,
// block-list.json and categories.json - see index.js `STORE_DATASET`).
// The HF_TOKEN must have WRITE access here since this cache commits
// `moderation.json`. Precedence: a dedicated `HF_MODERATION_DATASET`
// wins (escape hatch), else the unified `STORE_DATASET`, else the
// pollen-robotics default.
const DEFAULT_DATASET = 'pollen-robotics/reachy_mini_store_data';

const CACHE_FILE_PATH = 'cache/moderation.json';
const CACHE_FORMAT_VERSION = 1;

class ModerationCache {
  constructor() {
    this.entries = new Map();
    this.repoName =
      process.env.HF_MODERATION_DATASET ||
      process.env.STORE_DATASET ||
      DEFAULT_DATASET;
    this.loaded = false;
    this.dirty = false;
    this.flushing = false;
  }

  /**
   * Load the dataset cache into memory. Best-effort: a missing
   * dataset / 404 / malformed JSON collapses to "start empty, the
   * warmup repopulates". Never blocks server boot.
   */
  async load() {
    if (this.loaded) return;
    this.loaded = true;

    const url = `https://huggingface.co/datasets/${this.repoName}/resolve/main/${CACHE_FILE_PATH}`;
    try {
      const res = await fetch(url, {
        headers: process.env.HF_TOKEN
          ? { Authorization: `Bearer ${process.env.HF_TOKEN}` }
          : undefined,
      });
      if (!res.ok) {
        if (res.status === 404) {
          console.log(
            `[ModerationCache] Dataset ${this.repoName} or ${CACHE_FILE_PATH} not found yet - starting empty.`,
          );
        } else {
          console.warn(
            `[ModerationCache] HTTP ${res.status} loading cache from ${this.repoName}, starting empty.`,
          );
        }
        return;
      }
      const data = await res.json();

      // Verdicts: drop entries from an older policy version (the
      // prompt/regex moved, so they must be re-moderated).
      const entries = data?.entries || {};
      let kept = 0;
      let stale = 0;
      for (const [id, raw] of Object.entries(entries)) {
        if (!raw || typeof raw !== 'object') continue;
        if (raw.policyVersion !== MODERATION_POLICY_VERSION) {
          stale++;
          continue;
        }
        this.entries.set(id, {
          lastModified: raw.lastModified || null,
          decision: raw.decision,
          category: raw.category || 'none',
          reason: raw.reason || '',
          severity: raw.severity ?? null,
          source: raw.source || 'llm',
          moderatedAt: raw.moderatedAt || null,
          policyVersion: raw.policyVersion,
        });
        kept++;
      }

      console.log(
        `[ModerationCache] Loaded ${kept} verdicts from ${this.repoName}` +
          (stale ? ` (dropped ${stale} stale policy)` : ''),
      );
    } catch (err) {
      console.warn(
        `[ModerationCache] Load failed (${err.message}); starting empty.`,
      );
    }
  }

  get(spaceId) {
    return this.entries.get(spaceId) || null;
  }

  /**
   * Does `spaceId` need a fresh moderation call? Yes when we have no
   * verdict, the policy version moved, or the Space's `lastModified`
   * advanced past our cached one (the README may have changed).
   */
  needsModeration(spaceId, lastModified) {
    const entry = this.entries.get(spaceId);
    if (!entry) return true;
    if (entry.policyVersion !== MODERATION_POLICY_VERSION) return true;
    if (lastModified && entry.lastModified !== lastModified) return true;
    return false;
  }

  set(spaceId, { decision, category, reason, severity, source, lastModified }) {
    if (!decision) return;
    const next = {
      lastModified: lastModified || null,
      decision,
      category: category || 'none',
      reason: reason || '',
      severity: severity ?? null,
      source: source || 'llm',
      moderatedAt: new Date().toISOString(),
      policyVersion: MODERATION_POLICY_VERSION,
    };
    const prev = this.entries.get(spaceId);
    if (
      prev &&
      prev.lastModified === next.lastModified &&
      prev.policyVersion === next.policyVersion &&
      prev.decision === next.decision &&
      prev.category === next.category
    ) {
      return; // no material change - skip the dirty flag / commit
    }
    this.entries.set(spaceId, next);
    this.dirty = true;
  }

  /**
   * Persist the in-memory cache to the dataset (one commit, one
   * file). No-op when nothing changed. Auto-creates the dataset on
   * first write so a fresh `HF_MODERATION_DATASET` bootstraps cleanly.
   */
  async flush() {
    if (!this.dirty || this.flushing) return;
    if (!process.env.HF_TOKEN) {
      console.warn('[ModerationCache] HF_TOKEN missing; skipping flush.');
      return;
    }
    this.flushing = true;
    try {
      const payload = this.serialize();
      const blob = new Blob([JSON.stringify(payload, null, 2)], {
        type: 'application/json',
      });

      const repo = { type: 'dataset', name: this.repoName };
      const credentials = { accessToken: process.env.HF_TOKEN };

      try {
        await commit({
          repo,
          credentials,
          title: `Update moderation (${this.entries.size} verdicts)`,
          operations: [
            { operation: 'addOrUpdate', path: CACHE_FILE_PATH, content: blob },
          ],
        });
      } catch (err) {
        const msg = err?.message || '';
        const looksMissing =
          msg.includes('404') ||
          msg.toLowerCase().includes('not found') ||
          msg.toLowerCase().includes('does not exist');
        if (!looksMissing) throw err;
        console.log(
          `[ModerationCache] Dataset ${this.repoName} missing - creating it.`,
        );
        await createRepo({
          repo,
          credentials,
          private: false,
          files: [{ path: CACHE_FILE_PATH, content: await blob.arrayBuffer() }],
        });
      }

      this.dirty = false;
      console.log(
        `[ModerationCache] Flushed ${this.entries.size} verdicts to ${this.repoName}`,
      );
    } catch (err) {
      console.error(`[ModerationCache] Flush failed: ${err?.message || err}`);
    } finally {
      this.flushing = false;
    }
  }

  serialize() {
    const entries = {};
    for (const [id, entry] of this.entries) entries[id] = entry;
    return {
      version: CACHE_FORMAT_VERSION,
      policyVersion: MODERATION_POLICY_VERSION,
      updatedAt: new Date().toISOString(),
      entries,
    };
  }

  /**
   * Diagnostic snapshot for the `/api/js-apps` `moderation`
   * sub-payload. Counts are over the verdict cache only.
   */
  stats() {
    let blocked = 0;
    let review = 0;
    for (const entry of this.entries.values()) {
      if (entry.decision === 'block') blocked++;
      else if (entry.decision === 'review') review++;
    }
    return {
      total: this.entries.size,
      blocked,
      review,
      dataset: this.repoName,
      policyVersion: MODERATION_POLICY_VERSION,
    };
  }
}

// Singleton: one cache per server process.
export const moderationCache = new ModerationCache();
