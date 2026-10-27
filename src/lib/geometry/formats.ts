import type { UpAxis } from "./mesh";

export const ACCEPT = ".glb,.gltf,.stl,.obj,.ply,.fbx";
export const FORMATS = "GLB, glTF, STL, OBJ, PLY or FBX";
export const MODEL_EXT = /\.(glb|gltf|stl|obj|ply|fbx)$/i;

export class ModelError extends Error {}

/** The up axis each format usually uses (Blender exports glTF, OBJ and FBX with +Y up, STL and PLY with +Z). */
export function defaultUp(filename: string): UpAxis {
  return /\.(stl|ply)$/i.test(filename) ? "+z" : "+y";
}

/** Reads a 3D file into triangles. The loaders (three.js) are fetched the first time. */
export async function readModel(name: string, data: ArrayBuffer) {
  const { loadModelFile } = await import("./load");
  return loadModelFile(name, data);
}
