import compression from 'compression';
import express from 'express';
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { categorizeApp, HfTokenMissingError } from './categorize.js';
import { categoryCache } from './categoryCache.js';
import { getPublicTaxonomy, loadTaxonomyFromDataset } from './categories.js';
import { moderateApp } from './moderate.js';
import { moderationCache } from './moderationCache.js';
import { decideVisibility } from './visibility.js';
import {
  dedupToolsByName,
  fetchMcpToolsFromHF,
  MCP_TOOL_TAG,
} from './mcpTools.js';
import { mintEphemeralKeyHandler } from './openaiEphemeral.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load `.env` from the repo root in dev. In production (HF Space)
// the platform already injects the secrets as env vars, so this
// loader silently no-ops. We avoid the `dotenv` dep on purpose -
// the format is trivial, and reproducing it inline keeps the
// runtime closure tiny.
(function loadDotenv() {
  try {
    const envPath = path.join(__dirname, '..', '.env');
    if (!existsSync(envPath)) return;
    const text = readFileSync(envPath, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
      if (!m) continue;
      const [, key, raw] = m;
      let value = raw;
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      // Existing env wins (so `HF_TOKEN=foo node …` overrides .env).
      if (process.env[key] === undefined) process.env[key] = value;
    }
  } catch {
    /* best-effort - missing or malformed .env never blocks boot */
  }
})();

const app = express();
const PORT = process.env.PORT || 7860;

// gzip/brotli compression on every response. Critical for the
// catalog endpoints (`/api/apps`, `/api/js-apps`) which return
// ~40KB of JSON dominated by repeated keys ("apps", "id", "extra",
// "cardData"…) - gzip cuts that to ~6KB on the wire. The Express
// `compression` middleware:
//   - skips responses already encoded (no double-encoding),
//   - skips responses below the `threshold` (default 1KB - tiny
//     payloads stay verbatim since the gzip framing would dwarf
//     the savings),
//   - honours the client's `Accept-Encoding`, falling back to
//     identity when the client doesn't speak gzip/br.
// No streaming endpoints in this server (every route ends in
// `res.json()` or `res.sendFile()`), so compression is unconditionally
// safe. The default `level: 6` is the right CPU/ratio trade-off for
// JSON.
app.use(compression());

// JSON body parsing for the handful of POST routes that consume
// structured payloads (currently `/api/openai/ephemeral`). The 8KB
// cap is intentionally tiny because none of our endpoints accept
// large bodies, and a tight limit drops obvious abuse early.
app.use(express.json({ limit: '8kb' }));

// CORS allowlist for cross-origin API consumers. Same-origin browser
// calls from this Space stay unaffected. The mobile shell runs from
// `https://tauri.localhost` (iOS WKWebView), `http://tauri.localhost`
// (Android WebView), and the desktop dev preview from
// `http://localhost:1422` (Vite). We do NOT use a wildcard origin
// because every allowed call expects `Authorization: Bearer …`, and
// `Access-Control-Allow-Origin: *` is incompatible with credentialed
// CORS in any practical setup.
const CORS_ALLOWED_ORIGINS = new Set([
  // Mobile shell (Tauri WebView)
  'https://tauri.localhost',
  'http://tauri.localhost',
  // Desktop / Vite dev previews
  'http://localhost:1422',
  'http://localhost:1420',
  'http://localhost:5173',
  // Showcase website Space (now a separate static deploy that calls
  // this API cross-origin). Static Spaces are served from the
  // `.static.hf.space` host, so that exact origin is what the browser
  // sends. Keep the plain `.hf.space` variant too in case of aliasing.
  // Test (tfrere) + prod (pollen-robotics).
  'https://tfrere-reachy-mini-website.static.hf.space',
  'https://pollen-robotics-reachy-mini-website.static.hf.space',
  'https://tfrere-reachy-mini-website.hf.space',
  'https://pollen-robotics-reachy-mini-website.hf.space',
]);

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && CORS_ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Authorization, Content-Type',
    );
    // Expose `Age` so cross-origin JS clients (mobile shell, desktop
    // store, anything not running same-origin on this Space) can
    // read the server-side cache age. The header lives in the
    // CORS-safelisted set only for a hardcoded handful of fields;
    // `Age` is NOT in that set, so without this header browser
    // `fetch()` callers would see `null` from `headers.get('age')`.
    // We could also expose `ETag` here for clients that want to
    // do manual `If-None-Match` revalidation, but the browser
    // handles ETag transparently in its own HTTP cache, so JS
    // never needs to see it.
    res.setHeader('Access-Control-Expose-Headers', 'Age');
    res.setHeader('Access-Control-Max-Age', '600');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Cache configuration
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// =====================================================================
// Store control-plane dataset (single source of truth)
// =====================================================================
//
// One HF dataset holds everything that drives the store catalog,
// split by nature into two folders:
//
//   config/   hand-edited, source of truth, precious (humans only)
//     - official-app-list.json : official app IDs (curated by Pollen)
//     - blocked-app-list.json  : blocked app IDs  (killswitch)
//     - taxonomy.json          : category list    (slugs/labels/descriptions)
//   cache/    machine-written, regenerable, disposable (server only)
//     - categories.json : LLM category cache (written by this server)
//     - moderation.json : moderation verdict cache (written by server)
//
// `config/*` is READ-only from the server (humans edit it on the Hub -
// anyone with dataset write access can promote/block an app or change
// the taxonomy without a code deploy). `cache/*` is WRITTEN by the
// server, so the Space's HF_TOKEN must have WRITE access. Each cache
// commits only its own file (`addOrUpdate` on a single path), so
// server writes never clobber the hand-edited config, and `cache/`
// can be wiped at any time (the server repopulates it).
//
// `STORE_DATASET` is the single knob: point it at any `namespace/name`
// and every file follows. The category/moderation caches and the
// taxonomy loader read the same env, so there is exactly one place to
// change.
export const STORE_DATASET =
  process.env.STORE_DATASET || 'pollen-robotics/reachy_mini_store_data';
