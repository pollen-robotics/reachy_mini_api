/**
 * Mint per-user OpenAI Realtime ephemeral session keys.
 *
 * Why this module exists
 * ----------------------
 * The Reachy Mini mobile shell historically baked a long-lived
 * OpenAI API key into the bundle (`VITE_OPENAI_API_KEY`), which
 * violates OpenAI's terms of service and leaks the key the moment
 * anyone extracts the IPA/APK. This module is the server-side
 * replacement:
 *
 *   - The master `OPENAI_API_KEY` stays in this Space's secrets,
 *     never reachable by any client.
 *   - The mobile shell asks for a short-lived (~1 minute)
 *     `client_secret.value` per voice conversation, signed with
 *     the user's Hugging Face token so we can identify + rate-limit
 *     per HF user.
 *   - Each ephemeral key is scoped to a single OpenAI Realtime
 *     session, so a leak only loses ~60 seconds of model access.
 *
 * Wire format (matches OpenAI's Realtime API)
 * -------------------------------------------
 *   POST /api/openai/ephemeral
 *   Authorization: Bearer <hf_token>
 *   Content-Type: application/json
 *   Body: { "model"?: string, "voice"?: string }
 *
 *   200 -> the full payload from
 *          `POST https://api.openai.com/v1/realtime/client_secrets`,
 *          forwarded as-is. The client uses `payload.value` (the
 *          `ek_…` ephemeral token) for the `POST /v1/realtime/calls`
 *          WebRTC handshake.
 *   401 -> missing/invalid HF token
 *   429 -> per-user rate limit hit
 *   502 -> OpenAI upstream failed (key bad, model down, ...)
 *   503 -> OPENAI_API_KEY missing on the Space
 *
 * Why we trust HF for auth
 * ------------------------
 * The mobile shell already requires a Hugging Face sign-in to
 * pair with a Reachy Mini robot, so the HF token is a free
 * identity primitive: every legitimate caller already has one,
 * and HF can revoke it from their side. We resolve the token via
 * `whoami-v2` once per 5 minutes (cached) and use the returned
 * `name` as the rate-limit bucket key.
 */

// GA endpoint. The legacy Beta endpoint
// (`POST /v1/realtime/sessions`) was retired on 2026-05-07
// alongside the `OpenAI-Beta: realtime=v1` header, and only
// accepted preview models (`gpt-4o-realtime-preview-*`). The GA
// endpoint takes a `session` envelope with a required `type`
// discriminator and returns the ephemeral key at the top level
// (`{ value, expires_at, session }`).
const OPENAI_CLIENT_SECRETS_URL =
  'https://api.openai.com/v1/realtime/client_secrets';
const HF_WHOAMI_URL = 'https://huggingface.co/api/whoami-v2';

// In-memory whoami cache. HF's whoami round-trip is ~150ms, and
// caching it keeps the mint endpoint snappy without breaking
// revocation in practice: HF's own token-revocation cache is
// already eventually consistent, and our 5-minute staleness sits
// well inside that.
const whoamiCache = new Map();
const WHOAMI_TTL_MS = 5 * 60 * 1000;

// In-memory rate limiter. Per-user sliding window over 1 hour.
// HF Spaces typically restart every deploy, so the limiter
// implicitly resets then; that's acceptable for v1. If we ever
// need durability or multi-replica fairness, swap the Map for a
// shared KV (Redis, Upstash, ...) without changing the rest of
// the module.
const rateLimits = new Map();
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

const DEFAULT_RATE_LIMIT_PER_HOUR = 60;
// Match what the Reachy Mini mobile shell is built against today
// (`features/conversation/engine/settings.ts:DEFAULT_MODEL` and
// `DEFAULT_VOICE`). Bumping these requires coordinating with the
// mobile client because the GA WebRTC handshake (`/v1/realtime/calls`)
// negotiates the session shape against this same configuration.
const DEFAULT_REALTIME_MODEL = 'gpt-realtime-2';
const DEFAULT_REALTIME_VOICE = 'cedar';

function getRateLimitMax() {
  const raw = process.env.OPENAI_EPHEMERAL_RATE_LIMIT_PER_HOUR;
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_RATE_LIMIT_PER_HOUR;
}

