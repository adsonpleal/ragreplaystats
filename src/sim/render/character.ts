// The player character as an in-scene billboard (not a DOM overlay), so it's
// occluded by 3D objects via the depth buffer — like roBrowser. The animated
// ragassets sprite is drawn into a canvas each frame and used as the plane's
// texture.
//
// Size and orientation follow roBrowser's SpriteRenderer:
//  - 1 sprite pixel = 5/175 = 1/35 world units (size[i]/175 * xSize, xSize=5),
//    in the same space where a ground tile spans 2 units — a fixed size relative
//    to the map that scales with zoom via the perspective camera.
//  - the quad is a full camera-facing billboard (parallel to the image plane), so
//    the flat sprite stays at a single depth and never sinks into the tilted
//    ground; the feet anchor is placed on the ground point.

import {
  CanvasTexture,
  Mesh,
  MeshBasicMaterial,
  NearestFilter,
  type PerspectiveCamera,
  PlaneGeometry,
  type Scene,
  SRGBColorSpace,
  Vector3,
} from "three";
import { SPRITE, UNITS_PER_PX } from "../sprite";

/** The render-canvas metrics a billboard needs: the sprite sheet's pixel size and
 *  the origin (ground/feet point) within it. The character uses SPRITE; the pet
 *  passes its own (larger) PET_SPRITE — see sim/pets.ts. */
export type SpriteMetrics = { w: number; h: number; anchorX: number; anchorY: number };

// The flat sprite shares the feet's depth, so the ground tiles in front of the
// feet (nearer the camera) would overdraw its lower edge (boots sit just below
// the anchor). Nudge the whole sprite toward the camera *along the line of sight*
// (no on-screen shift) so it clears the surrounding ground; it's > one tile's
// depth step, but small enough that taller models still occlude it.
const FRONT_BIAS = 2.5;

export class Character {
  readonly mesh: Mesh;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private texture: CanvasTexture;
  private up = new Vector3();
  private toCam = new Vector3();
  private metrics: SpriteMetrics;
  private anchorOffset: number;

  constructor(
    private scene: Scene,
    metrics: SpriteMetrics = SPRITE,
  ) {
    this.metrics = metrics;
    const worldW = metrics.w * UNITS_PER_PX;
    const worldH = metrics.h * UNITS_PER_PX;
    // The feet anchor (canvas row anchorY) sits this far below the plane's centre,
    // in world units along the billboard's up axis.
    this.anchorOffset = (metrics.anchorY / metrics.h - 0.5) * worldH;
    this.canvas = document.createElement("canvas");
    this.canvas.width = metrics.w;
    this.canvas.height = metrics.h;
    this.ctx = this.canvas.getContext("2d")!;
    this.texture = this.makeTexture();
    const material = new MeshBasicMaterial({
      map: this.texture,
      transparent: true,
      alphaTest: 0.3, // discard the sprite's transparent pixels (no halo, no z-block)
      depthTest: true,
      depthWrite: true,
    });
    this.mesh = new Mesh(new PlaneGeometry(worldW, worldH), material);
    this.mesh.renderOrder = 1;
    scene.add(this.mesh);
  }

  /** A CanvasTexture bound to this billboard's canvas, with the sprite filter +
   *  colour space. Recreated (not just flagged) whenever the canvas is resized —
   *  three.js updates an existing texture via texSubImage2D against the old GPU
   *  allocation, so a grown canvas never uploads; a fresh texture forces the
   *  full texImage2D re-allocation. */
  private makeTexture(): CanvasTexture {
    const t = new CanvasTexture(this.canvas);
    t.colorSpace = SRGBColorSpace;
    t.magFilter = NearestFilter;
    return t;
  }

  /** Redraw from the (animating) sprite img, then orient/place the plane.
   *  `feet` is the ground point in world space; the plane faces `camera`.
   *  `frontBias` overrides the default line-of-sight pull toward the camera —
   *  a smaller value seats the sprite further back in depth, so two sprites at
   *  the same ground point (a warg mount and its rider) order correctly. */
  update(img: HTMLImageElement, feet: Vector3, camera: PerspectiveCamera, frontBias = FRONT_BIAS): void {
    if (img.complete && img.naturalWidth) {
      this.ctx.clearRect(0, 0, this.metrics.w, this.metrics.h);
      this.ctx.drawImage(img, 0, 0, this.metrics.w, this.metrics.h);
      this.texture.needsUpdate = true;
    }
    // Face the camera fully (image-plane-aligned): a single-depth flat sprite.
    this.mesh.quaternion.copy(camera.quaternion);
    // Offset along the billboard's up axis so the feet anchor lands on the ground.
    this.up.set(0, 1, 0).applyQuaternion(camera.quaternion);
    this.mesh.position.copy(feet).addScaledVector(this.up, this.anchorOffset);
    // Pull toward the camera along the line of sight so nearby ground can't clip
    // the lower edge (depth-only nudge; the on-screen position is unchanged).
    this.toCam.copy(camera.position).sub(this.mesh.position).normalize();
    this.mesh.position.addScaledVector(this.toCam, frontBias);
  }

  /** Swap the render canvas + plane to a different size — used when the player
   *  mounts a warg and the sprite grows to the player+warg composite (and back
   *  on dismount). No-op if the metrics are unchanged. */
  setMetrics(metrics: SpriteMetrics): void {
    if (metrics === this.metrics) return;
    this.metrics = metrics;
    this.canvas.width = metrics.w;
    this.canvas.height = metrics.h;
    const worldW = metrics.w * UNITS_PER_PX;
    const worldH = metrics.h * UNITS_PER_PX;
    this.anchorOffset = (metrics.anchorY / metrics.h - 0.5) * worldH;
    this.mesh.geometry.dispose();
    this.mesh.geometry = new PlaneGeometry(worldW, worldH);
    // Recreate the texture — resizing the canvas can't grow the existing GPU
    // texture (three.js would texSubImage2D against the old size), so the mount
    // sprite never showed even though it was drawn onto the canvas.
    this.texture.dispose();
    this.texture = this.makeTexture();
    const material = this.mesh.material as MeshBasicMaterial;
    material.map = this.texture;
    material.needsUpdate = true;
  }

  /** Show/hide the billboard — used to keep the previous map's character from
   *  lingering in the scene while the next map loads. */
  setVisible(visible: boolean): void {
    this.mesh.visible = visible;
  }

  /** Alpha (0..255) of the sprite pixel at a plane UV (u,v ∈ [0,1], v=0 is
   *  the plane's bottom). Used to reject hover ray hits that land in the
   *  transparent padding around the sprite so the tooltip only appears when
   *  the cursor is actually over the character/monster.
   *  Returns 0 if the UV is out of range or the canvas is empty. */
  alphaAt(u: number, v: number): number {
    if (u < 0 || u > 1 || v < 0 || v > 1) return 0;
    // Canvas Y = 0 is the top row; the plane's UV v = 0 is the bottom → flip.
    const x = Math.max(0, Math.min(this.metrics.w - 1, Math.floor(u * this.metrics.w)));
    const y = Math.max(0, Math.min(this.metrics.h - 1, Math.floor((1 - v) * this.metrics.h)));
    try {
      return this.ctx.getImageData(x, y, 1, 1).data[3];
    } catch {
      // Canvas may be tainted if a cross-origin sprite lacks CORS. ragassets
      // sends Access-Control-Allow-Origin:*, but guard anyway so a bad probe
      // just falls through to "counts as a hit".
      return 255;
    }
  }

  dispose(): void {
    this.scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    (this.mesh.material as MeshBasicMaterial).dispose();
    this.texture.dispose();
  }
}