const STORE_DATASET_RAW = `https://huggingface.co/datasets/${STORE_DATASET}/raw/main`;
const OFFICIAL_APP_LIST_URL = `${STORE_DATASET_RAW}/config/official-app-list.json`;
const BLOCK_LIST_URL = `${STORE_DATASET_RAW}/config/blocked-app-list.json`;
const HF_SPACES_API = 'https://huggingface.co/api/spaces';
// Note: HF API doesn't support pagination with filter=, so we use a high limit
const HF_SPACES_LIMIT = 1000;

/**
 * Standard HTTP caching for the catalog GET endpoints
 * (`/api/apps`, `/api/js-apps`).
 *
 * Why bake this into a helper instead of inlining the same two
 * `setHeader` calls in every route:
 *   1. Both endpoints share the same upstream cache state
 *      (`appsCache.lastFetch`) so they SHOULD emit a coherent
 *      `Age` value - any drift between routes would silently
 *      mislead clients about cache staleness.
 *   2. The `Cache-Control` directives below were chosen carefully;
 *      a future contributor copy-pasting one route to start a new
 *      catalog projection should inherit them rather than rolling
 *      their own.
 *
 * Cache-Control: `public, max-age=60, stale-while-revalidate=300`
 *   - `public`: response is safe to store in shared caches (the
 *     payload is identical for every caller, no per-user data).
 *   - `max-age=60`: clients + intermediaries may serve this
 *     response for up to 60 s without revalidating. The upstream
 *     `appsCache` already deduplicates within a 5-minute window
 *     server-side, so 60 s here means the network sees at most
 *     1 hit/minute per cache key per intermediate even under
 *     burst load (10k mobile shells waking up at the same time).
 *   - `stale-while-revalidate=300`: for a further 5 minutes after
 *     the response goes stale, intermediaries may serve the
 *     stale copy while revalidating in the background. This
 *     absorbs sudden traffic spikes without ever blocking the
 *     user on a cold-cache fetch.
 *
 * `Age` (RFC 7234 §5.1) replaces the `cacheAge` field we used to
 * pack into the response body. Pulling the age out of the body
 * was a strict prerequisite for ETag-based revalidation: Express's
 * default ETag is a hash of the response body, and a body that
 * carries a counter that increments every second produces a fresh
 * ETag every second, which makes `If-None-Match` permanently
 * negative and turns the ETag into dead weight. With `cacheAge`
 * promoted to a header, the body becomes a pure function of the
 * cache contents, the ETag becomes stable across requests that
 * hit the same cache snapshot, and clients sending `If-None-Match`
 * get cheap 304s instead of re-downloading 40 KB of JSON.
 */
function setCatalogCacheHeaders(res, lastFetchMs) {
  res.setHeader(
    'Cache-Control',
    'public, max-age=60, stale-while-revalidate=300',
  );
  const ageSeconds = lastFetchMs
    ? Math.max(0, Math.round((Date.now() - lastFetchMs) / 1000))
    : 0;
  res.setHeader('Age', String(ageSeconds));
}

// Tag that gates the JS-only subset surfaced by /api/js-apps and
// fed to the LLM categorizer. Mirrors the filter the mobile shell
// applies today client-side; the route lets us retire that filter
// from the mobile codebase down the line.
const JS_APP_TAG = 'reachy_mini_js_app';

// =====================================================================
// App icon convention
// =====================================================================
//
// Convention: an app commits `public/icon.svg` (preferred) or
// `public/icon.png` in its HF Space repository. When present, the
// mobile shell + desktop store render it as the app glyph instead
// of the front-matter `emoji:` codepoint.
//
// Why `public/` and not the repo root?
//   - Vite already copies `public/*` verbatim to `dist/` at build,
//     where nginx serves it at `/icon.svg`. The same file is
//     therefore the favicon, the `mountHost({ appIconUrl })` value,
//     AND the store glyph - one source of truth, no `cp` script,
//     no risk of the two copies drifting apart.
//   - HF `resolve/main/public/icon.svg` works the same as
//     `resolve/main/icon.svg`: any path inside the repo is
//     reachable, so the catalog still grabs the bytes without
//     waking the Space's nginx.
//
// We resolve the icon ONCE at indexing time (here) rather than
// probing per-client because:
//   1. We already pull `siblings` from `?full=true` (one cheap
//      hub call returns the file list for every app), so the
//      lookup is a pure JS filter, no extra network.
//   2. Clients see a single field (`iconUrl`) in the payload and
//      don't have to know about HF resolve URLs, LFS pointers,
//      or the candidate-order race ("SVG wins if both exist").
//   3. The HF API caps probes at ~hub side; doing it server-side
//      keeps fanout under a 5-minute TTL behind ONE token, instead
//      of every mobile shell hammering `huggingface.co/resolve/`
//      to discover icons.
//
// Resolution order: `public/icon.svg` → `public/icon.png`. SVG
// first because the same asset scales cleanly across every mount
// point (small rail tile, larger pinned tile, iframe header) from
// a single file. Extra formats can be added to `ICON_CANDIDATES`
// if needed; order matters - the first match wins.
const ICON_CANDIDATES = ['public/icon.svg', 'public/icon.png'];

