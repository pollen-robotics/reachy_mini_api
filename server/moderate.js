/**
 * Content moderation for JS Reachy Mini apps surfaced in the mobile
 * catalog.
 *
 * Why this exists
 * ───────────────
 * The mobile shell embeds third-party Hugging Face Spaces in a
 * WebView iframe. Apple App Store guideline 1.2 (and the Google Play
 * UGC policy) require the host to *filter objectionable material*
 * before it reaches users. This module is the automated half of that
 * obligation; the manual half is the hand-edited `block-list.json`
 * killswitch on the official dataset (see `index.js`).
 *
 * Two-layer pipeline (`moderateApp`)
 * ──────────────────────────────────
 *   1. REGEX prescreen (synchronous, free): a tiny list of patterns
 *      that are objectionable 100% of the time regardless of context
 *      (explicit sexual content, CSAM signals, obvious scams). A hit
 *      is a hard block and short-circuits the LLM call.
 *   2. LLM classifier (HF Inference Providers, ~1 s, cached): for
 *      everything the regex doesn't catch, an 8B model returns a
 *      STRUCTURED verdict against a CLOSED policy taxonomy. We never
 *      ask it for a free-form judgment or a fuzzy score - the closed
 *      list keeps the output auditable (each block has a category +
 *      reason a reviewer can be shown) and stable.
 *
 * Three outcomes, not two
 * ───────────────────────
 * The verdict `decision` is one of `allow` | `block` | `review`.
 * `review` (the LLM is unsure) stays visible in `open` mode but is
 * flagged so it can be triaged / killswitched, and is hidden in
 * `allowlist` mode. This avoids both over-blocking and over-exposing.
 *
 * Robustness contract
 * ───────────────────
 * `moderateApp` NEVER throws on transient failure (network, 429,
 * malformed JSON). It returns `null`, which the cache layer reads as
 * "not yet moderated; retry next pass" (fail-open: an upstream hiccup
 * never empties the catalog - the regex layer + manual killswitch
 * remain the backstops). Hard errors (HF_TOKEN missing) throw
 * `HfTokenMissingError` so the caller can short-circuit the batch.
 *
 * This mirrors `categorize.js` on purpose: same HF Inference path,
 * same README fetch/clean (imported, not duplicated), same JSON
 * extraction, same caching shape. Keep the two in sync when one
 * evolves.
 */

import { cleanReadme, fetchSpaceReadme, HfTokenMissingError } from './categorize.js';

export { HfTokenMissingError };

const HF_INFERENCE_URL = 'https://router.huggingface.co/v1/chat/completions';
const DEFAULT_MODEL = 'meta-llama/Llama-3.1-8B-Instruct';

const README_MAX_CHARS = 3000;
const LLM_TIMEOUT_MS = 30_000;
const LLM_MAX_TOKENS = 120;
const LLM_TEMPERATURE = 0;

// Bump when the regex list or the LLM prompt changes in a way that
// should re-moderate the whole catalog. The cache drops entries from
// an older policy version on load (see `moderationCache.js`), exactly
// like the taxonomy version gate in the category cache.
export const MODERATION_POLICY_VERSION = 1;

// Closed policy taxonomy. The LLM MUST pick exactly one. `none` is
// the "clean" outcome. Anything else maps to a block/review action in
// `decisionForCategory()`.
export const POLICY_CATEGORIES = [
  'sexual', // pornographic / explicit sexual content
  'hate', // hate speech, harassment, slurs targeting a protected group
  'violence', // graphic violence, gore, glorification of violence
  'illegal', // illegal goods/acts, weapons, drugs marketplace
  'scam_malware', // phishing, wallet drainers, malware, deceptive money grabs
  'self_harm', // promotion of self-harm / suicide / eating disorders
  'none', // nothing objectionable
];

const HARD_CATEGORIES = new Set(['sexual', 'hate', 'illegal', 'self_harm']);

