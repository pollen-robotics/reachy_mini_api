/**
 * LLM-based category inference for JS Reachy Mini apps.
 *
 * Pipeline (`categorizeApp`)
 * ──────────────────────────
 *   1. Fetch the Space's README from HF Hub (raw)
 *   2. Strip frontmatter, images, badges, raw HTML, then truncate
 *   3. Call a chat LLM via HF Inference Providers (OpenAI-compatible)
 *      with the predefined taxonomy + the app's name/description
 *   4. Parse JSON, validate against ALLOWED_SLUGS, keep up to 3
 *
 * Robustness contract
 * ───────────────────
 * `categorizeApp` NEVER throws on transient failure (network,
 * 429, malformed JSON). It returns `null`, which the cache layer
 * interprets as "not yet categorized; retry on the next pass".
 * Hard errors (HF_TOKEN missing) are signalled by a thrown
 * `HfTokenMissingError` so the caller can short-circuit the
 * whole batch.
 */

import {
  buildLlmCategoryList,
  sanitizeSlugs,
} from './categories.js';

// HF Inference Providers - OpenAI-compatible router. Auto-routes
// the request to whichever provider currently serves the model
// (Together, Nebius, Fireworks, Sambanova...). The token must
// have `Inference Providers` access (default for all PRO and
// most FREE tokens since 2025).
const HF_INFERENCE_URL = 'https://router.huggingface.co/v1/chat/completions';

// 8B model: cheap, fast (~1 s per call), more than enough for a
// closed-list multi-label classification with good descriptions.
// If quality drifts we can swap to 70B without touching anything
// else - the prompt is generic.
const DEFAULT_MODEL = 'meta-llama/Llama-3.1-8B-Instruct';

// README budget
const README_MAX_CHARS = 3000;

// Single-label classification: each app gets EXACTLY ONE slug -
// the dominant one. The shape stays `string[]` for forward
// compatibility (if we ever revert to multi-label, no API break),
// but the array always contains 0 or 1 entry. Mobile chips and
// "swipers per category" thus surface each app once and only once.
const MAX_CATEGORIES_PER_APP = 1;

// LLM call budget
const LLM_TIMEOUT_MS = 30_000;
const LLM_MAX_TOKENS = 120;
const LLM_TEMPERATURE = 0;

export class HfTokenMissingError extends Error {
  constructor() {
    super('HF_TOKEN env var is not set; cannot call HF Inference Providers.');
    this.name = 'HfTokenMissingError';
  }
}

/**
 * Fetch a Space's README from HF Hub. Returns the raw markdown
 * string, or `null` if the request fails (404, network, etc.) -
 * the caller falls back to "name + description only" in that case,
 * which is still enough signal for the LLM on most apps.
 */
export async function fetchSpaceReadme(spaceId, { signal } = {}) {
  if (!spaceId || typeof spaceId !== 'string') return null;
  // The README of a HF Space lives at /spaces/<id>/raw/main/README.md.
  // The `raw` endpoint returns the file as-is (no Hub UI wrapping)
  // and is anonymous-friendly, so no auth is needed here.
  const url = `https://huggingface.co/spaces/${spaceId}/raw/main/README.md`;
  try {
    const res = await fetch(url, { signal });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

/**
 * Lightly clean a raw README so the LLM doesn't burn tokens on
 * boilerplate (HF frontmatter, badges, images) and so the actual
 * prose surfaces above the truncation budget.
 *
 * We keep transformations conservative: we never edit the
 * surrounding prose, we just delete decorative tokens. Anything
 * cosmetic-only that clearly isn't signal for classification
 * (badges, images, raw HTML).
 */
export function cleanReadme(raw) {
  if (!raw || typeof raw !== 'string') return '';
  let txt = raw;

  // 1. Strip the YAML frontmatter at the very top (HF Spaces
  //    ship a mandatory `---\n...metadata...\n---` block whose
  //    fields are already exposed to us via the catalog payload,
  //    so feeding them to the LLM is pure noise).
  txt = txt.replace(/^---\n[\s\S]*?\n---\n?/, '');

  // 2. Drop image markdown (`![alt](url)`) and HTML <img> tags.
  //    Vision apps tend to load up READMEs with screenshots and
  //    GIFs; the alt text is sometimes useful but more often it's
  //    "demo.gif" - low signal/noise ratio.
  txt = txt.replace(/!\[[^\]]*\]\([^)]+\)/g, '');
  txt = txt.replace(/<img\b[^>]*>/gi, '');

  // 3. Strip shields.io / GitHub badges (markdown links that
  //    wrap an image). They survive (2) only when nested.
  txt = txt.replace(/\[!\[[^\]]*\]\([^)]+\)\]\([^)]+\)/g, '');

  // 4. Generic HTML stripping. Most READMEs are pure markdown,
  //    but some authors embed `<details>`, `<sub>`, `<center>`
  //    blocks. Keep the inner text, drop the tags.
  txt = txt.replace(/<\/?[a-zA-Z][^>]*>/g, '');

  // 5. Collapse runs of blank lines so trimming doesn't waste
  //    tokens on the gap.
  txt = txt.replace(/\n{3,}/g, '\n\n');

  // 6. Truncate. We slice at the paragraph boundary closest to
  //    the budget so we don't end mid-sentence.
  if (txt.length > README_MAX_CHARS) {
    const cut = txt.lastIndexOf('\n\n', README_MAX_CHARS);
    txt = txt.slice(0, cut > README_MAX_CHARS / 2 ? cut : README_MAX_CHARS);
  }

  return txt.trim();
}