/**
 * Look for a standard app icon file at the conventional location.
 * Returns the absolute HF resolve URL when found, `null` otherwise.
 *
 * We hit `resolve/main/` (not `raw/main/`) so:
 *   - LFS pointers follow transparently (large PNGs work).
 *   - `Content-Type` comes from the extension, which `<img>` needs.
 *   - The URL is cacheable cross-session by the browser, so
 *     repeated mounts of the same app glyph don't re-fetch.
 */
function findIconUrl(spaceId, siblings) {
  if (!spaceId || !Array.isArray(siblings)) return null;
  // Build a Set of repo-relative filenames for O(1) candidate
  // lookups. HF returns `siblings` as `[{ rfilename: "path/in/repo" }, ...]`;
  // we keep the full path because the convention now lives under
  // `public/` rather than at the repo root.
  const files = new Set();
  for (const s of siblings) {
    const name = s && typeof s.rfilename === 'string' ? s.rfilename : null;
    if (!name) continue;
    files.add(name);
  }
  for (const candidate of ICON_CANDIDATES) {
    if (files.has(candidate)) {
      return `https://huggingface.co/spaces/${spaceId}/resolve/main/${candidate}`;
    }
  }
  return null;
}

// Serialised LLM batch concurrency: we want at most one
// categorization sweep running at a time, regardless of how many
// /api/js-apps requests come in. The flag also prevents the
// startup warm-up and an on-demand refresh from racing each other.
let categorizationBatchRunning = false;

// Same idea for the moderation sweep - independent flag so a
// moderation batch and a categorization batch can run concurrently
// (they hit the same HF Inference token but are otherwise unrelated),
// while two moderation batches never overlap.
let moderationBatchRunning = false;

// In-memory mirror of the hand-edited blocked-app-list.json. Refreshed
// alongside the apps cache (see `fetchAppsFromHF`). Lower-cased IDs.
let blockedSet = new Set();

// In-memory cache
let appsCache = {
  data: null,
  lastFetch: null,
  fetching: false,
};

// Independent in-memory cache for the MCP tool catalog. Kept separate
// from `appsCache` because it queries a different HF tag filter
// (`reachy-mini-tool` vs `reachy_mini`) and the two catalogs barely
// overlap - sharing one cache would force both to refetch together.
let mcpToolsCache = {
  data: null,
  lastFetch: null,
  fetching: false,
};

// Fetch apps from HuggingFace API
// Returns format compatible with desktop app (with url, source_kind, extra)
async function fetchAppsFromHF() {
  console.log('[Cache] Fetching apps from HuggingFace API...');
  
  try {
    // 1. Fetch official app IDs + the manual block-list (killswitch).
    // Both are plain JSON arrays of Space IDs under the dataset's config/.
    const [officialResponse, blockResponse] = await Promise.all([
      fetch(OFFICIAL_APP_LIST_URL),
      fetch(BLOCK_LIST_URL).catch(() => null),
    ]);
    let officialIdList = [];
    if (officialResponse.ok) {
      officialIdList = await officialResponse.json();
    }
    const officialSet = new Set(officialIdList.map(id => id.toLowerCase()));

    // Block-list is best-effort: a missing file (404, the common
    // case until the first kill) just means "nothing blocked".
    let blockedIdList = [];
    if (blockResponse && blockResponse.ok) {
      blockedIdList = await blockResponse.json().catch(() => []);
    }
    blockedSet = new Set(
      (Array.isArray(blockedIdList) ? blockedIdList : []).map((id) =>
        String(id).toLowerCase(),
      ),
    );
    if (blockedSet.size > 0) {
      console.log(`[Cache] Block-list: ${blockedSet.size} Space(s) hidden.`);
    }

    // 2. Fetch all spaces with reachy_mini tag
    // Note: HF API doesn't support pagination with filter=, so we use a high limit
    const spacesResponse = await fetch(`${HF_SPACES_API}?filter=reachy_mini&full=true&limit=${HF_SPACES_LIMIT}`);
    if (!spacesResponse.ok) {
      throw new Error(`HF API returned ${spacesResponse.status}`);
    }
    const allSpaces = await spacesResponse.json();
    console.log(`[Cache] Fetched ${allSpaces.length} spaces from HuggingFace`);

    // 3. Build apps list in desktop-compatible format
    const allApps = allSpaces.map(space => {
      const spaceId = space.id || '';
      const tags = space.tags || [];
      const isOfficial = officialSet.has(spaceId.toLowerCase());
      const isBlocked = blockedSet.has(spaceId.toLowerCase());
      const isPythonApp = tags.includes('reachy_mini_python_app');
      const author = spaceId.split('/')[0];
      const name = spaceId.split('/').pop();
      
      // Server-resolved icon URL. Looks for `public/icon.svg` or
      // `public/icon.png` via the `siblings` list returned by
      // `?full=true`. See `findIconUrl()` above for the rationale.
      // `null` when the author hasn't shipped one; clients fall
      // back to the front-matter emoji.
      const iconUrl = findIconUrl(spaceId, space.siblings);

      return {
        // Core fields (used by both website and desktop)
        id: spaceId,
        name,
        description: space.cardData?.short_description || '',
        url: `https://huggingface.co/spaces/${spaceId}`,
        source_kind: 'hf_space',
        isOfficial,
        isBlocked,
        iconUrl,

        // Extra metadata (desktop-compatible structure)
        extra: {
          id: spaceId,
          author,
          likes: space.likes || 0,
          downloads: space.downloads || 0,
          createdAt: space.createdAt || null,
          lastModified: space.lastModified,
          runtime: space.runtime || null,
          tags,
          isPythonApp,
          cardData: {
            emoji: space.cardData?.emoji || (isPythonApp ? '📦' : '🌐'),
            short_description: space.cardData?.short_description || '',
            sdk: space.cardData?.sdk || null,
            tags: space.cardData?.tags || [],
            // Preserve other cardData fields
            ...space.cardData,
          },
        },
      };
    });

    console.log(`[Cache] Built ${allApps.length} raw app entries from HF.`);

    // Sort: official first, then by likes. Dedup is route-specific
    // and applied downstream (see `dedupGlobalApps` and `dedupJsApps`).
    allApps.sort((a, b) => {
      if (a.isOfficial !== b.isOfficial) {
        return a.isOfficial ? -1 : 1;
      }
      return (b.extra.likes || 0) - (a.extra.likes || 0);
    });

    return allApps;
  } catch (err) {
    console.error('[Cache] Error fetching apps:', err);
    throw err;
  }
}

