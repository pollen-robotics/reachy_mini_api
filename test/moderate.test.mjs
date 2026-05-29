// Tests for the regex prescreen (moderation layer 1 - the synchronous
// hard-block killswitch that runs before any LLM call).
//
// Focus: it must BLOCK unambiguous abuse in any field (name /
// description / readme) and must NOT over-block ordinary apps. The
// LLM (layer 2) handles nuance; layer 1 stays narrow on purpose.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  regexPrescreen,
  MODERATION_POLICY_VERSION,
  POLICY_CATEGORIES,
} from '../server/moderate.js';

test('policy constants are well-formed', () => {
  assert.equal(typeof MODERATION_POLICY_VERSION, 'number');
  assert.ok(POLICY_CATEGORIES.includes('none'));
  for (const c of ['sexual', 'hate', 'illegal', 'self_harm']) {
    assert.ok(POLICY_CATEGORIES.includes(c), `missing hard category ${c}`);
  }
});

test('clean app passes the prescreen (null = fall through to LLM)', () => {
  assert.equal(
    regexPrescreen({
      name: 'Reachy Dance Party',
      description: 'Reachy dances to your favourite songs',
      readme: 'A fun music app for the whole family.',
    }),
    null,
  );
});

test('explicit sexual term hard-blocks', () => {
  const v = regexPrescreen({ name: 'PornHub Viewer', description: '', readme: '' });
  assert.equal(v.decision, 'block');
  assert.equal(v.category, 'sexual');
  assert.equal(v.severity, 'hard');
  assert.equal(v.source, 'regex');
  assert.equal(v.policyVersion, MODERATION_POLICY_VERSION);
});

test('scam pattern hard-blocks as scam_malware', () => {
  const v = regexPrescreen({ name: 'Free Robux Generator', description: '', readme: '' });
  assert.equal(v.decision, 'block');
  assert.equal(v.category, 'scam_malware');
});

test('CSAM signal (minor token + explicit token) hard-blocks as illegal', () => {
  const v = regexPrescreen({ name: '', description: 'child nude gallery', readme: '' });
  assert.equal(v.decision, 'block');
  assert.equal(v.category, 'illegal');
});

test('graphic violence term hard-blocks', () => {
  const v = regexPrescreen({ name: '', description: 'lots of gore and beheading', readme: '' });
  assert.equal(v.decision, 'block');
  assert.equal(v.category, 'violence');
});

test('the prescreen scans the README field too', () => {
  const v = regexPrescreen({ name: 'Innocent Name', description: 'ok', readme: 'follow me on onlyfans' });
  assert.equal(v.decision, 'block');
  assert.equal(v.category, 'sexual');
});

test('ambiguous game words are NOT blocked (no false positive)', () => {
  // "kill" / "shoot" are deliberately absent from the hard list -
  // they are everyday game vocabulary and belong to the LLM's nuance.
  assert.equal(
    regexPrescreen({
      name: 'Zombie Shooter',
      description: 'Shoot and kill waves of zombies to win',
      readme: 'An arcade shooting game.',
    }),
    null,
  );
});

test('a kids app is NOT blocked by the minor-token pattern alone', () => {
  // The CSAM pattern requires an explicit sexual token nearby; a plain
  // kids app must pass.
  assert.equal(
    regexPrescreen({
      name: 'Bedtime Stories for Kids',
      description: 'Gentle tales to help children fall asleep',
      readme: 'For curious young minds.',
    }),
    null,
  );
});
