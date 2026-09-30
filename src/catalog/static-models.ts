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
 * Neither list defines the exposed catalog: the exposed set is computed live
 * from S1 (in-sale) x S2 (zero-cost) plus the fallback voucher. Adding a model
 * upstream therefore requires no code change here.
 */

/** Zero-cost ids absent from models.dev, verified against the live lane. */
export const fallbackFreeModels: string[] = ['jev-1.13-free']

/** Small, verified subset used to bootstrap the list before S1 lands. */
export const verifiedFreeModels: string[] = [
  'big-pickle',
  'deepseek-v4-flash-free',
  'jev-1.13-free',
  'longcat-2.5-preview-free',
  'mimo-v2.5-free',
  'mimo-v2.6-flash-free',
  'muse-spark-1.2-contributor-free',
  'muse-spark-1.3-contributor-free',
  'nemotron-3-ultra-free',
  'nemotron-3.5-lightning-free',
  'space-bunny-free',
]