/**
 * Pick a winner among Spaces sharing the same repo name. Forks
 * keep the upstream name (e.g. several `reachy_mini_conversation_app`
 * from different authors); we surface only one in the store to
 * avoid drowning the original under a dozen near-identical tiles.
 *
 * Priority: 1) official, 2) oldest (likely original), 3) most likes
 * as tiebreaker.
 */
function dedupAppsByName(apps) {
  const deduped = new Map();
  for (const app of apps) {
    const key = app.name.toLowerCase();
    const existing = deduped.get(key);
    if (!existing) {
      deduped.set(key, app);
      continue;
    }
    if (app.isOfficial && !existing.isOfficial) {
      deduped.set(key, app);
      continue;
    }
    if (existing.isOfficial) continue;
    const appDate = app.extra?.createdAt ? new Date(app.extra.createdAt).getTime() : Infinity;
    const existingDate = existing.extra?.createdAt ? new Date(existing.extra.createdAt).getTime() : Infinity;
    if (appDate < existingDate) {
      deduped.set(key, app);
    } else if (appDate === existingDate && (app.extra?.likes || 0) > (existing.extra?.likes || 0)) {
      deduped.set(key, app);
    }
  }
  return [...deduped.values()];
}

/**
 * Dedup applied to the full `/api/apps` payload (Python + JS + others
 * mixed). Same-name collisions across SDKs collapse here too, by design:
 * the showcase site favours a clean catalog over completeness, and
 * SDK-aware variants of the same idea live as separate Spaces only
 * by accident in practice.
 */
function dedupGlobalApps(apps) {
  return dedupAppsByName(apps);
}

/**
 * Dedup applied to the `/api/js-apps` route only. We restrict the
 * comparison to entries already filtered to the JS subset, so a JS
 * Space (e.g. `tfrere/emotions`) does not lose a name fight against
 * an unrelated Python Space sharing the same repo name (e.g.
 * `RemiFabre/emotions`). The mobile shell only sees JS apps anyway,
 * so confining dedup to that scope is what matches the user model.
 */
function dedupJsApps(jsApps) {
  return dedupAppsByName(jsApps);
}

// Get raw apps with caching. Dedup is NOT applied here - each
// route owns its own dedup policy (see `dedupGlobalApps` and
// `dedupJsApps`) so they can disagree without paying for two
// upstream fetches.
async function getRawApps() {
  const now = Date.now();
  
  // Return cache if valid
  if (appsCache.data && appsCache.lastFetch && (now - appsCache.lastFetch) < CACHE_TTL_MS) {
    const ageMinutes = Math.round((now - appsCache.lastFetch) / 60000);
    console.log(`[Cache] Returning cached data (age: ${ageMinutes} min)`);
    return appsCache.data;
  }

  // Prevent concurrent fetches
  if (appsCache.fetching) {
    console.log('[Cache] Fetch already in progress, returning stale data');
    return appsCache.data || [];
  }

  appsCache.fetching = true;
  
  try {
    const apps = await fetchAppsFromHF();
    appsCache.data = apps;
    appsCache.lastFetch = now;
    console.log(`[Cache] Cache updated with ${apps.length} raw entries`);
    return apps;
  } catch (err) {
    // On error, return stale cache if available
    if (appsCache.data) {
      console.log('[Cache] Fetch failed, returning stale cache');
      return appsCache.data;
    }
    throw err;
  } finally {
    appsCache.fetching = false;
  }
}

