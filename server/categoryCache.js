/**
 * Persistent cache for inferred app categories, backed by a
 * HuggingFace dataset.
 *
 * Why a dataset (not a local file)
 * ────────────────────────────────
 * The website runs in a Docker HF Space. The container's
 * filesystem is wiped on every rebuild (and rebuilds happen
 * on every push, every model update, every Space restart).
 * Re-running 200 LLM calls every cold start would be wasteful
 * and slow the user-visible /api/js-apps for the first 30 s.
 *
 * Pushing the cache to a dataset gives us:
 *   1. Persistence across rebuilds and machine moves
 *   2. A versioned audit log of how categories evolve
 *   3. A single source of truth other tooling can consume
 *      (the mobile shell could even read the dataset directly
 *      if it ever wanted to bypass the website).
 *
 * Storage shape
 * ─────────────
 *   <dataset>/categories.json
 *
 *   {
 *     "version": 1,
 *     "taxonomyVersion": 1,
 *     "updatedAt": "2026-05-10T11:08:42Z",
 *     "entries": {
 *       "<spaceId>": {
 *         "lastModified": "2026-05-08T22:13:01Z",
 *         "categories": ["storytelling", "kids", "voice"],
 *         "categorizedAt": "2026-05-10T11:08:42Z",
 *         "taxonomyVersion": 1
 *       }
 *     }
 *   }
 *
 * In-memory tier
 * ──────────────
 * The Map<spaceId, entry> is the hot path. The dataset is
 * loaded once at boot and only flushed when entries actually
 * change (the warmup batch buffers writes and flushes once
 * at the end). All synchronous access goes through the Map.
 */

import { commit, createRepo } from '@huggingface/hub';

import { TAXONOMY_VERSION } from './categories.js';

// Single store control-plane dataset (shared with app-list.json,
// block-list.json and moderation.json - see index.js `STORE_DATASET`).
// The HF_TOKEN must have WRITE access here since this cache commits
// `categories.json`. Precedence: a dedicated `HF_CATEGORIES_DATASET`
// wins (escape hatch), else the unified `STORE_DATASET`, else the
// pollen-robotics default.
const DEFAULT_DATASET = 'pollen-robotics/reachy-mini-official-app-store';

const CACHE_FILE_PATH = 'categories.json';
const CACHE_FORMAT_VERSION = 1;

class CategoryCache {
  constructor() {
    this.entries = new Map();
    this.repoName =
      process.env.HF_CATEGORIES_DATASET ||
      process.env.STORE_DATASET ||
      DEFAULT_DATASET;
    this.loaded = false;
    this.dirty = false;
    // Concurrency guard for `flush()` - we never want two
    // commit() calls fighting for the same parent commit.
    this.flushing = false;
  }

  /**
   * Load the dataset cache into memory. Best-effort: a missing
   * dataset, a 404, or a malformed JSON all collapse to "start
   * fresh, the warmup will repopulate". We never let cache load
   * failure block the server boot.
   */
  async load() {
    if (this.loaded) return;
    this.loaded = true;

    const url = `https://huggingface.co/datasets/${this.repoName}/resolve/main/${CACHE_FILE_PATH}`;
    try {
      const res = await fetch(url, {
        // Send the token even on a public dataset: it lets HF
        // bump our rate limit and keeps the path identical for
        // a future private dataset migration.
        headers: process.env.HF_TOKEN
          ? { Authorization: `Bearer ${process.env.HF_TOKEN}` }
          : undefined,
      });
      if (!res.ok) {
        if (res.status === 404) {
          console.log(
            `[CategoryCache] Dataset ${this.repoName} or ${CACHE_FILE_PATH} ` +
              `not found yet - starting empty.`,
          );
        } else {
          console.warn(
            `[CategoryCache] HTTP ${res.status} loading cache from ` +
              `${this.repoName}, starting empty.`,
          );
        }
        return;
      }
      const data = await res.json();
      const entries = data?.entries || {};
      let kept = 0;
      let staleTaxonomy = 0;
      for (const [id, raw] of Object.entries(entries)) {
        if (!raw || typeof raw !== 'object') continue;
        // Drop entries from a previous taxonomy: their slugs
        // may no longer exist or may have shifted meaning.
        // The warmup will re-run them.
        if (raw.taxonomyVersion !== TAXONOMY_VERSION) {
          staleTaxonomy++;
          continue;
        }
        this.entries.set(id, {
          lastModified: raw.lastModified || null,
          categories: Array.isArray(raw.categories) ? raw.categories : [],
          categorizedAt: raw.categorizedAt || null,
          taxonomyVersion: raw.taxonomyVersion,
        });
        kept++;
      }
      console.log(
        `[CategoryCache] Loaded ${kept} entries from ${this.repoName}` +
          (staleTaxonomy ? ` (dropped ${staleTaxonomy} stale taxonomy)` : ''),
      );
    } catch (err) {
      console.warn(
        `[CategoryCache] Load failed (${err.message}); starting empty.`,
      );
    }
  }

