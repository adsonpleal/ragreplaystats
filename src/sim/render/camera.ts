// A fixed-tilt follow camera, roughly RO's bird's-eye view: it orbits the target
// at a constant pitch and a wheel-adjustable distance, with a yaw the player can
// rotate by right-dragging (like the game). The yaw also drives which of the 8
// sprite directions the character shows (see `direction`), matching roBrowser:
// displayed = (camera.direction + entity.direction) % 8.

import { PerspectiveCamera, Vector3 } from "three";

const PITCH = (50 * Math.PI) / 180; // degrees above the horizon
const MIN_DISTANCE = 20; // closest zoom (one wheel step less than fully in)
const MAX_DISTANCE = 260;
const ZOOM_SPEED = 0.04; // world units per wheel-delta unit (small, like the client)
const ZOOM_SMOOTH = 12; // easing rate toward the target distance (higher = snappier)

export class FollowCamera {
  readonly camera: PerspectiveCamera;
  private target = new Vector3();
  private distance = 30; // current (eased) distance — starts zoomed in
  private targetDistance = 30; // wheel sets this; `distance` eases toward it
  /** Azimuth in degrees; 0 looks from the south. Right-drag changes it. */
  yawDeg = 0;

  constructor(aspect: number) {
    this.camera = new PerspectiveCamera(45, aspect, 1, 2000);
    this.update();
  }

  setTarget(p: Vector3): void {
    this.target.copy(p);
    this.update();
  }

  /** Nudge the zoom target; the actual distance eases toward it in tickZoom. */
  zoom(deltaY: number): void {
    this.targetDistance = Math.min(MAX_DISTANCE, Math.max(MIN_DISTANCE, this.targetDistance + deltaY * ZOOM_SPEED));
  }

  /** Ease the distance toward the zoom target — call once per frame so the zoom
   *  glides instead of snapping (frame-rate independent). */
  tickZoom(dt: number): void {
    const diff = this.targetDistance - this.distance;
    if (Math.abs(diff) < 0.05) {
      if (this.distance !== this.targetDistance) {
        this.distance = this.targetDistance;
        this.update();
      }
      return;
    }
    this.distance += diff * (1 - Math.exp(-dt * ZOOM_SMOOTH));
    this.update();
  }

  rotate(deltaDeg: number): void {
    this.yawDeg = (this.yawDeg + deltaDeg) % 360;
    this.update();
  }

  setAspect(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  /** Camera facing as an 8-direction index (RO convention), for sprite picking. */
  get direction(): number {
    const a = ((this.yawDeg % 360) + 360) % 360;
    return Math.floor((a + 22.5) / 45) % 8;
  }

  private update(): void {
    const yaw = (this.yawDeg * Math.PI) / 180;
    const horiz = Math.cos(PITCH) * this.distance;
    this.camera.position.set(
      this.target.x + horiz * Math.sin(yaw),
      this.target.y + Math.sin(PITCH) * this.distance,
      this.target.z + horiz * Math.cos(yaw),
    );
    this.camera.lookAt(this.target);
  }
}