// API endpoint
app.get('/api/apps', async (req, res) => {
  try {
    const raw = await getRawApps();
    const apps = dedupGlobalApps(raw);
    setCatalogCacheHeaders(res, appsCache.lastFetch);
    res.json({
      apps,
      cached: true,
      count: apps.length,
    });
  } catch (err) {
    console.error('[API] Error:', err);
    res.status(500).json({ error: 'Failed to fetch apps' });
  }
});

// =====================================================================
// MCP tool catalog
// =====================================================================
//
// `/api/mcp-tools` is the catalog of MCP tool sources: public HF Spaces
// tagged `reachy-mini-tool` that expose the standard Gradio MCP endpoint.
// It mirrors `/api/apps` (cache + dedup + cache headers) and adds, for
// each entry, the resolved `mcpUrl` a client needs to wire up a transport.
//
// Unlike `/api/js-apps` there is no LLM categorization here; the only
// safety gate is the shared block-list killswitch (see `computeVisibility`-
// style filtering below), enforced by default so a blocked Space never
// reaches a client. `?includeHidden=true` bypasses it for admin/debug and
// keeps the `isBlocked` flag for inspection.

/**
 * Get the raw MCP tool catalog with caching. Same shape and TTL policy as
 * `getRawApps`: serve a warm cache, dedupe concurrent fetches, and fall
 * back to stale data on upstream failure rather than emptying the catalog.
 */
async function getRawMcpTools() {
  const now = Date.now();

  if (
    mcpToolsCache.data &&
    mcpToolsCache.lastFetch &&
    now - mcpToolsCache.lastFetch < CACHE_TTL_MS
  ) {
    const ageMinutes = Math.round((now - mcpToolsCache.lastFetch) / 60000);
    console.log(`[MCP] Returning cached tools (age: ${ageMinutes} min)`);
    return mcpToolsCache.data;
  }

  if (mcpToolsCache.fetching) {
    console.log('[MCP] Fetch already in progress, returning stale data');
    return mcpToolsCache.data || [];
  }

  mcpToolsCache.fetching = true;
  try {
    console.log(`[MCP] Fetching tool Spaces tagged "${MCP_TOOL_TAG}"...`);
    const tools = await fetchMcpToolsFromHF({
      hfSpacesApi: HF_SPACES_API,
      limit: HF_SPACES_LIMIT,
      officialListUrl: OFFICIAL_APP_LIST_URL,
      blockListUrl: BLOCK_LIST_URL,
    });
    mcpToolsCache.data = tools;
    mcpToolsCache.lastFetch = now;
    console.log(`[MCP] Cache updated with ${tools.length} tool Space(s)`);
    return tools;
  } catch (err) {
    if (mcpToolsCache.data) {
      console.log('[MCP] Fetch failed, returning stale cache');
      return mcpToolsCache.data;
    }
    throw err;
  } finally {
    mcpToolsCache.fetching = false;
  }
}

app.get('/api/mcp-tools', async (req, res) => {
  try {
    const raw = await getRawMcpTools();
    const deduped = dedupToolsByName(raw);

    // Enforce the block-list killswitch by default. These entries describe
    // tools the assistant may actually invoke, so a blocked Space must not
    // surface to clients. `?includeHidden=true` is the admin/debug escape.
    const includeHidden = req.query.includeHidden === 'true';
    const tools = includeHidden
      ? deduped
      : deduped.filter((t) => t.isBlocked !== true);

    setCatalogCacheHeaders(res, mcpToolsCache.lastFetch);
    res.json({
      tools,
      cached: true,
      count: tools.length,
      hidden: deduped.length - tools.length,
    });
  } catch (err) {
    console.error('[API] /api/mcp-tools error:', err);
    res.status(500).json({ error: 'Failed to fetch MCP tools' });
  }
});

// =====================================================================
// JS apps + LLM-inferred categories
// =====================================================================
//
// `/api/js-apps` is a curated view on the JS-only subset:
//   1. Filter on the `reachy_mini_js_app` tag (the mobile-embeddable subset).
//   2. Dedup name collisions among JS apps only (`dedupJsApps`),
//      so a JS app does not get knocked out by a same-named Python
//      Space surfaced through `/api/apps`.
//   3. Enrich each entry with `categories` + `categories_source`,
//      sourced from a persistent dataset cache (see categoryCache.js).
//
// Categories are inferred lazily by an LLM from each Space's
// README. The first request after a cold start may see entries
// with `categories: null` while the warmup batch is still in
// flight; subsequent requests pick them up as the cache fills.

/**
 * Pull the JS-app subset out of the raw apps cache, dedup it
 * within the JS scope, and fold in cached categories. Pure,
 * synchronous-ish (the only async call is to `getRawApps()` which
 * has its own cache).
 */
async function getJsApps() {
  const raw = await getRawApps();
  const jsApps = raw.filter((a) => {
    const tags = a?.extra?.tags;
    return Array.isArray(tags) && tags.includes(JS_APP_TAG);
  });
  const deduped = dedupJsApps(jsApps);

  return deduped.map((app) => {
    const cached = categoryCache.get(app.id);
    const moderation = computeVisibility(app);
    return {
      ...app,
      categories: cached ? cached.categories : null,
      categories_source: cached ? 'inferred' : null,
      categorized_at: cached ? cached.categorizedAt : null,
      mobile_visible: moderation.visible,
      moderation,
    };
  });
}

