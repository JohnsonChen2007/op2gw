/**
 * Static model knowledge carried in the build.
 *
 * Two distinct roles, deliberately kept apart:
 *
 * 1. `verifiedFreeModels` — ids verified (by a real anonymous-lane call at
 *    build time) to be usable through the free lane. Used ONLY to bootstrap
 *    `GET /v1/models` before the first S1 fetch lands, so a cold start still
 *    advertises something real. It is never used to *promote* a model whose
 *    live metadata says otherwise.
 *
 * 2. `fallbackFreeModels` — historical ids that are known to be zero-cost on
 *    Zen but are absent from models.dev metadata (Zen ships ids models.dev has
 *    not catalogued yet). Used as a last-resort "this is free" voucher when
 *    metadata cannot speak, so the free-model set does not silently shrink to
 *    "whatever models.dev happens to know".
 *
 * 3. `disabledModels` — ids confirmed to be permanently dead/broken upstream
 *    (e.g. "Model is unavailable", "Endpoint is unavailable", or 500 errors).
 *    These are stripped from all exposed model lists and rejected immediately.
 *
 * 4. `contextWindowOverrides` / `maxOutputOverride` — advertised token limits
 *    the operator wants clients to budget against. These change only what
 *    `GET /v1/models` advertises (`context_length` / `max_output_tokens`); they
 *    never touch the request path. Every known model now uses the operator's
 *    1M context floor, while the output cap is uniformly 128K.
 *
 *    Both are advertisements, not capabilities — see the warnings on each.
 *
 * Neither list defines the exposed catalog: the exposed set is computed live
 * from S1 (in-sale) x S2 (zero-cost) plus the fallback voucher. Adding a model
 * upstream therefore requires no code change here.
 */

/** Models permanently broken/dead upstream (excluded from catalog & requests). */
export const disabledModels: string[] = [
  'deepseek-v4-flash-free',   // Upstream: "Model is unavailable"
  'jev-1.13-free',            // Upstream: 403 "free tier can only be used from within OpenCode"
  'ling-3.0-flash-fin-free',  // Upstream: "Endpoint is unavailable"
  'exo-free',                 // Upstream: 410 "Model exo-free has been deprecated" (verified 3/3, 2026-10)
  // Delisted from Zen /v1/models (verified 2026-10-17); kept here so lingering
  // client references fail fast instead of forwarding to a 404 upstream.
  'muse-spark-1.2-contributor-free',
  'muse-spark-1.3-contributor-free',
  'ling-3.1-flash-free',
  'step-5-preview-free',
  'nemotron-3-ultra-free',
  'cat-jam-free',
  'mimo-v2.5-free',
  'fledge-alpha-free',
]

/** Zero-cost ids absent from models.dev, verified against the live lane. */
export const fallbackFreeModels: string[] = []

/**
 * Advertised context-window floor, in tokens, for ids whose models.dev value is
 * smaller than the operator wants clients to plan against.
 *
 * WARNING: this is an advertisement, not a capability. `context_length` is what
 * an OpenAI-compatible client sizes its prompt against, so raising it makes the
 * client hold MORE conversation before compacting. If the real upstream window
 * is smaller, the overflow surfaces upstream as a rejection or as silent
 * truncation with no client-side signal that anything was dropped.
 *
 * Only ids actually below the floor belong here; anything already at or above it
 * is left to report its live models.dev value.
 */
/** Operator-wide advertised context floor for every catalog model. */
export const contextWindowOverride = 1_048_576

/** Kept for compatibility with callers/tests that inspect the old map export. */
export const contextWindowOverrides: Record<string, number> = {}

/**
 * Uniform advertised max-output cap, in tokens, applied to EVERY exposed model.
 * Set to `undefined` to fall back to each model's live models.dev value.
 *
 * This cuts both ways, and only one of them is dangerous:
 *
 * - Where models.dev advertises MORE than 128K (space-bunny-free 512K,
 *   nemotron-3.5-lightning-free 256K) this UNDER-promises. That is the safe
 *   direction: the client simply stops generating earlier than it could.
 * - Where models.dev advertises LESS (deepseek/big-pickle/mimo/glm at 32K) this
 *   OVER-promises by 4x, and a client that generates past the real ceiling gets
 *   an upstream rejection or a silent short response instead.
 *
 * Consumers that have no declared output limit at all start reporting 128K too,
 * since the cap is unconditional.
 */
export const maxOutputOverride: number | undefined = 131_072

/** Verified working subset used to bootstrap the list before S1 lands. */
export const verifiedFreeModels: string[] = [
  'beam-free',
  'big-pickle',
  'deepseek-v4.1-flash-free',
  'glm-5.3-flash-free',
  'longcat-2.5-preview-free',
  'mimo-v2.6-flash-free',
  'nemotron-3.5-lightning-free',
  'nemotron-3.5-super-vl-free',
  'space-bunny-free',
]