/**
 * Few-shot examples woven into the system prompt.
 *
 * Each entry encodes a pitfall the v1 prompt fell into during the
 * 24-app eval (see `scripts/evaluate-prompt-v2.py`). Keep this list
 * tight - past ~10 examples the model starts pattern-matching
 * literally on the example names rather than applying the rules.
 *
 * Format: [name, description, expected_slugs, brief_justification]
 */
const FEW_SHOT_EXAMPLES = [
  [
    'Reachy Morse',
    "Send Morse code through Reachy's speaker.",
    ['dev-tools'],
    '(STEP 1 veto: pure technical artefact. NOT music.)',
  ],
  [
    'WebRTC Demo',
    'Minimal WebRTC connection between Reachy and the browser.',
    ['dev-tools'],
    '(STEP 1 veto: protocol demo. NOT vision.)',
  ],
  [
    'TTS Reachy Mini',
    "Browser TTS that plays out of Reachy Mini's speaker.",
    ['voice'],
    '(USER-FACING speech output is voice, NOT dev-tools.)',
  ],
  [
    'Reachy Mochi - Emotional Companion',
    'Your pocket buddy that develops a mood and personality over time.',
    ['companion'],
    '(explicit emotional/companion framing)',
  ],
  [
    'Reachy Alive',
    '(README empty; name suggests autonomy and life-like presence)',
    ['companion'],
    "(USE THE NAME when the README is empty; 'alive' = companion-like)",
  ],
  [
    'Daily Surf Report',
    "Reachy reads today's surf report out loud.",
    ['voice'],
    '(NOT storytelling - a report has no narrative arc. ' +
      'NOT kids - surfing/sports are not kid-targeted.)',
  ],
  [
    'Music Quiz',
    'Play a blind test music game with a dancing Reachy.',
    ['music'],
    '(single dominant slug - music wins over games because the app ' +
      "is primarily a music blind-test; the dancing is a side effect " +
      'of the music and is captured by `music` too)',
  ],
  [
    'Mime Bot',
    'Reachy mimics your face live from your webcam.',
    ['vision'],
    '(NOT companion - mimicry is visual, no emotional framing.)',
  ],
];

function renderFewShot() {
  return FEW_SHOT_EXAMPLES.map(([name, desc, slugs, hint]) => {
    const slugsJson = JSON.stringify(slugs);
    return (
      `  - ${JSON.stringify(name)}: ${JSON.stringify(desc)}\n` +
      `    → {"categories": ${slugsJson}}   ${hint}`
    );
  }).join('\n');
}

/**
 * Build the chat messages handed to the LLM.
 *
 * The system prompt is structured as a 3-step DECISION ALGORITHM
 * rather than a flat list of rules, because the 8B-class model we
 * use (Llama-3.1-8B-Instruct) follows imperative procedures more
 * reliably than soft constraints. The `dev-tools` veto in STEP 1
 * is what stops the model from silently combining it with other
 * slugs on user-facing apps.
 *
 * The few-shot examples below the rules cover the v1 pitfalls
 * (companion hallucinations, music-on-audio, kids-on-personas,
 * storytelling-on-reports). Six is the sweet spot - more starts
 * over-fitting on example wording.
 */
