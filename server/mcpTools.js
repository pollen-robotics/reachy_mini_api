// =====================================================================
// MCP tool-space catalog
// =====================================================================
//
// Mirror of the JS-app catalog (`/api/js-apps`) but for MCP tool
// sources: public Hugging Face Spaces that expose the standard Gradio
// MCP endpoint and opt into discovery with the `reachy-mini-tool` tag.
//
// The convention (tags + endpoint) is the one introduced server-side
// in the conversation app's MCP integration:
//   - tag `reachy-mini-tool` : reachy-specific curation signal (what we
//     filter on here).
//   - tag `mcp`              : advisory "this Space speaks MCP" hint
//     (surfaced as `extra.hasMcpTag`, never required).
//   - endpoint `https://<subdomain>.hf.space/gradio_api/mcp/` : where a
//     Gradio Space publishes its MCP server.
//
// Tags are advisory only: a Space carrying the tag still has to expose a
// working MCP endpoint for a client to use it. This module does NOT probe
// the endpoint (that would mean one live MCP handshake per Space on every
// catalog refresh); it resolves the deterministic endpoint URL and lets
// the client discover/validate tools at install time, exactly like the
// conversation app does.
//
// Pure helpers (URL building, mapping, dedup) are exported for unit tests;
// the cache + Express route live in `index.js` alongside the app catalog.

// Tag that gates the MCP tool subset. Hyphenated to match the documented
// discovery convention (distinct from the underscore app tags like
// `reachy_mini_js_app`).
export const MCP_TOOL_TAG = 'reachy-mini-tool';

// Advisory "speaks MCP" tag. Surfaced but never used to filter.
export const MCP_SPEAKS_TAG = 'mcp';

// Same icon convention as the app catalog: an author commits
// `public/icon.svg` (preferred) or `public/icon.png` in the Space repo.
const ICON_CANDIDATES = ['public/icon.svg', 'public/icon.png'];

/**
 * Resolve the conventional app icon at indexing time from the `siblings`
 * file list returned by `?full=true`. Returns the absolute HF resolve URL
 * when found, `null` otherwise. Kept local (rather than imported from
 * `index.js`) so this module stays free of the server entry point and can
 * be imported by tests without booting Express.
 */
export function findIconUrl(spaceId, siblings) {
  if (!spaceId || !Array.isArray(siblings)) return null;
  const files = new Set();
  for (const s of siblings) {
    const name = s && typeof s.rfilename === 'string' ? s.rfilename : null;
    if (name) files.add(name);
  }
  for (const candidate of ICON_CANDIDATES) {
    if (files.has(candidate)) {
      return `https://huggingface.co/spaces/${spaceId}/resolve/main/${candidate}`;
    }
  }
  return null;
}

/**
 * Build the deterministic Gradio MCP endpoint for a public Space.
 *
 * HF derives a Space's default subdomain from its `owner/name` slug by
 * lowercasing and collapsing every run of non-alphanumeric characters to
 * a single dash (so `pollen-robotics/reachy_mini_central` becomes
 * `pollen-robotics-reachy-mini-central`). We reproduce that rule rather
 * than depend on an optional `host`/`subdomain` field that the spaces
 * listing API does not always return. This matches the fallback used by
 * the conversation app's `_build_public_space_mcp_url`.
 */
