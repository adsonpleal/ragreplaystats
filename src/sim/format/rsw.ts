// RSW (Resource World) parser — the scene description: which models are placed
// where, plus water and lighting. Ported from roBrowserLegacy Loaders/World.js,
// which handles the modern 2.x format (tra_fild is RSW 2.4). We only keep what
// the bare-minimum renderer needs: models, water, light.
//
// Positions/scales are divided by 5 (RO's fixed unit); rotations are in degrees.

import { BinaryReader, normName } from "./reader";

export interface RswModel {
  /** Manifest key (normalized) for the .rsm file. */
  filename: string;
  position: [number, number, number];
  rotation: [number, number, number];
  scale: [number, number, number];
}

export interface RswWater {
  level: number;
  type: number;
  waveHeight: number;
  waveSpeed: number;
  wavePitch: number;
}

export interface RswLight {
  longitude: number;
  latitude: number;
  diffuse: [number, number, number];
  ambient: [number, number, number];
  opacity: number;
}

export class Rsw {
  readonly version: number;
  readonly models: RswModel[] = [];
  readonly water: RswWater = { level: 0, type: 0, waveHeight: 1, waveSpeed: 2, wavePitch: 50 };
  readonly light: RswLight = {
    longitude: 45,
    latitude: 45,
    diffuse: [1, 1, 1],
    ambient: [0.3, 0.3, 0.3],
    opacity: 1,
  };

  constructor(buffer: ArrayBuffer) {
    const fp = new BinaryReader(buffer);
    if (fp.str(4) !== "GRSW") throw new Error("RSW: invalid header (expected GRSW)");
    const version = (this.version = fp.i8() + fp.i8() / 10);

    if (version >= 2.5) fp.i32(); // build number
    if (version >= 2.2) fp.u8(); // unknown byte

    fp.str(40); // ini
    fp.str(40); // gnd
    fp.str(40); // gat
    if (version >= 1.4) fp.str(40); // src

    if (version < 2.6) {
      if (version >= 1.3) this.water.level = fp.f32() / 5;
      if (version >= 1.8) {
        this.water.type = fp.i32();
        this.water.waveHeight = fp.f32() / 5;
        this.water.waveSpeed = fp.f32();
        this.water.wavePitch = fp.f32();
      }
      if (version >= 1.9) fp.i32(); // anim speed
    }

    if (version >= 1.5) {
      this.light.longitude = fp.i32();
      this.light.latitude = fp.i32();
      this.light.diffuse = [fp.f32(), fp.f32(), fp.f32()];
      this.light.ambient = [fp.f32(), fp.f32(), fp.f32()];
      if (version >= 1.7) this.light.opacity = fp.f32();
    }

    if (version >= 1.6) {
      fp.i32(); fp.i32(); fp.i32(); fp.i32(); // ground frustum bounds
    }
    if (version >= 2.7) {
      const c = fp.i32();
      fp.seek(4 * c);
    }

    const count = fp.i32();
    for (let i = 0; i < count; i++) {
      switch (fp.i32()) {
        case 1: {
          if (version >= 1.3) {
            fp.str(40); // name
            fp.i32(); // anim type
            fp.f32(); // anim speed
            fp.i32(); // block type
          }
          if (version >= 2.6) fp.u8(); // (buildnumber>=186 only; 2.4 skips)
          if (version >= 2.7) fp.i32();
          const filename = normName(fp.str(80));
          fp.str(80); // node name
          const position: [number, number, number] = [fp.f32() / 5, fp.f32() / 5, fp.f32() / 5];
          const rotation: [number, number, number] = [fp.f32(), fp.f32(), fp.f32()];
          const scale: [number, number, number] = [fp.f32() / 5, fp.f32() / 5, fp.f32() / 5];
          this.models.push({ filename, position, rotation, scale });
          break;
        }
        case 2: // light source
          fp.str(80); fp.f32(); fp.f32(); fp.f32(); fp.i32(); fp.i32(); fp.i32(); fp.f32();
          break;
        case 3: // sound
          fp.str(80); fp.str(80); fp.f32(); fp.f32(); fp.f32(); fp.f32(); fp.i32(); fp.i32(); fp.f32();
          if (version >= 2.0) fp.f32();
          break;
        case 4: // effect
          fp.str(80); fp.f32(); fp.f32(); fp.f32(); fp.i32(); fp.f32(); fp.f32(); fp.f32(); fp.f32(); fp.f32();
          break;
        default:
          return; // unknown object type — stop before the trailing quadtree
      }
    }
  }
}
