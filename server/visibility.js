/**
 * Pure visibility decision for the mobile JS-app catalog.
 *
 * Split out of `index.js` so the fail-closed policy - the load-bearing
 * App Store guideline 1.2 logic - is unit-testable without booting the
 * Express server (importing `index.js` calls `app.listen`).
 *
 * Fail-closed contract
 * ────────────────────
 * An app is visible in the mobile catalog ONLY when one of:
 *   - it is a curated official app (moderation skipped), or
 *   - it carries an explicit `allow` moderation verdict.
 *
 * Everything else is hidden:
 *   - `isBlocked` (manual block-list killswitch) -> hidden,
 *   - `block` verdict (clear violation)          -> hidden,
 *   - `review` verdict (LLM unsure)              -> hidden,
 *   - no verdict yet (cold / pending)            -> hidden.
 *
 * The consequence is that a brand-new Space never appears before the
 * regex+LLM pipeline has explicitly cleared it, and a transient LLM
 * outage (or a missing HF_TOKEN) keeps unmoderated apps out of the
 * catalog rather than leaking them.
 */

/**
 * @typedef {Object} ModerationVerdict
 * @property {'allow'|'block'|'review'} decision
 * @property {string|null} [category]
 * @property {string} [reason]
 * @property {string} [source]
 */

/**
 * @typedef {Object} VisibilityResult
 * @property {boolean} visible
 * @property {string} source
 * @property {'allow'|'block'|'review'} decision
 * @property {string|null} category
 * @property {string} reason
 */

/**
 * Decide whether a JS app is visible, and why.
 *
 * @param {{isBlocked?: boolean, isOfficial?: boolean}} app
 * @param {ModerationVerdict|null|undefined} verdict cached moderation
 *        verdict for `app`, or null/undefined when none exists yet.
 * @returns {VisibilityResult}
 */
export function decideVisibility(app, verdict) {
  if (app.isBlocked) {
    return {
      visible: false,
      source: 'blocklist',
      decision: 'block',
      category: null,
      reason: 'manual block-list',
    };
  }

  if (app.isOfficial) {
    return {
      visible: true,
      source: 'official',
      decision: 'allow',
      category: 'none',
      reason: 'official app (moderation skipped)',
    };
  }

  if (verdict) {
    return {
      // Fail-closed: only an explicit `allow` is visible. `block` and
      // `review` (LLM unsure) are both quarantined.
      visible: verdict.decision === 'allow',
      source: verdict.source || 'llm',
      decision: verdict.decision,
      category: verdict.category ?? null,
      reason: verdict.reason,
    };
  }

  // No verdict yet (cold / pending classification) - fail closed:
  // hide until the moderation batch has explicitly cleared the app.
  return {
    visible: false,
    source: 'pending',
    decision: 'review',
    category: null,
    reason: 'awaiting moderation (fail-closed)',
  };
}