// =====================================================================
// Layer 1 - regex prescreen
// =====================================================================
//
// KEEP THIS LIST SMALL AND UNAMBIGUOUS. Only patterns that are
// objectionable in EVERY context belong here - the regex layer has no
// notion of nuance, so any ambiguous word ("kill", "shoot", "drug")
// would generate false positives on perfectly fine apps (games, dev
// tools). Nuance is the LLM's job (layer 2). The team should extend
// the hate-term list from a maintained lexicon rather than inline.
const HARD_PATTERNS = [
  {
    category: 'sexual',
    re: /\b(porn(?:hub)?|xxx+|hentai|camgirl|onlyfans|nudify|deepnude|sexcam|escort\s+service)\b/i,
  },
  {
    // CSAM signals: age-of-minor token co-occurring with explicit
    // sexual token. Deliberately narrow to avoid flagging "kids"
    // apps; a match here is always a hard block.
    category: 'illegal',
    re: /\b(child|underage|minor|preteen|loli(?:con)?)\b[\s\S]{0,40}\b(porn|nude|sex|nsfw)\b/i,
  },
  {
    category: 'scam_malware',
    re: /\b(free\s+(?:robux|v-?bucks|bitcoin|crypto|gift\s*cards?)|seed\s+phrase|wallet\s+drainer|private\s+key\s+generator)\b/i,
  },
  {
    category: 'violence',
    re: /\b(gore|beheading|snuff\s+film|execution\s+video)\b/i,
  },
];

/**
 * Run the regex prescreen against the app's text. Returns a hard-block
 * verdict on the first hit, or `null` when nothing matches (the caller
 * then falls through to the LLM).
 *
 * Synchronous and free - safe to run on every app before deciding
 * whether an LLM call is even needed.
 */
export function regexPrescreen({ name, description, readme }) {
  const haystack = `${name || ''}\n${description || ''}\n${readme || ''}`;
  for (const { category, re } of HARD_PATTERNS) {
    if (re.test(haystack)) {
      return {
        decision: 'block',
        category,
        reason: `regex hard-block: matched ${category} pattern`,
        severity: 'hard',
        source: 'regex',
        policyVersion: MODERATION_POLICY_VERSION,
      };
    }
  }
  return null;
}

/**
 * Map a closed-taxonomy category to a default action when the LLM
 * returns a category but an unexpected/absent `decision`. Hard
 * categories block; the softer ones (violence, scam_malware) also
 * block but at `soft` severity; `none` allows.
 */
function decisionForCategory(category) {
  if (category === 'none') return { decision: 'allow', severity: null };
  if (HARD_CATEGORIES.has(category)) return { decision: 'block', severity: 'hard' };
  return { decision: 'block', severity: 'soft' };
}

// =====================================================================
// Layer 2 - LLM classifier
// =====================================================================