  get(spaceId) {
    return this.entries.get(spaceId) || null;
  }

  /**
   * Decide whether `spaceId` needs a fresh classification call.
   * It does when:
   *   - we have no entry at all, OR
   *   - the Space's `lastModified` has moved past our cached one
   *     (the README may have changed - re-classify), OR
   *   - the taxonomy version moved (handled at load() time, but
   *     belt-and-braces for hot reloads).
   */
  needsCategorization(spaceId, lastModified) {
    const entry = this.entries.get(spaceId);
    if (!entry) return true;
    if (entry.taxonomyVersion !== TAXONOMY_VERSION) return true;
    if (lastModified && entry.lastModified !== lastModified) return true;
    return false;
  }

  set(spaceId, { categories, lastModified }) {
    if (!Array.isArray(categories)) return;
    const next = {
      lastModified: lastModified || null,
      categories: [...categories],
      categorizedAt: new Date().toISOString(),
      taxonomyVersion: TAXONOMY_VERSION,
    };
    const prev = this.entries.get(spaceId);
    // Skip the dirty flag if nothing actually changed - avoids
    // a useless commit when a refresh confirms the same labels.
    if (
      prev &&
      prev.lastModified === next.lastModified &&
      prev.taxonomyVersion === next.taxonomyVersion &&
      JSON.stringify(prev.categories) === JSON.stringify(next.categories)
    ) {
      return;
    }
    this.entries.set(spaceId, next);
    this.dirty = true;
  }

  /**
   * Persist the in-memory cache to the dataset (one commit, one
   * file). No-op if nothing has changed since the last flush.
   *
   * Auto-creates the dataset on first write if it doesn't exist
   * yet (so a brand-new `HF_CATEGORIES_DATASET` value bootstraps
   * cleanly without manual setup).
   */
  async flush() {
    if (!this.dirty || this.flushing) return;
    if (!process.env.HF_TOKEN) {
      console.warn('[CategoryCache] HF_TOKEN missing; skipping flush.');
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

      // First attempt: plain commit. If the dataset doesn't
      // exist yet, the SDK throws and we fall through to
      // create-then-commit. We never assume the dataset exists
      // - that lets a fresh deploy auto-bootstrap.
      try {
        await commit({
          repo,
          credentials,
          title: `Update categories (${this.entries.size} apps)`,
          operations: [
            {
              operation: 'addOrUpdate',
              path: CACHE_FILE_PATH,
              content: blob,
            },
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
          `[CategoryCache] Dataset ${this.repoName} missing - creating it.`,
        );
        await createRepo({
          repo,
          credentials,
          private: false,
          // Re-using the same blob so the initial commit ships
          // the cache content (instead of an empty repo
          // followed by a no-op commit).
          files: [
            {
              path: CACHE_FILE_PATH,
              content: await blob.arrayBuffer(),
            },
          ],
        });
      }

      this.dirty = false;
      console.log(
        `[CategoryCache] Flushed ${this.entries.size} entries to ${this.repoName}`,
      );
    } catch (err) {
      // We deliberately swallow flush errors so a HF outage
      // doesn't break the running server. The next set() will
      // re-flag dirty=true and the next flush() will retry.
      console.error(
        `[CategoryCache] Flush failed: ${err?.message || err}`,
      );
    } finally {
      this.flushing = false;
    }
  }

  serialize() {
    const entries = {};
    for (const [id, entry] of this.entries) {
      entries[id] = entry;
    }
    return {
      version: CACHE_FORMAT_VERSION,
      taxonomyVersion: TAXONOMY_VERSION,
      updatedAt: new Date().toISOString(),
      entries,
    };
  }

  /**
   * Diagnostic snapshot for /api/js-apps's `categorization`
   * sub-payload. Lets the mobile shell decide whether to show
   * "loading categories..." or to render the chips immediately.
   */
  stats() {
    return {
      total: this.entries.size,
      dataset: this.repoName,
      taxonomyVersion: TAXONOMY_VERSION,
    };
  }
}

// Singleton: there's only one cache per server process.
export const categoryCache = new CategoryCache();
