import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { PLYLoader } from "three/examples/jsm/loaders/PLYLoader.js";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { toCreasedNormals } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { flatNormals, type TriMesh } from "./mesh";
import { FORMATS, ModelError } from "./formats";

/** Turns a 3D file into one triangle soup in the file's own units. Textures and materials are ignored. */
export async function loadModelFile(name: string, data: ArrayBuffer): Promise<TriMesh> {
  const ext = (/\.([a-z0-9]+)$/i.exec(name)?.[1] ?? "").toLowerCase();
  let root: THREE.Object3D;
  try {
    switch (ext) {
      case "glb":
      case "gltf": {
        const loader = new GLTFLoader();
        const draco = new DRACOLoader();
        draco.setDecoderPath("https://www.gstatic.com/draco/versioned/decoders/1.5.7/");
        loader.setDRACOLoader(draco);
        loader.setMeshoptDecoder(MeshoptDecoder);
        const gltf = await loader.parseAsync(ext === "gltf" ? new TextDecoder().decode(data) : data, "");
        draco.dispose();
        root = gltf.scene;
        break;
      }
      case "stl": {
        const g = new STLLoader().parse(data);
        root = new THREE.Mesh(g);
        break;
      }
      case "ply": {
        const g = new PLYLoader().parse(data);
        root = new THREE.Mesh(g);
        break;
      }
      case "obj":
        root = new OBJLoader().parse(new TextDecoder().decode(data));
        break;
      case "fbx":
        root = new FBXLoader().parse(data, "");
        break;
      default:
        throw new ModelError(`Use a ${FORMATS} file.`);
    }
  } catch (e) {
    if (e instanceof ModelError) throw e;
    const msg = e instanceof Error ? e.message : String(e);
    if (ext === "gltf" && /buffer|uri|fetch/i.test(msg)) {
      throw new ModelError("This glTF keeps its data in separate files. Export it as a single .glb instead.");
    }
    throw new ModelError(`The file couldn't be read (${msg}).`);
  }

  root.updateMatrixWorld(true);
  const parts: { pos: Float32Array; nrm: Float32Array }[] = [];
  let total = 0;
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry?.attributes.position) return;
    if ((mesh as unknown as THREE.Points).isPoints || (mesh as unknown as THREE.Line).isLine) return;
    let g = mesh.geometry.clone();
    for (const k of Object.keys(g.attributes)) if (k !== "position" && k !== "normal") g.deleteAttribute(k);
    g.applyMatrix4(mesh.matrixWorld);
    g = g.index ? g.toNonIndexed() : g;
    let nrm: Float32Array;
    const pos = new Float32Array(g.attributes.position.array as ArrayLike<number>);
    if (pos.length < 9) return;
    try {
      // Smooth across gentle curves, keep the hard edges hard.
      const creased = toCreasedNormals(g, Math.PI / 6);
      nrm = new Float32Array(creased.attributes.normal.array as ArrayLike<number>);
      if (nrm.length !== pos.length) nrm = flatNormals(pos);
    } catch {
      nrm = flatNormals(pos);
    }
    parts.push({ pos, nrm });
    total += pos.length;
  });
  if (!total) throw new ModelError("No surfaces found in this file.");
  const positions = new Float32Array(total);
  const normals = new Float32Array(total);
  let off = 0;
  for (const p of parts) {
    positions.set(p.pos, off);
    normals.set(p.nrm, off);
    off += p.pos.length;
  }
  for (let i = 0; i < positions.length; i++) if (!Number.isFinite(positions[i])) throw new ModelError("The file has broken coordinates.");
  return { positions, normals };
}