/**
 * Decide whether a JS app is visible in the mobile catalog, and why.
 *
 * Thin wrapper: looks up the cached moderation verdict and delegates
 * the fail-closed policy to the pure `decideVisibility` in
 * `visibility.js` (which is unit-tested in isolation - see
 * `test/visibility.test.mjs`). Only an explicit `allow` verdict (or a
 * curated official app) is visible; a `block`, a `review`, a manual
 * block-list hit, or no verdict yet all keep the app hidden, so a new
 * Space never appears before moderation has explicitly cleared it
 * (App Store guideline 1.2).
 *
 * Returns `{ visible, source, decision, category, reason }` so the
 * payload can explain a hide to the website / admins without leaking
 * a blocked app's content.
 */
function computeVisibility(app) {
  return decideVisibility(app, moderationCache.get(app.id));
}

/**
 * Run one moderation pass over `jsApps`. Mirrors
 * `runCategorizationBatch`: serial, skips official apps and entries
 * whose verdict is still fresh, jitters between LLM calls, persists
 * once at the end. Never throws (transient misses are retried next
 * pass).
 */
async function runModerationBatch(jsApps) {
  if (moderationBatchRunning) {
    console.log('[Moderate] Batch already running, skipping.');
    return;
  }
  if (!process.env.HF_TOKEN) {
    console.warn(
      '[Moderate] HF_TOKEN not set; skipping batch. Set it in .env or the Space secrets to enable moderation.',
    );
    return;
  }

  const todo = jsApps.filter(
    (app) =>
      !app.isOfficial &&
      moderationCache.needsModeration(app.id, app?.extra?.lastModified),
  );

  if (todo.length === 0) {
    console.log(`[Moderate] All ${jsApps.length} JS apps already moderated.`);
    return;
  }

  moderationBatchRunning = true;
  console.log(
    `[Moderate] Starting batch: ${todo.length}/${jsApps.length} app(s) need moderation.`,
  );

  let blocked = 0;
  let allowed = 0;
  let failed = 0;
  let aborted = false;

  for (let i = 0; i < todo.length; i++) {
    const app = todo[i];
    const desc =
      app.description || app.extra?.cardData?.short_description || '';
    try {
      const verdict = await moderateApp({
        spaceId: app.id,
        name: app.name,
        description: desc,
      });
      if (verdict == null) {
        failed++;
      } else {
        moderationCache.set(app.id, {
          ...verdict,
          lastModified: app.extra?.lastModified || null,
        });
        if (verdict.decision === 'block') blocked++;
        else allowed++;
        console.log(
          `[Moderate]   (${i + 1}/${todo.length}) ${app.id}: ${verdict.decision}/${verdict.category} (${verdict.source})`,
        );
      }
    } catch (err) {
      if (err instanceof HfTokenMissingError) {
        console.warn('[Moderate] HF_TOKEN missing mid-batch; aborting.');
        aborted = true;
        break;
      }
      failed++;
      console.warn(`[Moderate]   (${i + 1}/${todo.length}) ${app.id}: error - ${err.message}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  console.log(
    `[Moderate] Batch done: ${allowed} allowed, ${blocked} blocked, ${failed} failed${aborted ? ' (aborted)' : ''}.`,
  );
  await moderationCache.flush();
  moderationBatchRunning = false;
}

/**
 * Run one classification pass over `jsApps`. Skips entries whose
 * cache is still fresh (same `lastModified`, same taxonomy).
 *
 * Serial on purpose: HF Inference Providers don't love bursts
 * from a single token, and total throughput on ~50 apps stays
 * well under a minute. We slip a small jitter between calls to
 * smooth the curve further.
 */
async function runCategorizationBatch(jsApps) {
  if (categorizationBatchRunning) {
    console.log('[Categorize] Batch already running, skipping.');
    return;
  }
  if (!process.env.HF_TOKEN) {
    console.warn(
      '[Categorize] HF_TOKEN not set; skipping batch. Set it in .env ' +
        'or the Space secrets to enable category inference.',
    );
    return;
  }

  const todo = jsApps.filter((app) =>
    categoryCache.needsCategorization(app.id, app?.extra?.lastModified),
  );

  if (todo.length === 0) {
    console.log(
      `[Categorize] All ${jsApps.length} JS apps are already categorized.`,
    );
    return;
  }

  categorizationBatchRunning = true;
  console.log(
    `[Categorize] Starting batch: ${todo.length}/${jsApps.length} app(s) need classification.`,
  );

  let success = 0;
  let failed = 0;
  let aborted = false;

  for (let i = 0; i < todo.length; i++) {
    const app = todo[i];
    const desc =
      app.description ||
      app.extra?.cardData?.short_description ||
      '';
    try {
      const slugs = await categorizeApp({
        spaceId: app.id,
        name: app.name,
        description: desc,
      });
      if (slugs == null) {
        failed++;
        console.log(
          `[Categorize]   (${i + 1}/${todo.length}) ${app.id}: transient failure, will retry next pass`,
        );
      } else {
        categoryCache.set(app.id, {
          categories: slugs,
          lastModified: app.extra?.lastModified || null,
        });
        success++;
        console.log(
          `[Categorize]   (${i + 1}/${todo.length}) ${app.id}: ${
            slugs.length ? slugs.join(', ') : '(no fit)'
          }`,
        );
      }
    } catch (err) {
      if (err instanceof HfTokenMissingError) {
        console.warn(
          '[Categorize] HF_TOKEN missing mid-batch; aborting cleanly.',
        );
        aborted = true;
        break;
      }
      failed++;
      console.warn(
        `[Categorize]   (${i + 1}/${todo.length}) ${app.id}: error - ${err.message}`,
      );
    }

    // 250 ms cooldown between calls. Below this, the HF Provider
    // router occasionally rate-limits a hot token.
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  console.log(
    `[Categorize] Batch done: ${success} ok, ${failed} failed${aborted ? ' (aborted)' : ''}.`,
  );
  // Persist the new entries even if some failed - partial
  // progress is strictly better than none, and the failed
  // entries will be retried on the next pass.
  await categoryCache.flush();

  categorizationBatchRunning = false;
}

/**
 * Wrap the diagnostic snapshot for the API payload. Lets
 * consumers (mobile shell, website) decide whether to show
 * "loading categories..." or render chips immediately.
 */
function buildCategorizationStats(jsApps) {
  let withCategories = 0;
  for (const app of jsApps) {
    if (app.categories && app.categories.length >= 0 && app.categories_source) {
      withCategories++;
    }
  }
  return {
    enabled: !!process.env.HF_TOKEN,
    total: jsApps.length,
    classified: withCategories,
    pending: jsApps.length - withCategories,
    inProgress: categorizationBatchRunning,
    // Authoritative taxonomy shipped alongside the apps so the
    // mobile shell (and any future client) doesn't have to mirror
    // the slug list by hand. Pairs with `taxonomyVersion` from
    // `categoryCache.stats()` so clients can detect drift between
    // the catalog payload and a stale on-device cache.
    taxonomy: getPublicTaxonomy(),
    ...categoryCache.stats(),
  };
}

app.get('/api/js-apps', async (req, res) => {
  try {
    const apps = await getJsApps();

    // Background top-up for categorization: if any entry is still
    // uncategorized (or a Space's lastModified moved), fire a batch.
    // Not awaited - the response goes out with whatever the cache
    // currently knows.
    const needsCategories = apps.some(
      (a) =>
        !a.categories_source ||
        categoryCache.needsCategorization(a.id, a.extra?.lastModified),
    );
    if (needsCategories) {
      void runCategorizationBatch(apps).catch((err) => {
        console.error('[Categorize] Background batch crashed:', err);
      });
    }

    // Same pattern for moderation: top-up in the background, never
    // block the response.
    const needsModeration = apps.some(
      (a) =>
        !a.isOfficial &&
        moderationCache.needsModeration(a.id, a.extra?.lastModified),
    );
    if (needsModeration) {
      void runModerationBatch(apps).catch((err) => {
        console.error('[Moderate] Background batch crashed:', err);
      });
    }

    // Filter out everything not visible in the mobile catalog. This
    // is the enforcement point: blocked / hidden apps never reach any
    // client (mobile or website). `?includeHidden=true` bypasses the
    // filter for admin / debugging (the hidden entries keep their
    // `moderation` field explaining why).
    const includeHidden = req.query.includeHidden === 'true';
    const visibleApps = includeHidden
      ? apps
      : apps.filter((a) => a.mobile_visible !== false);

    setCatalogCacheHeaders(res, appsCache.lastFetch);
    res.json({
      apps: visibleApps,
      cached: true,
      count: visibleApps.length,
      categorization: buildCategorizationStats(visibleApps),
      moderation: {
        hidden: apps.length - visibleApps.length,
        ...moderationCache.stats(),
      },
    });
  } catch (err) {
    console.error('[API] /api/js-apps error:', err);
    res.status(500).json({ error: 'Failed to fetch JS apps' });
  }
});

// =====================================================================
// Public taxonomy endpoint
// =====================================================================
//
// Standalone read-only projection of the closed category taxonomy
// (`server/categories.js`). Lets clients consume the slug list,
// labels and emojis without paying the cost of a full apps fetch -
// useful for early UI scaffolding (filter chips, empty states) and
// for tooling that lints app metadata against the live taxonomy.
//
// `/api/js-apps` ALSO embeds the same payload under
// `categorization.taxonomy`, so a mobile shell that fetches the
// catalog never needs a second round-trip. This endpoint exists
// for the "I just want the categories" use case.
//
// Cache headers: 5 minutes, same TTL as the catalog. The taxonomy
// is stable across many catalog refreshes (it only moves when we
// bump `TAXONOMY_VERSION`), but co-aligning the TTLs keeps the
// reasoning simple - a client that polls both gets a coherent view.
app.get('/api/categories', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  const stats = categoryCache.stats();
  res.json({
    taxonomy: getPublicTaxonomy(),
    taxonomyVersion: stats.taxonomyVersion,
  });
});

// Manual trigger for a categorization sweep, useful when
// hand-tuning the taxonomy or testing the LLM prompt without
// waiting for the next /api/js-apps hit.
app.post('/api/js-apps/refresh-categories', async (req, res) => {
  try {
    const apps = await getJsApps();
    void runCategorizationBatch(apps).catch((err) => {
      console.error('[Categorize] Manual batch crashed:', err);
    });
    res.json({
      ok: true,
      message: `Categorization batch kicked off for ${apps.length} JS apps.`,
      stats: buildCategorizationStats(apps),
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to trigger refresh' });
  }
});

// Manual trigger for a moderation sweep (twin of refresh-categories).
app.post('/api/js-apps/refresh-moderation', async (req, res) => {
  try {
    const apps = await getJsApps();
    void runModerationBatch(apps).catch((err) => {
      console.error('[Moderate] Manual batch crashed:', err);
    });
    res.json({
      ok: true,
      message: `Moderation batch kicked off for ${apps.length} JS apps.`,
      stats: moderationCache.stats(),
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to trigger moderation refresh' });
  }
});

// =====================================================================
// OpenAI Realtime ephemeral keys
// =====================================================================
//
// Per-user mint endpoint backing the Reachy Mini mobile shell's
// voice conversation. The mobile client posts its HF Bearer token,
// we validate it via `whoami-v2`, rate-limit per HF user, and
// proxy a `POST /v1/realtime/sessions` to OpenAI with the master
// `OPENAI_API_KEY` from this Space's secrets. The short-lived
// `client_secret.value` is forwarded back to the client.
//
// See `server/openaiEphemeral.js` for the full design notes
// (auth, caching, rate-limit shape, error mapping).
app.post('/api/openai/ephemeral', mintEphemeralKeyHandler);

// OAuth config endpoint - expose public OAuth variables to the frontend
// (Docker Spaces don't auto-inject window.huggingface.variables like static Spaces)
app.get('/api/oauth-config', (req, res) => {
  const clientId = process.env.OAUTH_CLIENT_ID;
  const scopes = process.env.OAUTH_SCOPES || 'openid profile';

  if (!clientId) {
    return res.status(503).json({
      error: 'OAuth not configured',
      hint: 'Make sure hf_oauth: true is set in README.md and the Space has been rebuilt',
    });
  }

  res.json({ clientId, scopes });
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    cacheStatus: appsCache.data ? 'warm' : 'cold',
    cacheAge: appsCache.lastFetch ? Math.round((Date.now() - appsCache.lastFetch) / 1000) : null,
    appsCount: appsCache.data?.length || 0,
    mcpToolsCacheStatus: mcpToolsCache.data ? 'warm' : 'cold',
    mcpToolsCount: mcpToolsCache.data?.length || 0,
  });
});

// Force cache refresh (for admin use)
app.post('/api/refresh', async (req, res) => {
  try {
    appsCache.lastFetch = null; // Invalidate cache
    mcpToolsCache.lastFetch = null; // Invalidate MCP tool cache too
    const [apps, mcpTools] = await Promise.all([
      getRawApps(),
      getRawMcpTools().catch(() => []),
    ]);
    res.json({ success: true, count: apps.length, mcpToolsCount: mcpTools.length });
  } catch (err) {
    res.status(500).json({ error: 'Failed to refresh cache' });
  }
});

// API-only service: the showcase website is a separate static Space
// now, so there is no `dist/` to serve here. Any non-API path is a
// client error - return JSON rather than HTML so callers (mobile
// shell, website fetch) always get a parseable body.
app.use((req, res) => {
  res.status(404).json({ error: 'not found', path: req.path });
});

// Pre-warm cache on startup
async function warmCache() {
  console.log('[Startup] Pre-warming cache...');

  // MCP tool catalog warm-up: fire-and-forget so a slow tool listing
  // never delays the (more critical) app catalog warm-up below. Its own
  // cache + stale-fallback make a transient failure here harmless.
  void getRawMcpTools()
    .then((tools) =>
      console.log(`[Startup] MCP tool cache warmed (${tools.length} Space(s))`),
    )
    .catch((err) => console.error('[Startup] MCP tool warm-up failed:', err));

  try {
    const apps = await getRawApps();
    console.log('[Startup] Cache warmed successfully');

    // Categorization warm-up: fire the JS-app batch in the
    // background so the first /api/js-apps caller doesn't
    // shoulder the cold-start cost. Order: load the dataset
    // cache first (cheap, one HTTP call), then run the batch
    // for stale entries only.
    void (async () => {
      try {
        // Load the editable taxonomy from the dataset FIRST so the
        // category cache prunes stale entries against the live
        // version (and the LLM prompt uses the live descriptions).
        await loadTaxonomyFromDataset(STORE_DATASET, process.env.HF_TOKEN);
        await Promise.all([categoryCache.load(), moderationCache.load()]);
        const jsApps = dedupJsApps(
          apps.filter((a) => {
            const tags = a?.extra?.tags;
            return Array.isArray(tags) && tags.includes(JS_APP_TAG);
          }),
        );
        console.log(
          `[Startup] Found ${jsApps.length} JS apps; checking categories + moderation...`,
        );
        // Moderation first, then categories - they share the HF
        // Inference token, so running them serially avoids doubling
        // the burst on a cold start. Since the catalog is fail-closed
        // (non-official apps are hidden until an explicit `allow`
        // verdict lands), moderation is the visibility gate and runs
        // first so cleared apps surface as soon as possible; categories
        // are cosmetic and can fill in a few seconds later.
        await runModerationBatch(jsApps);
        await runCategorizationBatch(jsApps);
      } catch (err) {
        console.error('[Startup] Categorization/moderation warm-up failed:', err);
      }
    })();
  } catch (err) {
    console.error('[Startup] Failed to warm cache:', err);
  }
}

// Start server
app.listen(PORT, () => {
  console.log(`[Server] Running on port ${PORT}`);
  warmCache();
});
