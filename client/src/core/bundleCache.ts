/**
 * Byte-budgeted LRU cache of tile bundles (plan §5.3).
 *
 * A "bundle" is everything for one z/x/y key: imagery texture + terrain mesh
 * (+ buildings, Phase 1). Scaled up from the 96 MB budgeted-cache pattern in
 * deckgl-s3-cog-s1m.
 *
 * TODO(Phase 0): eviction on byte budget, pinning for on-screen tiles.
 * TODO(Phase 1): velocity-vector prefetch feeds this — fetch bundles the
 * camera will see in 3-5 s from position + heading + speed (the sim's
 * killer optimization); fetch scheduler with concurrency=16, bottom-first
 * ordering (proven in the existing repo).
 */

export interface Bundle {
  key: string; // tileKey(z/x/y) + layer
  bytes: number;
  // imagery: GPUTexture | ImageBitmap; terrain: TerrainMesh — typed once the
  // engine spike (plan §10.2) picks the render path.
}

export class BundleCache {
  constructor(readonly byteBudget: number) {}

  get(_key: string): Bundle | undefined {
    throw new Error("not implemented — Phase 0 step 4");
  }

  put(_bundle: Bundle): void {
    throw new Error("not implemented — Phase 0 step 4");
  }
}