function buildMessages({ name, description, readme }) {
  const taxonomy = buildLlmCategoryList();
  const examples = renderFewShot();
  const system = `You classify a Reachy Mini robot app into a CLOSED list of categories.

OUTPUT FORMAT
Return ONLY a single JSON object: {"categories": ["slug"]}.
Pick EXACTLY ONE slug - the single dominant category that best
captures the app's primary identity. Use the EXACT slug. The list
always contains 0 or 1 entry.
No prose, no code fences, no commentary outside the JSON.

DECISION ALGORITHM (apply in order)

STEP 1 - \`dev-tools\` veto
Is this app a PURE technical artefact with no user-facing experience
beyond "here is how the SDK / API works"?
Examples that pass the veto: WebRTC demo, SDK probe, debug utility,
raw remote-control interface, dev-only test space.
Examples that DO NOT pass the veto (they are user-facing apps):
TTS players, voice chat, music apps, storytelling, companions -
even when the README is dev-heavy.
  - YES -> return {"categories": ["dev-tools"]} and STOP.
  - NO  -> continue to STEP 2.

STEP 2 - Pick the SINGLE most dominant user-facing slug from the list
below. Choose the slug that captures the app's primary identity, not
every aspect it touches. When two slugs feel equally fitting, pick the
one that a user would name FIRST when describing the app in one word.
Examples of tie-breaks:
  - music-driven dance party (Reachy dances to a song) -> \`music\`.
    The music is what drives the experience.
  - pure choreography / marionette / motion replay without music ->
    \`motion\`. The movement is the experience.
  - storytelling + kids app -> prefer \`kids\` if it explicitly targets
    children, \`storytelling\` otherwise.
  - vision + games app -> prefer \`games\` if there is a play loop,
    \`vision\` if it is mostly a perception demo.
If the README is empty or very sparse, USE THE NAME AND DESCRIPTION
as the primary signal - do not bail to an empty list just because the
README is thin.

STEP 3 - Strict slug rules (each must hold, or DO NOT use the slug)
- \`companion\`: requires EXPLICIT emotional / personality / buddy
  framing (companion, buddy, friend, mood, emotional, personality,
  pet, Tamagotchi-like, "alive", "life companion"). Being friendly is
  not enough.
- \`music\`: requires actual music - rhythm, melody, songs, beats, DJ
  sets, instruments, music quizzes. Arbitrary audio (Morse, alarms,
  TTS, sound effects) is NOT music.
- \`vision\`: requires the camera to DRIVE behaviour (tracking,
  classification, mimicry). Merely streaming or displaying the camera
  (WebRTC demos, remote-control viewers) is NOT vision.
- \`storytelling\`: requires a narrative ARC - plot, characters, scenes.
  Daily reports, news, weather, Q&A are NOT storytelling (they are
  \`voice\`).
- \`games\`: requires a play loop - score, rounds, win/lose, puzzles,
  quizzes, dice/oracles, sports simulations.
- \`kids\`: requires kid-targeted framing (kids/children/curious minds/
  bedtime/learning for kids) in the name or description. Lifestyle,
  sports, weather, general conversation are NOT kids.

AVAILABLE CATEGORIES
${taxonomy}

REFERENCE EXAMPLES
${examples}

Do not include any text outside the JSON object.`;

  const user =
    `App name: ${name || '(unknown)'}\n` +
    `Short description: ${description || '(none)'}\n\n` +
    `README excerpt:\n${readme || '(no README available)'}\n\n` +
    'Return the JSON now.';

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/**
 * Best-effort JSON extraction. Some 8B models still wrap the
 * answer in ``` fences or prepend "Sure, here you go:". We grab
 * the first balanced `{...}` block and parse that.
 */
function extractJsonObject(text) {
  if (!text || typeof text !== 'string') return null;
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        const slice = text.slice(start, i + 1);
        try {
          return JSON.parse(slice);
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/**
 * Call the HF Inference Providers chat endpoint. Returns the
 * raw assistant message string, or `null` on any error.
 */
async function callLlm({ messages, model, signal }) {
  const token = process.env.HF_TOKEN;
  if (!token) throw new HfTokenMissingError();

  const body = {
    model,
    messages,
    temperature: LLM_TEMPERATURE,
    max_tokens: LLM_MAX_TOKENS,
    // `response_format` is honoured by some providers (Nebius,
    // Together) but ignored by others. It's a free upgrade when
    // present, harmless otherwise; the JSON-extractor below is
    // the real safety net.
    response_format: { type: 'json_object' },
  };

  let res;
  try {
    res = await fetch(HF_INFERENCE_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    console.warn(`[categorize] LLM fetch failed: ${err.message}`);
    return null;
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    console.warn(
      `[categorize] LLM HTTP ${res.status}: ${detail.slice(0, 200)}`,
    );
    return null;
  }

  let json;
  try {
    json = await res.json();
  } catch {
    return null;
  }
  return json?.choices?.[0]?.message?.content ?? null;
}

/**
 * Public entry point.
 *
 * Returns a string[] of validated slugs (0-3 items), or `null`
 * on transient failure so the caller can mark the entry "needs
 * retry" without writing a misleading empty list.
 *
 * Treat an empty array `[]` as "the LLM looked and concluded
 * none fit" - that's a valid, cacheable outcome.
 */
export async function categorizeApp({
  name,
  description,
  spaceId,
  model = DEFAULT_MODEL,
} = {}) {
  if (!spaceId) return null;

  const ctrl = new AbortController();
  const timeoutId = setTimeout(() => ctrl.abort(), LLM_TIMEOUT_MS);

  try {
    const rawReadme = await fetchSpaceReadme(spaceId, { signal: ctrl.signal });
    const readme = cleanReadme(rawReadme);

    const messages = buildMessages({ name, description, readme });
    const reply = await callLlm({ messages, model, signal: ctrl.signal });
    if (reply == null) return null;

    const obj = extractJsonObject(reply);
    if (!obj || !Array.isArray(obj.categories)) {
      console.warn(
        `[categorize] ${spaceId}: malformed LLM reply (truncated): ` +
          `${reply.slice(0, 120)}`,
      );
      return null;
    }
    return sanitizeSlugs(obj.categories, MAX_CATEGORIES_PER_APP);
  } finally {
    clearTimeout(timeoutId);
  }
}