function buildMessages({ name, description, readme }) {
  const categories = POLICY_CATEGORIES.join(', ');
  const system = `You are a content-safety classifier for a GENERAL-AUDIENCE (12+) catalog of small robot apps. Each app is a web page embedded in a companion app for a desk robot.

OUTPUT FORMAT
Return ONLY a single JSON object, no prose, no code fences:
{"decision": "allow"|"block"|"review", "category": "<one slug>", "reason": "<short>"}

CATEGORY (pick EXACTLY ONE slug from this closed list)
${categories}

DECISION RULES
- "block": the app clearly contains or promotes objectionable
  material: pornographic/explicit sexual content (sexual), hate
  speech or harassment (hate), graphic violence/gore (violence),
  illegal goods/acts incl. anything sexualizing minors (illegal),
  phishing/malware/deceptive money grabs (scam_malware), promotion
  of self-harm or suicide (self_harm).
- "allow": ordinary robot apps - games, music, dancing, storytelling,
  companions, voice assistants, vision demos, dev tools, education.
  Edgy-but-harmless humor is allowed. Use category "none".
- "review": you genuinely cannot tell from the text whether it is
  appropriate (ambiguous, too little signal, mixed). Pick the most
  likely category and let a human decide.

IMPORTANT
- Do NOT block an app just for being technical, weird, or low-quality.
- "kids", "children", "bedtime" framing is a NORMAL audience, not a
  red flag, UNLESS combined with sexual/abusive content.
- Judge the app's PURPOSE, not isolated words.

Return the JSON now.`;

  const user =
    `App name: ${name || '(unknown)'}\n` +
    `Short description: ${description || '(none)'}\n\n` +
    `README excerpt:\n${readme || '(no README available)'}\n\n` +
    'Classify it.';

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/**
 * Best-effort JSON extraction - grabs the first balanced `{...}`
 * block and parses it. Mirrors the extractor in `categorize.js`
 * because some 8B providers still wrap the answer in fences.
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
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

async function callLlm({ messages, model, signal }) {
  const token = process.env.HF_TOKEN;
  if (!token) throw new HfTokenMissingError();

  const body = {
    model,
    messages,
    temperature: LLM_TEMPERATURE,
    max_tokens: LLM_MAX_TOKENS,
    response_format: { type: 'json_object' },
  };

  let res;
  try {
    res = await fetch(HF_INFERENCE_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    console.warn(`[moderate] LLM fetch failed: ${err.message}`);
    return null;
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    console.warn(`[moderate] LLM HTTP ${res.status}: ${detail.slice(0, 200)}`);
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
 * Normalize a raw LLM object into a validated verdict, or `null` if
 * it's unusable (so the caller treats it as a transient miss).
 */
function normalizeVerdict(obj) {
  if (!obj || typeof obj !== 'object') return null;
  let category = typeof obj.category === 'string' ? obj.category.trim() : '';
  if (!POLICY_CATEGORIES.includes(category)) category = '';
  let decision = typeof obj.decision === 'string' ? obj.decision.trim() : '';
  if (!['allow', 'block', 'review'].includes(decision)) decision = '';

  // If the model gave a category but no usable decision, derive it.
  if (!decision && category) {
    decision = decisionForCategory(category).decision;
  }
  if (!decision) return null;
  if (!category) category = decision === 'allow' ? 'none' : 'none';

  const severity =
    decision === 'block'
      ? decisionForCategory(category).severity || 'soft'
      : null;
  const reason =
    typeof obj.reason === 'string' && obj.reason.trim()
      ? obj.reason.trim().slice(0, 200)
      : `llm: ${decision}/${category}`;

  return {
    decision,
    category,
    reason,
    severity,
    source: 'llm',
    policyVersion: MODERATION_POLICY_VERSION,
  };
}

/**
 * Public entry point. Returns a verdict object:
 *   { decision, category, reason, severity, source, policyVersion }
 * or `null` on transient failure (retry next pass).
 *
 * Official apps should be skipped by the caller (they are curated by
 * Pollen and don't need moderating) - this keeps LLM load down and
 * avoids false positives on first-party content.
 */
export async function moderateApp({
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
    const readme = cleanReadme(rawReadme).slice(0, README_MAX_CHARS);

    // Layer 1: free, deterministic. A hit short-circuits the LLM.
    const regexVerdict = regexPrescreen({ name, description, readme });
    if (regexVerdict) return regexVerdict;

    // Layer 2: LLM nuance.
    const messages = buildMessages({ name, description, readme });
    const reply = await callLlm({ messages, model, signal: ctrl.signal });
    if (reply == null) return null;

    const verdict = normalizeVerdict(extractJsonObject(reply));
    if (!verdict) {
      console.warn(
        `[moderate] ${spaceId}: malformed LLM reply (truncated): ${reply.slice(0, 120)}`,
      );
      return null;
    }
    return verdict;
  } finally {
    clearTimeout(timeoutId);
  }
}
