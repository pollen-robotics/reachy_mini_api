// Tests for the MCP tool catalog helpers.
//
// Focus: the pure pieces the route relies on -
//   1. Deterministic Gradio MCP endpoint resolution from a Space slug
//      (the one field clients actually consume).
//   2. Space -> catalog mapping (official/blocked flags, advisory mcp tag).
//   3. Name dedup policy (official > oldest > most likes).
//   4. The HF fetch path: tag filter, sort order, list/error handling
//      (network stubbed via an injected fetch).
//
// Run: `npm test` (uses node --test, no extra deps).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MCP_TOOL_TAG,
  buildSpaceMcpUrl,
  mapSpaceToMcpTool,
  dedupToolsByName,
  fetchMcpToolsFromHF,
} from '../server/mcpTools.js';

// ── buildSpaceMcpUrl ────────────────────────────────────────────────

test('buildSpaceMcpUrl matches the HF default subdomain rule', () => {
  // Underscores and the slash collapse to single dashes, lowercased -
  // same value HF assigns (cf. pollen-robotics-reachy-mini-central).
  assert.equal(
    buildSpaceMcpUrl('pollen-robotics/reachy_mini_central'),
    'https://pollen-robotics-reachy-mini-central.hf.space/gradio_api/mcp/',
  );
  assert.equal(
    buildSpaceMcpUrl('Tfrere/My.Cool_Tool'),
    'https://tfrere-my-cool-tool.hf.space/gradio_api/mcp/',
  );
});

test('buildSpaceMcpUrl is null-safe', () => {
  assert.equal(buildSpaceMcpUrl(''), 'https://.hf.space/gradio_api/mcp/');
  assert.equal(buildSpaceMcpUrl(undefined), 'https://.hf.space/gradio_api/mcp/');
});

// ── mapSpaceToMcpTool ───────────────────────────────────────────────

test('mapSpaceToMcpTool builds the catalog shape with mcpUrl + flags', () => {
  const officialSet = new Set(['owner/official-tool']);
  const blockedSet = new Set(['owner/bad-tool']);

  const tool = mapSpaceToMcpTool(
    {
      id: 'owner/official-tool',
      tags: ['reachy-mini-tool', 'mcp'],
      likes: 12,
      cardData: { short_description: 'does things', sdk: 'gradio' },
      siblings: [{ rfilename: 'public/icon.svg' }],
    },
    { officialSet, blockedSet },
  );

  assert.equal(tool.id, 'owner/official-tool');
  assert.equal(tool.name, 'official-tool');
  assert.equal(tool.source_kind, 'hf_space');
  assert.equal(
    tool.mcpUrl,
    'https://owner-official-tool.hf.space/gradio_api/mcp/',
  );
  assert.equal(tool.isOfficial, true);
  assert.equal(tool.isBlocked, false);
  assert.equal(tool.extra.hasMcpTag, true);
  assert.equal(tool.extra.likes, 12);
  assert.equal(
    tool.iconUrl,
    'https://huggingface.co/spaces/owner/official-tool/resolve/main/public/icon.svg',
  );
});

test('mapSpaceToMcpTool flags blocked + missing mcp tag', () => {
  const tool = mapSpaceToMcpTool(
    { id: 'owner/bad-tool', tags: ['reachy-mini-tool'] },
    { officialSet: new Set(), blockedSet: new Set(['owner/bad-tool']) },
  );
  assert.equal(tool.isBlocked, true);
  assert.equal(tool.extra.hasMcpTag, false);
  assert.equal(tool.iconUrl, null);
});

// ── dedupToolsByName ────────────────────────────────────────────────

test('dedupToolsByName: official wins over a more-liked fork', () => {
  const deduped = dedupToolsByName([
    { name: 'lamp', isOfficial: false, extra: { likes: 99, createdAt: '2024-01-01' } },
    { name: 'lamp', isOfficial: true, extra: { likes: 1, createdAt: '2025-01-01' } },
  ]);
  assert.equal(deduped.length, 1);
  assert.equal(deduped[0].isOfficial, true);
});

test('dedupToolsByName: among non-official, oldest wins then likes', () => {
  const deduped = dedupToolsByName([
    { name: 'lamp', isOfficial: false, extra: { likes: 1, createdAt: '2025-01-01' } },
    { name: 'lamp', isOfficial: false, extra: { likes: 5, createdAt: '2024-01-01' } },
  ]);
  assert.equal(deduped.length, 1);
  assert.equal(deduped[0].extra.createdAt, '2024-01-01');
});

// ── fetchMcpToolsFromHF (network stubbed) ───────────────────────────

function stubFetch(routes) {
  return async (url) => {
    for (const [needle, response] of routes) {
      if (url.includes(needle)) return response;
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
}

test('fetchMcpToolsFromHF filters on the tool tag and sorts official-first', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return stubFetch([
      ['official-app-list', { ok: true, json: async () => ['owner/official'] }],
      ['blocked-app-list', { ok: true, json: async () => [] }],
      [
        '/api/spaces',
        {
          ok: true,
          json: async () => [
            { id: 'owner/popular', tags: ['reachy-mini-tool'], likes: 50 },
            { id: 'owner/official', tags: ['reachy-mini-tool'], likes: 2 },
          ],
        },
      ],
    ])(url);
  };

  const tools = await fetchMcpToolsFromHF({
    hfSpacesApi: 'https://huggingface.co/api/spaces',
    limit: 1000,
    officialListUrl: 'https://example/config/official-app-list.json',
    blockListUrl: 'https://example/config/blocked-app-list.json',
    fetchImpl,
  });

  // Tag filter is part of the spaces URL.
  assert.ok(calls.some((u) => u.includes(`filter=${encodeURIComponent(MCP_TOOL_TAG)}`)));
  // Official is sorted first even though it has fewer likes.
  assert.equal(tools[0].id, 'owner/official');
  assert.equal(tools[0].isOfficial, true);
  assert.equal(tools[1].id, 'owner/popular');
});

test('fetchMcpToolsFromHF throws when the spaces listing fails', async () => {
  const fetchImpl = stubFetch([
    ['official-app-list', { ok: true, json: async () => [] }],
    ['blocked-app-list', { ok: true, json: async () => [] }],
    ['/api/spaces', { ok: false, status: 503 }],
  ]);

  await assert.rejects(
    fetchMcpToolsFromHF({
      hfSpacesApi: 'https://huggingface.co/api/spaces',
      limit: 10,
      officialListUrl: 'https://example/config/official-app-list.json',
      blockListUrl: 'https://example/config/blocked-app-list.json',
      fetchImpl,
    }),
    /HF API returned 503/,
  );
});
