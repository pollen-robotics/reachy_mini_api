// Tests for the catalog visibility policy (decideVisibility).
//
// This is the load-bearing App Store guideline 1.2 logic: the catalog
// is FAIL-CLOSED, so only an explicit `allow` verdict (or a curated
// official app) may surface. Everything else - block, review, manual
// block-list, or no verdict yet - must stay hidden. These tests pin
// that contract so a future refactor can't silently re-open the gate.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { decideVisibility } from '../server/visibility.js';

test('an explicit allow verdict is visible', () => {
  const r = decideVisibility(
    { isBlocked: false, isOfficial: false },
    { decision: 'allow', category: 'none', reason: 'llm: allow/none', source: 'llm' },
  );
  assert.equal(r.visible, true);
  assert.equal(r.decision, 'allow');
  assert.equal(r.source, 'llm');
});

test('a block verdict is hidden', () => {
  const r = decideVisibility(
    { isBlocked: false, isOfficial: false },
    { decision: 'block', category: 'sexual', reason: 'llm: block/sexual', source: 'llm' },
  );
  assert.equal(r.visible, false);
  assert.equal(r.decision, 'block');
});

test('a review verdict is hidden (quarantined, not exposed)', () => {
  const r = decideVisibility(
    { isBlocked: false, isOfficial: false },
    { decision: 'review', category: 'violence', reason: 'llm: review/violence', source: 'llm' },
  );
  assert.equal(r.visible, false);
  assert.equal(r.decision, 'review');
});

test('no verdict yet (pending) is hidden - fail-closed', () => {
  const r = decideVisibility({ isBlocked: false, isOfficial: false }, null);
  assert.equal(r.visible, false);
  assert.equal(r.source, 'pending');
  assert.equal(r.decision, 'review');
  assert.match(r.reason, /fail-closed/);
});

test('undefined verdict behaves the same as null (fail-closed)', () => {
  const r = decideVisibility({ isBlocked: false, isOfficial: false }, undefined);
  assert.equal(r.visible, false);
  assert.equal(r.source, 'pending');
});

test('manual block-list wins even over an allow verdict', () => {
  const r = decideVisibility(
    { isBlocked: true, isOfficial: false },
    { decision: 'allow', category: 'none', reason: 'llm: allow/none', source: 'llm' },
  );
  assert.equal(r.visible, false);
  assert.equal(r.source, 'blocklist');
  assert.equal(r.decision, 'block');
});

test('an official app is visible even with no verdict (moderation skipped)', () => {
  const r = decideVisibility({ isBlocked: false, isOfficial: true }, null);
  assert.equal(r.visible, true);
  assert.equal(r.source, 'official');
  assert.equal(r.decision, 'allow');
});

test('block-list overrides official (killswitch is the top precedence)', () => {
  const r = decideVisibility({ isBlocked: true, isOfficial: true }, null);
  assert.equal(r.visible, false);
  assert.equal(r.source, 'blocklist');
});

test('an unknown / malformed decision is treated as not-allow (hidden)', () => {
  const r = decideVisibility(
    { isBlocked: false, isOfficial: false },
    { decision: 'definitely-not-a-real-decision', source: 'llm' },
  );
  assert.equal(r.visible, false);
});

test('verdict without a category is normalised to null', () => {
  const r = decideVisibility(
    { isBlocked: false, isOfficial: false },
    { decision: 'allow', reason: 'llm: allow', source: 'llm' },
  );
  assert.equal(r.visible, true);
  assert.equal(r.category, null);
});
