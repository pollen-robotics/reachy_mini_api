/**
 * Predefined taxonomy for JS Reachy Mini apps.
 *
 * These slugs are the ONLY valid output values for the LLM
 * inference step (anything else is dropped at parse time) and
 * the values consumers (mobile shell, website) filter on.
 *
 * Why a closed list instead of free-form tags
 * ──────────────────────────────────────────
 * The HF Spaces catalog has no usable categorization for the
 * reachy_mini_js_app subset (only platform/SDK tags). We bridge
 * the gap by inferring categories with an LLM, but we have to
 * constrain the model's output: a closed list keeps category
 * pages stable, lets us pre-pick emojis/labels, and avoids the
 * "30 near-duplicate slugs" problem you'd get with free-form.
 *
 * Bumping the taxonomy
 * ────────────────────
 * Adding, removing or renaming a slug changes the meaning of
 * cached entries. Bump TAXONOMY_VERSION when you do that: the
 * cache layer compares each entry's `taxonomyVersion` against
 * the live one and recomputes stale ones on the next pass.
 */

/**
 * Default taxonomy version, used as a fallback when the dataset's
 * `config/taxonomy.json` is missing/unreadable. The LIVE version is
 * exported as the mutable `TAXONOMY_VERSION` below and is overwritten
 * by `loadTaxonomyFromDataset()` at boot.
 *
 * Bump the version (in the dataset file, or here for the fallback)
 * when the slug list OR the descriptions change in a way that affects
 * the LLM output: the cache layer invalidates entries whose
 * taxonomyVersion is older and reclassifies them on the next pass.
 * Cosmetic edits (label / emoji) don't need a bump since they don't
 * reach the LLM.
 *
 * History:
 *   - v1: initial 8-slug taxonomy.
 *   - v2: added `games`, tightened `kids` + `dev-tools` descriptions,
 *         switched the prompt to a DECISION ALGORITHM with few-shot.
 *   - v3: switched from multi-label (up to 3 slugs) to single-label
 *         (exactly 1 slug). Each app surfaces in exactly one category
 *         section on the mobile shell - no duplicates across swipers.
 *   - v4: renamed `dance` to `motion` (broader: marionette, replay,
 *         choreography without music). Music-driven dance parties
 *         now belong to `music` since music is what drives them.
 *   - v4 (data-driven): the canonical list now lives in the dataset
 *         at `config/taxonomy.json`; this array is only the cold-start
 *         fallback. Editing categories no longer requires a code deploy.
 */
const DEFAULT_TAXONOMY_VERSION = 4;

/**
 * Default category list (cold-start fallback). The canonical, editable
 * list lives in the dataset at `config/taxonomy.json` and is loaded
 * over this at boot. Keep slugs short, kebab-case, and memorable: they
 * end up in URLs (e.g. `?cat=music`) and in filter chips on mobile.
 *
 * The `description` field is the SOLE source of truth the LLM sees -
 * keep them factual, scope-bounded, and example-led so the model has
 * signal for both inclusion and exclusion.
 */
