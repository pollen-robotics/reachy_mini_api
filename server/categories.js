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
 * Bump this when the slug list OR the descriptions change in a way
 * that affects the LLM output. The cache layer invalidates entries
 * whose taxonomyVersion is older than this and reclassifies them on
 * the next pass. We don't bump it for cosmetic edits (label / emoji)
 * since those don't reach the LLM.
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
 */
export const TAXONOMY_VERSION = 4;

/**
 * Canonical category list. Keep slugs short, kebab-case, and
 * memorable: they end up in URLs (e.g. `?cat=music`) and in
 * filter chips on mobile.
 *
 * The `description` field is the SOLE source of truth the LLM
 * sees - keep them factual, scope-bounded, and example-led so
 * the model has signal for both inclusion and exclusion.
 */
export const CATEGORIES = [
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

export const ALLOWED_SLUGS = new Set(CATEGORIES.map((c) => c.slug));

export function isValidSlug(slug) {
  return ALLOWED_SLUGS.has(slug);
}

/**
 * Public projection of the taxonomy meant to be shipped to clients
 * (mobile shell, website filter chips). We strip the `description`
 * field on purpose: it is sized + worded for the LLM prompt and
 * carries no UI value (clients render `label` + `emoji`). Render
 * order is the index in `CATEGORIES`, surfaced as `order` so a
 * client that needs to re-sort (e.g. alphabetical view) keeps the
 * canonical order one field-away.
 *
 * The shape is intentionally minimal and stable:
 * `{ slug, label, emoji, order }`. Adding optional fields later
 * (e.g. `color`, `shortLabel`) is forward-compatible; renaming or
 * dropping one is a breaking change for any client mirror.
 */
export function getPublicTaxonomy() {
  return CATEGORIES.map((c, index) => ({
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
  return CATEGORIES.map((c) => `- ${c.slug}: ${c.description}`).join('\n');
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
    if (!ALLOWED_SLUGS.has(slug)) continue;
    seen.add(slug);
    out.push(slug);
    if (out.length >= maxCategories) break;
  }
  return out;
}