export function buildSpaceMcpUrl(spaceId) {
  const subdomain = String(spaceId || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `https://${subdomain}.hf.space/gradio_api/mcp/`;
}

/**
 * Map one raw HF Space record (from `?full=true`) into the catalog shape
 * the clients consume. Mirrors the app mapping in `index.js` and adds the
 * MCP-specific `mcpUrl` field plus an advisory `hasMcpTag` flag.
 */
export function mapSpaceToMcpTool(space, { officialSet, blockedSet } = {}) {
  const spaceId = (space && space.id) || '';
  const tags = (space && space.tags) || [];
  const author = spaceId.split('/')[0];
  const name = spaceId.split('/').pop();
  const idLower = spaceId.toLowerCase();

  return {
    id: spaceId,
    name,
    description: space?.cardData?.short_description || '',
    url: `https://huggingface.co/spaces/${spaceId}`,
    // The single field clients actually need to wire up an MCP transport.
    mcpUrl: buildSpaceMcpUrl(spaceId),
    source_kind: 'hf_space',
    isOfficial: officialSet ? officialSet.has(idLower) : false,
    isBlocked: blockedSet ? blockedSet.has(idLower) : false,
    iconUrl: findIconUrl(spaceId, space?.siblings),

    extra: {
      id: spaceId,
      author,
      likes: space?.likes || 0,
      downloads: space?.downloads || 0,
      createdAt: space?.createdAt || null,
      lastModified: space?.lastModified || null,
      runtime: space?.runtime || null,
      sdk: space?.cardData?.sdk || space?.sdk || null,
      tags,
      // Advisory: did the author also add the generic `mcp` tag? Purely
      // informational - discovery never depends on it.
      hasMcpTag: Array.isArray(tags) && tags.includes(MCP_SPEAKS_TAG),
      cardData: {
        emoji: space?.cardData?.emoji || '🛠️',
        short_description: space?.cardData?.short_description || '',
        sdk: space?.cardData?.sdk || null,
        tags: space?.cardData?.tags || [],
        ...space?.cardData,
      },
    },
  };
}

/**
 * Pick a winner among tool Spaces sharing the same repo name. Same policy
 * as the app catalog: official first, then oldest (likely the original),
 * then most likes as a tiebreaker. Forks of a popular tool keep the
 * upstream name, and we surface only one to keep the catalog clean.
 */
export function dedupToolsByName(tools) {
  const deduped = new Map();
  for (const tool of tools) {
    const key = tool.name.toLowerCase();
    const existing = deduped.get(key);
    if (!existing) {
      deduped.set(key, tool);
      continue;
    }
    if (tool.isOfficial && !existing.isOfficial) {
      deduped.set(key, tool);
      continue;
    }
    if (existing.isOfficial) continue;
    const toolDate = tool.extra?.createdAt
      ? new Date(tool.extra.createdAt).getTime()
      : Infinity;
    const existingDate = existing.extra?.createdAt
      ? new Date(existing.extra.createdAt).getTime()
      : Infinity;
    if (toolDate < existingDate) {
      deduped.set(key, tool);
    } else if (
      toolDate === existingDate &&
      (tool.extra?.likes || 0) > (existing.extra?.likes || 0)
    ) {
      deduped.set(key, tool);
    }
  }
  return [...deduped.values()];
}

/**
 * Fetch the MCP tool catalog from the HF Hub.
 *
 * Mirrors `fetchAppsFromHF` in `index.js`:
 *   1. Pull the official + blocked Space lists from the store dataset
 *      (both best-effort; a missing file means "none").
 *   2. List public Spaces carrying the `reachy-mini-tool` tag.
 *   3. Map each into the catalog shape, attach the resolved MCP URL.
 *   4. Sort official-first, then by likes.
 *
 * Dedup is left to the caller/route (mirrors the app catalog, where each
 * route owns its own dedup policy). Returns the raw, sorted entries.
 *
 * `fetchImpl` is injectable for tests; defaults to the global `fetch`.
 */
export async function fetchMcpToolsFromHF({
  hfSpacesApi,
  limit,
  officialListUrl,
  blockListUrl,
  fetchImpl = fetch,
} = {}) {
  // 1. Official + block lists (both optional). Reuses the same store
  // dataset files as the app catalog so a Space blocked there is blocked
  // here too (the killswitch is global by design).
  const [officialResponse, blockResponse] = await Promise.all([
    officialListUrl ? fetchImpl(officialListUrl).catch(() => null) : null,
    blockListUrl ? fetchImpl(blockListUrl).catch(() => null) : null,
  ]);

  let officialIdList = [];
  if (officialResponse && officialResponse.ok) {
    officialIdList = await officialResponse.json().catch(() => []);
  }
  const officialSet = new Set(
    (Array.isArray(officialIdList) ? officialIdList : []).map((id) =>
      String(id).toLowerCase(),
    ),
  );

  let blockedIdList = [];
  if (blockResponse && blockResponse.ok) {
    blockedIdList = await blockResponse.json().catch(() => []);
  }
  const blockedSet = new Set(
    (Array.isArray(blockedIdList) ? blockedIdList : []).map((id) =>
      String(id).toLowerCase(),
    ),
  );

  // 2. List spaces carrying the MCP tool tag. `full=true` brings the
  // `siblings` file list (icon resolution) and `cardData` in one call.
  const spacesUrl = `${hfSpacesApi}?filter=${encodeURIComponent(
    MCP_TOOL_TAG,
  )}&full=true&limit=${limit}`;
  const spacesResponse = await fetchImpl(spacesUrl);
  if (!spacesResponse || !spacesResponse.ok) {
    throw new Error(
      `HF API returned ${spacesResponse ? spacesResponse.status : 'no response'}`,
    );
  }
  const allSpaces = await spacesResponse.json();
  if (!Array.isArray(allSpaces)) {
    throw new Error('HF API returned a non-array spaces payload');
  }

  // 3. Map into catalog shape.
  const tools = allSpaces.map((space) =>
    mapSpaceToMcpTool(space, { officialSet, blockedSet }),
  );

  // 4. Sort: official first, then by likes (same order as the app catalog).
  tools.sort((a, b) => {
    if (a.isOfficial !== b.isOfficial) return a.isOfficial ? -1 : 1;
    return (b.extra.likes || 0) - (a.extra.likes || 0);
  });

  return tools;
}