const DEFAULT_CATEGORIES = [
  {
    slug: 'music',
    label: 'Music & Beats',
    emoji: '🎵',
    description:
      'Music creation, playback, beats, songs, DJ mixing, instruments, ' +
      'blind-test music games, AND music-driven dance parties (Reachy ' +
      'dances to a song). Requires actual music (rhythm / melody / song). ' +
      'Arbitrary audio (Morse code, alarms, TTS, sound effects) is NOT ' +
      'music. Pure choreography without music belongs to `motion`.',
  },
  {
    slug: 'motion',
    label: 'Motion & Movement',
    emoji: '🦾',
    description:
      "Apps that drive Reachy's physical movement on its own: motion " +
      'replay, marionette-style remote control of the body, kinetic ' +
      'shows, choreographies WITHOUT music, expressive body language. ' +
      'If the movement is synced to music, use `music` instead.',
  },
  {
    slug: 'voice',
    label: 'Voice & Conversation',
    emoji: '🗣️',
    description:
      'Reachy talks, listens, or holds a real-time voice ' +
      'conversation: TTS players, LLM-driven chat (OpenAI Realtime, ' +
      'Claude, Perplexity), wake-word demos, daily reports / news / ' +
      'weather read aloud.',
  },
  {
    slug: 'storytelling',
    label: 'Stories',
    emoji: '📖',
    description:
      'Narrative stories WITH plot and characters: interactive ' +
      'fiction, bedtime tales, audio adventures, choose-your-own-' +
      'adventure. NOT for daily reports, news, weather, or Q&A ' +
      '(those are `voice`).',
  },
  {
    slug: 'kids',
    label: 'For Kids',
    emoji: '🧒',
    description:
      'Apps that EXPLICITLY target children: the words kids / ' +
      "children / 'for curious minds' / bedtime / 'learning for kids' " +
      'must appear in the name or description, OR the app must be ' +
      'obviously kid-targeted. Combines with `storytelling`, `voice`, ' +
      'or `games`. Lifestyle, sports, weather, generic personality / ' +
      'narration / fun framings are NOT kids.',
  },
  {
    slug: 'games',
    label: 'Games & Play',
    emoji: '🎮',
    description:
      'Apps with a play loop: scores, rounds, win/lose conditions, ' +
      'quizzes, puzzles, sports simulations, dice/oracles (magic ' +
      '8-ball), arcade-style mini-games.',
  },
  {
    slug: 'vision',
    label: 'Vision & Camera',
    emoji: '👁️',
    description:
      "Apps where Reachy's camera DRIVES behaviour: face/hand/pose " +
      'tracking, image classification, gesture detection, visual ' +
      'mimicry. Merely streaming or displaying the camera feed ' +
      '(WebRTC demos, remote-control viewers) is NOT vision.',
  },
  {
    slug: 'companion',
    label: 'Companion',
    emoji: '🤝',
    description:
      'Apps with an EXPLICIT emotional / personality / buddy framing ' +
      'in the name or description (companion, buddy, friend, mood, ' +
      'emotional, personality, pet, Tamagotchi-like, "alive", ' +
      '"life companion"). Being friendly is not enough.',
  },
  {
    slug: 'dev-tools',
    label: 'Dev & Demos',
    emoji: '🛠️',
    description:
      'RESERVED slug - see DECISION ALGORITHM step 1 in the prompt. ' +
      'Use ONLY for pure technical artefacts (debug utilities, SDK ' +
      'probes, minimal protocol demos, dev-only test spaces) with no ' +
      'end-user experience. When used, it is the SOLE category - ' +
      'never combined with another slug.',
  },
];

// ───────────────────────────────────────────────────────────────────
// Live taxonomy state
// ───────────────────────────────────────────────────────────────────
// The active taxonomy starts as the hardcoded default and is replaced
// in place by `loadTaxonomyFromDataset()` at boot. We keep the
// version as a mutable `export let` so consumers that imported it
// (e.g. categoryCache.js) observe the loaded value via the ES module
// live binding - they read it at runtime, after the loader has run.
let activeCategories = DEFAULT_CATEGORIES;
let activeAllowedSlugs = new Set(DEFAULT_CATEGORIES.map((c) => c.slug));
export let TAXONOMY_VERSION = DEFAULT_TAXONOMY_VERSION;

// Where the canonical, hand-editable taxonomy lives in the store
// dataset. Sibling of `config/official-app-list.json` / `config/blocked-app-list.json`.
const TAXONOMY_FILE_PATH = 'config/taxonomy.json';

export function isValidSlug(slug) {
  return activeAllowedSlugs.has(slug);
}

/**
 * Full taxonomy object (WITH descriptions) used to seed / mirror the
 * dataset file. Shape matches what `loadTaxonomyFromDataset()` parses.
 */
export function getFullTaxonomy() {
  return {
    version: TAXONOMY_VERSION,
    categories: activeCategories.map((c) => ({
      slug: c.slug,
      label: c.label,
      emoji: c.emoji,
      description: c.description,
    })),
  };
}

/**
 * Load the canonical taxonomy from the dataset's `config/taxonomy.json`
 * and swap it in over the hardcoded default. Best-effort: a missing
 * file, a 404, malformed JSON, or an empty list all keep the default
 * (so the server always has a working taxonomy). Call this ONCE at
 * boot, BEFORE loading the category cache (so the cache's stale-version
 * pruning compares against the live version).
 *
 * Returns true when the dataset taxonomy was applied, false when we
 * fell back to the default.
 */