function getDefaultModel() {
  const raw = process.env.OPENAI_REALTIME_MODEL;
  return raw && raw.trim() !== '' ? raw.trim() : DEFAULT_REALTIME_MODEL;
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * Resolve `Bearer <token>` -> the HF user object, with a 5-minute
 * cache. Throws `HttpError(401)` on a rejected token so the route
 * can surface a clean 401 to the caller.
 */
async function verifyHfToken(token) {
  const now = Date.now();
  const cached = whoamiCache.get(token);
  if (cached && cached.exp > now) return cached.user;

  let r;
  try {
    r = await fetch(HF_WHOAMI_URL, {
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch (err) {
    // Network blip: surface a 502 so the client can retry. We
    // explicitly do NOT cache a failure, so a transient outage
    // doesn't lock the user out for 5 minutes.
    throw new HttpError(502, `hf whoami network error: ${err.message}`);
  }

  if (r.status === 401 || r.status === 403) {
    throw new HttpError(401, 'invalid hf token');
  }
  if (!r.ok) {
    throw new HttpError(502, `hf whoami returned ${r.status}`);
  }

  const user = await r.json().catch(() => null);
  // `name` is the canonical HF identifier across users + orgs;
  // `id` is the numeric backstop in case the schema ever shifts.
  if (
    !user ||
    (typeof user.name !== 'string' && typeof user.id !== 'string')
  ) {
    throw new HttpError(502, 'hf whoami returned malformed user');
  }

  whoamiCache.set(token, { user, exp: now + WHOAMI_TTL_MS });
  return user;
}

/**
 * Enforce the sliding-window rate limit for `userId`. Throws
 * `HttpError(429)` on overflow. Mutates `rateLimits` to record
 * the current mint timestamp.
 */
function checkRateLimit(userId) {
  const now = Date.now();
  const windowStart = now - RATE_LIMIT_WINDOW_MS;
  const history = rateLimits.get(userId) || [];
  const recent = history.filter((t) => t > windowStart);
  if (recent.length >= getRateLimitMax()) {
    throw new HttpError(
      429,
      `rate limit exceeded (${getRateLimitMax()}/hour)`,
    );
  }
  recent.push(now);
  rateLimits.set(userId, recent);
}

/**
 * Express handler for `POST /api/openai/ephemeral`. Stateless from
 * the caller's perspective: the client posts an HF Bearer token,
 * gets back the OpenAI Realtime session payload, uses it once.
 */
export async function mintEphemeralKeyHandler(req, res) {
  try {
    if (!process.env.OPENAI_API_KEY) {
      return res
        .status(503)
        .json({ error: 'OPENAI_API_KEY not configured on this Space' });
    }

    const auth = req.headers.authorization || '';
    const match = auth.match(/^Bearer\s+(.+)$/i);
    if (!match) {
      return res.status(401).json({ error: 'missing bearer token' });
    }
    const hfToken = match[1].trim();
    if (!hfToken) {
      return res.status(401).json({ error: 'empty bearer token' });
    }

    const user = await verifyHfToken(hfToken);
    const userId = user.name || String(user.id);
    checkRateLimit(userId);

    // Caller may override model/voice for A/B tests, but the
    // defaults match what the mobile shell is built against. We
    // intentionally do NOT forward arbitrary fields from the
    // request body to OpenAI: only the two we validated.
    const body = req.body || {};
    const model =
      typeof body.model === 'string' && body.model.trim() !== ''
        ? body.model.trim()
        : getDefaultModel();
    const voice =
      typeof body.voice === 'string' && body.voice.trim() !== ''
        ? body.voice.trim()
        : DEFAULT_REALTIME_VOICE;

    // GA body shape: the session config sits under `session`, with
    // a required `type` discriminator (`"realtime"` for the voice
    // pipeline, `"transcription"` for transcription-only). The
    // mobile shell only needs `realtime`.
    const openaiBody = {
      session: {
        type: 'realtime',
        model,
        // The GA schema expects `audio.output.voice`. We mirror
        // the minimal shape: clients can still issue
        // `session.update` events over the data channel after
        // connect to tweak modalities, tools, instructions, etc.
        audio: {
          output: { voice },
        },
      },
    };

    let openaiRes;
    try {
      openaiRes = await fetch(OPENAI_CLIENT_SECRETS_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(openaiBody),
      });
    } catch (err) {
      console.error('[openai] mint network error:', err);
      return res.status(502).json({ error: 'openai network error' });
    }

    if (!openaiRes.ok) {
      const text = await openaiRes.text().catch(() => '');
      console.error(
        `[openai] mint failed for ${userId}: ${openaiRes.status} ${text}`,
      );
      return res.status(502).json({
        error: 'openai mint failed',
        upstreamStatus: openaiRes.status,
      });
    }

    const payload = await openaiRes.json();
    // We log the user id and the chosen model but NEVER the
    // client_secret. The secret stays on the wire to the
    // requesting client only.
    console.log(
      `[openai] minted ephemeral for ${userId} (model=${model}, voice=${voice})`,
    );
    return res.json(payload);
  } catch (err) {
    if (err instanceof HttpError) {
      return res.status(err.status).json({ error: err.message });
    }
    console.error('[openai] unexpected mint error:', err);
    return res.status(500).json({ error: 'internal error' });
  }
}
