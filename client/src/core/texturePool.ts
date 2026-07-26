import * as THREE from "three";

/**
 * Reuses tile textures instead of allocating one per tile.
 *
 * Adapted from pTolemy3D's `TextureManager`, which kept a free-list of GL
 * texture IDs per resolution and refilled them with `glTexSubImage2D` rather
 * than deleting and recreating. Every tile here is the same 512 px square, so
 * one flat pool covers the whole grid.
 *
 * Reuse means keeping the `THREE.Texture` object and swapping its image:
 * three.js then re-uploads into the existing WebGLTexture instead of churning
 * a create/delete pair through the driver on every tile swap. The heavy-load
 * engine spike found GPU resource management, not the draw path, to be the
 * ceiling at scale (plan §10.2); this is the cheap half of that.
 *
 * Safety: a texture may only be released once nothing renders it. TileManager
 * pins every key whose node still holds a mesh, so BundleCache only evicts
 * bundles whose meshes are already gone — the same precondition that made the
 * previous `texture.dispose()` safe.
 */
export class TexturePool {
  private free: THREE.Texture[] = [];
  private created = 0;
  private reused = 0;

  /** @param maxIdle textures kept warm; extras are disposed on release. */
  constructor(private readonly maxIdle = 64) {}

  /** A texture showing `image`, recycled if one is idle. */
  acquire(image: TexImageSource): THREE.Texture {
    const pooled = this.free.pop();
    if (pooled) {
      pooled.image = image;
      pooled.needsUpdate = true;
      this.reused++;
      return pooled;
    }

    const texture = new THREE.CanvasTexture(image as HTMLCanvasElement);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4;
    this.created++;
    return texture;
  }

  /** Return a texture to the pool. Caller must guarantee nothing renders it. */
  release(texture: THREE.Texture): void {
    if (this.free.length >= this.maxIdle) {
      texture.dispose();
      return;
    }
    // Drop the image so an idle texture doesn't pin a 512x512 bitmap.
    const image = texture.image as ImageBitmap | undefined;
    if (image && typeof (image as ImageBitmap).close === "function") {
      image.close();
    }
    texture.image = null;
    this.free.push(texture);
  }

  /** Dispose every idle texture (live ones are the caller's problem). */
  dispose(): void {
    for (const texture of this.free) {
      texture.dispose();
    }
    this.free = [];
  }

  stats(): { created: number; reused: number; idle: number } {
    return { created: this.created, reused: this.reused, idle: this.free.length };
  }
}