export async function loadTaxonomyFromDataset(repoName, token) {
  const url = `https://huggingface.co/datasets/${repoName}/resolve/main/${TAXONOMY_FILE_PATH}`;
  try {
    const res = await fetch(url, {
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    });
    if (!res.ok) {
      console.log(
        `[Taxonomy] ${TAXONOMY_FILE_PATH} not found on ${repoName} ` +
          `(HTTP ${res.status}) - using built-in default (v${TAXONOMY_VERSION}).`,
      );
      return false;
    }
    const data = await res.json();
    const version = Number.isInteger(data?.version) ? data.version : null;
    const rawCats = Array.isArray(data?.categories) ? data.categories : null;
    if (version === null || !rawCats) {
      console.warn(
        `[Taxonomy] Malformed ${TAXONOMY_FILE_PATH} on ${repoName} - ` +
          `keeping built-in default (v${TAXONOMY_VERSION}).`,
      );
      return false;
    }
    const cleaned = [];
    const seen = new Set();
    for (const c of rawCats) {
      if (!c || typeof c.slug !== 'string') continue;
      const slug = c.slug.trim().toLowerCase();
      if (!slug || seen.has(slug)) continue;
      seen.add(slug);
      cleaned.push({
        slug,
        label: typeof c.label === 'string' && c.label.trim() ? c.label : slug,
        emoji: typeof c.emoji === 'string' ? c.emoji : '',
        description: typeof c.description === 'string' ? c.description : '',
      });
    }
    if (cleaned.length === 0) {
      console.warn(
        `[Taxonomy] ${TAXONOMY_FILE_PATH} has no valid categories - ` +
          `keeping built-in default (v${TAXONOMY_VERSION}).`,
      );
      return false;
    }
    activeCategories = cleaned;
    activeAllowedSlugs = new Set(cleaned.map((c) => c.slug));
    TAXONOMY_VERSION = version;
    console.log(
      `[Taxonomy] Loaded ${cleaned.length} categories (v${version}) from ` +
        `${repoName}/${TAXONOMY_FILE_PATH}.`,
    );
    return true;
  } catch (err) {
    console.warn(
      `[Taxonomy] Load failed (${err.message}) - keeping built-in ` +
        `default (v${TAXONOMY_VERSION}).`,
    );
    return false;
  }
}

/**
 * Public projection of the taxonomy meant to be shipped to clients
 * (mobile shell, website filter chips). We strip the `description`
 * field on purpose: it is sized + worded for the LLM prompt and
 * carries no UI value (clients render `label` + `emoji`). Render
 * order is the index in the active taxonomy, surfaced as `order` so a
 * client that needs to re-sort (e.g. alphabetical view) keeps the
 * canonical order one field-away.
 *
 * The shape is intentionally minimal and stable:
 * `{ slug, label, emoji, order }`. Adding optional fields later
 * (e.g. `color`, `shortLabel`) is forward-compatible; renaming or
 * dropping one is a breaking change for any client mirror.
 */
export function getPublicTaxonomy() {
  return activeCategories.map((c, index) => ({
    slug: c.slug,
    label: c.label,
    emoji: c.emoji,
    order: index,
  }));
}

/**
 * Render the taxonomy as a bulleted list for the LLM prompt.
 * Format mirrors what the model is asked to output (slug first)
 * to nudge it towards copying the exact string back.
 */
export function buildLlmCategoryList() {
  return activeCategories.map((c) => `- ${c.slug}: ${c.description}`).join('\n');
}

/**
 * Sanitize a raw LLM-returned list of slugs:
 * - drop non-strings
 * - lowercase + trim
 * - drop unknown slugs (hallucinations)
 * - dedupe while preserving order (the model orders by relevance)
 * - cap to MAX_CATEGORIES
 *
 * Returns a fresh array; never mutates input.
 */
export function sanitizeSlugs(raw, maxCategories = 3) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const v of raw) {
    if (typeof v !== 'string') continue;
    const slug = v.trim().toLowerCase();
    if (!slug || seen.has(slug)) continue;
    if (!activeAllowedSlugs.has(slug)) continue;
    seen.add(slug);
    out.push(slug);
    if (out.length >= maxCategories) break;
  }
  return out;
}
