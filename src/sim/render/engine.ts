// WebGL engine: owns the renderer, scene, follow camera and the render loop, and
// turns a canvas click into a ground-intersection point (for click-to-move).

import { Color, type Fog, Object3D, Raycaster, Scene, Vector2, Vector3, WebGLRenderer, Mesh } from "three";
import { FollowCamera } from "./camera";

const SKY = 0x6b8cae; // default clear-sky background, restored when a map has no fog

export class Engine {
  readonly renderer: WebGLRenderer;
  readonly scene: Scene;
  readonly cam: FollowCamera;
  private raycaster = new Raycaster();
  private ndc = new Vector2(); // reused for raycasting (no per-pick allocation)
  private raf = 0;
  private onFrame?: (dt: number) => void;
  private last = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.scene = new Scene();
    this.scene.background = new Color(SKY);
    this.cam = new FollowCamera(canvas.clientWidth / Math.max(1, canvas.clientHeight));
    this.resize(canvas.clientWidth, canvas.clientHeight);
  }

  add(obj: Object3D): void {
    this.scene.add(obj);
  }

  /** Apply a map's distance fog (or clear it). The far horizon is tinted to the
   *  fog colour so the ground fades into the sky instead of meeting a hard edge;
   *  with no fog we restore the default sky background. Materials respect
   *  scene.fog by default, so the ground/models/water fade with no shader work. */
  setFog(fog: Fog | null): void {
    this.scene.fog = fog;
    (this.scene.background as Color).set(fog ? fog.color : SKY);
  }

  resize(width: number, height: number): void {
    this.renderer.setSize(width, height, false);
    this.cam.setAspect(width / Math.max(1, height));
  }

  start(onFrame: (dt: number) => void): void {
    this.onFrame = onFrame;
    this.last = performance.now();
    this.renderOnce(0); // draw immediately so the first paint isn't blank
    const loop = (now: number) => {
      const dt = Math.min(0.1, (now - this.last) / 1000);
      this.last = now;
      this.renderOnce(dt);
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  /** Run one frame update + render. Used for the initial paint and (in tests /
   *  background tabs where rAF is throttled) to step the scene on demand. */
  renderOnce(dt: number): void {
    this.onFrame?.(dt);
    this.renderer.render(this.scene, this.cam.camera);
  }

  /** Raycast a canvas-relative click against the ground meshes → world point.
   *  Refresh the camera's world matrix first — the follow camera moves each frame
   *  (and hover is sampled mid-frame), before render() would update it. */
  pickGround(nx: number, ny: number, ground: Mesh[]): Vector3 | null {
    this.cam.camera.updateMatrixWorld();
    this.ndc.set(nx * 2 - 1, -(ny * 2 - 1));
    this.raycaster.setFromCamera(this.ndc, this.cam.camera);
    const hits = this.raycaster.intersectObjects(ground, false);
    // `point` is freshly allocated per intersect call; the caller reads it
    // immediately, so there's no need to clone.
    return hits.length ? hits[0].point : null;
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.renderer.dispose();
  }
}
