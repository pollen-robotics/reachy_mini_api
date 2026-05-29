// Tests for the data-driven category taxonomy.
//
// Focus: the safety contract we rely on in production -
//   1. The taxonomy NEVER breaks: a missing/malformed dataset file
//      always falls back to the built-in default.
//   2. The slug list is CLOSED: LLM output is sanitized down to the
//      active taxonomy (no hallucinated categories reach the catalog).
//
// Run: `npm test` (uses node --test, no extra deps).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  TAXONOMY_VERSION,
  sanitizeSlugs,
  isValidSlug,
  getPublicTaxonomy,
  getFullTaxonomy,
  loadTaxonomyFromDataset,
} from '../server/categories.js';

// Snapshot of the built-in default, captured before any load() mutates
// the module state. Used to restore the default at the end.
const DEFAULT_FULL = getFullTaxonomy();

// Swap globalThis.fetch for the duration of `fn`, then restore it.
async function withFetch(stub, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

const ok = (body) => async () => ({ ok: true, status: 200, json: async () => body });
const notFound = () => async () => ({ ok: false, status: 404 });

// ── Built-in default ────────────────────────────────────────────────

test('default taxonomy is the 9-slug v4 list with descriptions', () => {
  assert.equal(DEFAULT_FULL.version, 4);
  assert.equal(DEFAULT_FULL.categories.length, 9);
  for (const c of DEFAULT_FULL.categories) {
    assert.ok(c.slug && typeof c.slug === 'string');
    assert.ok(c.description && c.description.length > 0, `${c.slug} needs a description`);
  }
});

test('getPublicTaxonomy strips descriptions and exposes a stable order', () => {
  const pub = getPublicTaxonomy();
  assert.deepEqual(
    pub.map((c) => c.slug),
    ['music', 'motion', 'voice', 'storytelling', 'kids', 'games', 'vision', 'companion', 'dev-tools'],
  );
  pub.forEach((c, i) => assert.equal(c.order, i));
  assert.equal(pub[0].description, undefined);
});

// ── sanitizeSlugs (closed-list enforcement) ─────────────────────────

test('sanitizeSlugs keeps only slugs in the active taxonomy', () => {
  assert.deepEqual(sanitizeSlugs(['music', 'bogus', 'voice']), ['music', 'voice']);
});

test('sanitizeSlugs trims + lowercases', () => {
  assert.deepEqual(sanitizeSlugs([' Music ', 'VOICE']), ['music', 'voice']);
});

test('sanitizeSlugs dedupes (order-preserving) and caps to 3 by default', () => {
  assert.deepEqual(
    sanitizeSlugs(['music', 'music', 'voice', 'games', 'kids']),
    ['music', 'voice', 'games'],
  );
});

test('sanitizeSlugs honours an explicit max (single-label mode)', () => {
  assert.deepEqual(sanitizeSlugs(['music', 'voice'], 1), ['music']);
});

test('sanitizeSlugs returns [] on garbage input', () => {
  assert.deepEqual(sanitizeSlugs(null), []);
  assert.deepEqual(sanitizeSlugs('music'), []);
  assert.deepEqual(sanitizeSlugs([42, {}, null]), []);
});

test('isValidSlug reflects the active taxonomy', () => {
  assert.equal(isValidSlug('music'), true);
  assert.equal(isValidSlug('not-a-real-slug'), false);
});

// ── loadTaxonomyFromDataset (fallback safety) ───────────────────────

test('loadTaxonomyFromDataset: 404 keeps the built-in default', async () => {
  await withFetch(notFound(), async () => {
    const applied = await loadTaxonomyFromDataset('owner/missing', null);
    assert.equal(applied, false);
  });
  assert.equal(TAXONOMY_VERSION, 4);
  assert.equal(getPublicTaxonomy().length, 9);
  assert.equal(isValidSlug('music'), true);
});

test('loadTaxonomyFromDataset: malformed payload keeps the default', async () => {
  await withFetch(ok({ nope: true }), async () => {
    assert.equal(await loadTaxonomyFromDataset('owner/ds', null), false);
  });
  assert.equal(TAXONOMY_VERSION, 4);
  assert.equal(getPublicTaxonomy().length, 9);
});

test('loadTaxonomyFromDataset: empty category list keeps the default', async () => {
  await withFetch(ok({ version: 7, categories: [] }), async () => {
    assert.equal(await loadTaxonomyFromDataset('owner/ds', null), false);
  });
  assert.equal(TAXONOMY_VERSION, 4);
});

test('loadTaxonomyFromDataset: a valid file swaps the taxonomy in', async () => {
  await withFetch(
    ok({
      version: 9,
      categories: [
        { slug: 'Alpha', label: 'Alpha', emoji: 'A', description: 'first' },
        { slug: 'beta', label: 'Beta', emoji: 'B', description: 'second' },
        { slug: 'alpha', label: 'dup', emoji: 'X', description: 'dropped dup' },
      ],
    }),
    async () => {
      assert.equal(await loadTaxonomyFromDataset('owner/ds', 'tok'), true);
    },
  );
  // Live binding picks up the new version.
  assert.equal(TAXONOMY_VERSION, 9);
  // Slugs lowercased + deduped, order preserved.
  assert.deepEqual(getPublicTaxonomy().map((c) => c.slug), ['alpha', 'beta']);
  // The closed list moved: old slugs are now invalid, new ones valid.
  assert.equal(isValidSlug('alpha'), true);
  assert.equal(isValidSlug('music'), false);
  assert.deepEqual(sanitizeSlugs(['alpha', 'music', 'beta'], 3), ['alpha', 'beta']);

  // Restore the built-in default so we don't leak state to other files.
  await withFetch(ok(DEFAULT_FULL), async () => {
    assert.equal(await loadTaxonomyFromDataset('owner/ds', null), true);
  });
  assert.equal(TAXONOMY_VERSION, 4);
  assert.equal(isValidSlug('music'), true);
});
