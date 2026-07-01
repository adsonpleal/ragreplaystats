// RSM model → three.js geometry. Ports roBrowserLegacy's node matrix math
// (createInstance + Node.calcBoundingBox + Node.compile) onto THREE.Matrix4,
// producing one BufferGeometry per referenced texture (position + uv; normals
// computed by three.js). Output is in RO coordinate space — scene.ts places it
// under a root group that flips Y for three.js's Y-up convention.

import { BufferGeometry, Float32BufferAttribute, Matrix4, Vector3 } from "three";
import type { Rsm, RsmNode } from "../format/rsm";
import type { RswModel } from "../format/rsw";

export interface ModelGeometry {
  texture: string; // manifest key
  geometry: BufferGeometry;
}

// gl-matrix mat3 (column-major, 9 floats) → THREE.Matrix4 upper-left 3×3.
function mat3ToMatrix4(m: number[]): Matrix4 {
  return new Matrix4().set(
    m[0], m[3], m[6], 0,
    m[1], m[4], m[7], 0,
    m[2], m[5], m[8], 0,
    0, 0, 0, 1,
  );
}

const T = (x: number, y: number, z: number) => new Matrix4().makeTranslation(x, y, z);
const S = (x: number, y: number, z: number) => new Matrix4().makeScale(x, y, z);

// Per-node local matrix + overall bounding box (RSM.calcBoundingBox / Node.calcBoundingBox).
function calcNodeMatrix(node: RsmNode, parent: Matrix4): Matrix4 {
  const m = parent.clone();
  m.multiply(T(node.pos[0], node.pos[1], node.pos[2]));
  const axisLen = Math.hypot(node.rotaxis[0], node.rotaxis[1], node.rotaxis[2]);
  if (node.rotangle && axisLen > 1e-6) {
    const axis = new Vector3(node.rotaxis[0], node.rotaxis[1], node.rotaxis[2]).normalize();
    m.multiply(new Matrix4().makeRotationAxis(axis, node.rotangle));
  }
  m.multiply(S(node.scale[0], node.scale[1], node.scale[2]));
  return m;
}

interface Box {
  min: Vector3;
  max: Vector3;
}

function accumulateBox(rsm: Rsm, node: RsmNode, parent: Matrix4, isOnly: boolean, box: Box): void {
  const nodeMatrix = calcNodeMatrix(node, parent);
  const local = nodeMatrix.clone();
  if (!isOnly) local.multiply(T(node.offset[0], node.offset[1], node.offset[2]));
  local.multiply(mat3ToMatrix4(node.mat3));

  const v = new Vector3();
  for (const [x, y, z] of node.vertices) {
    v.set(x, y, z).applyMatrix4(local);
    box.min.min(v);
    box.max.max(v);
  }
  (node as RsmNode & { _matrix: Matrix4 })._matrix = nodeMatrix;

  for (const child of rsm.nodes) {
    if (child.parentname === node.name && child.name !== node.parentname) {
      accumulateBox(rsm, child, nodeMatrix, false, box);
    }
  }
}

/** Build per-texture geometry for one RSW model placement. */
export function buildModelGeometries(
  rsm: Rsm,
  placement: RswModel,
  gndWidth: number,
  gndHeight: number,
): ModelGeometry[] {
  const only = rsm.nodes.length === 1;

  // Bounding box (also stamps each node with its computed _matrix).
  const box: Box = { min: new Vector3(Infinity, Infinity, Infinity), max: new Vector3(-Infinity, -Infinity, -Infinity) };
  accumulateBox(rsm, rsm.mainNode, new Matrix4(), only, box);
  const range = box.max.clone().sub(box.min).multiplyScalar(0.5);
  const center = box.min.clone().add(range);

  // Instance matrix (RSM.createInstance).
  const inst = new Matrix4();
  inst.multiply(T(placement.position[0] + gndWidth, placement.position[1], placement.position[2] + gndHeight));
  inst.multiply(new Matrix4().makeRotationZ((placement.rotation[2] / 180) * Math.PI));
  inst.multiply(new Matrix4().makeRotationX((placement.rotation[0] / 180) * Math.PI));
  inst.multiply(new Matrix4().makeRotationY((placement.rotation[1] / 180) * Math.PI));
  inst.multiply(S(placement.scale[0], placement.scale[1], placement.scale[2]));
  if (rsm.version >= 2.2) {
    const f = rsm.mainNode.flip;
    inst.multiply(S(f[0], f[1], f[2]));
    inst.multiply(T(rsm.mainNode.offset[0], rsm.mainNode.offset[1], rsm.mainNode.offset[2]));
    inst.multiply(T(0, range.y, 0));
    inst.multiply(T((box.max.x + box.min.x) / 2, (box.max.y + box.min.y) / 2, (box.max.z + box.min.z) / 2));
  }

  // Per-texture vertex accumulation across all nodes.
  const groups = new Map<string, { pos: number[]; uv: number[] }>();
  const v = new Vector3();
  for (const node of rsm.nodes) {
    const nodeMatrix = (node as RsmNode & { _matrix?: Matrix4 })._matrix ?? calcNodeMatrix(node, new Matrix4());
    const m = T(-center.x, -box.max.y, -center.z);
    m.multiply(nodeMatrix);
    if (!only) m.multiply(T(node.offset[0], node.offset[1], node.offset[2]));
    m.multiply(mat3ToMatrix4(node.mat3));
    const modelView = inst.clone().multiply(m);

    const verts = node.vertices.map(([x, y, z]) => v.set(x, y, z).applyMatrix4(modelView).clone());
    for (const f of node.faces) {
      const texName = rsm.textures[node.textureIndexes[f.texid]] ?? "";
      let g = groups.get(texName);
      if (!g) groups.set(texName, (g = { pos: [], uv: [] }));
      for (let i = 0; i < 3; i++) {
        const p = verts[f.vertidx[i]];
        const t = f.tvertidx[i] * 6;
        g.pos.push(p.x, p.y, p.z);
        // RO model UVs use an image-top origin; three.js samples textures
        // bottom-up (flipY), so flip V — otherwise atlas faces land in the
        // wrong place (scrambled house) and strips read upside-down (ropes).
        g.uv.push(node.tvertices[t + 4], 1 - node.tvertices[t + 5]);
      }
    }
  }

  const out: ModelGeometry[] = [];
  for (const [texture, g] of groups) {
    if (!g.pos.length) continue;
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new Float32BufferAttribute(g.pos, 3));
    geometry.setAttribute("uv", new Float32BufferAttribute(g.uv, 2));
    geometry.computeVertexNormals();
    out.push({ texture, geometry });
  }
  return out;
}
