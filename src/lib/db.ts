import { coerceProject, uid, type Project } from "./types";

/*
  Everything lives in this browser (IndexedDB): projects, and the 3D files they use, stored
  once each by content. A project file you download carries its 3D file inside it.
*/

const DB = "stream-vehicle";
const PROJECTS = "projects";
const FILES = "files";
export const FILE_FORMAT = "stream-vehicle";
export const FILE_SUFFIX = ".stream-vehicle.json";

export interface StoredFile {
  id: string;
  name: string;
  data: ArrayBuffer;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(PROJECTS)) db.createObjectStore(PROJECTS, { keyPath: "id" });
      if (!db.objectStoreNames.contains(FILES)) db.createObjectStore(FILES, { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => {
      db.close();
      resolve(req.result);
    };
    t.onerror = () => {
      db.close();
      reject(t.error ?? req.error);
    };
  });
}

export async function listProjects(): Promise<Project[]> {
  const all = await tx<Project[]>(PROJECTS, "readonly", (s) => s.getAll() as IDBRequest<Project[]>);
  return all.map((p) => coerceProject(p)).sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getProject(id: string): Promise<Project | null> {
  const p = await tx<Project | undefined>(PROJECTS, "readonly", (s) => s.get(id) as IDBRequest<Project | undefined>);
  return p ? coerceProject(p) : null;
}

export async function saveProject(p: Project): Promise<void> {
  await tx(PROJECTS, "readwrite", (s) => s.put(p));
}

export async function deleteProject(id: string): Promise<void> {
  await tx(PROJECTS, "readwrite", (s) => s.delete(id));
}

export async function duplicateProject(p: Project): Promise<Project> {
  const now = Date.now();
  const copy: Project = { ...structuredClone(p), id: uid(), name: `${p.name} (copy)`, createdAt: now, updatedAt: now };
  await saveProject(copy);
  return copy;
}

// ---------- 3D files ----------

async function hashOf(data: ArrayBuffer): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(d).slice(0, 12), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Stores a 3D file (once, by content) and returns its id. */
export async function storeFile(name: string, data: ArrayBuffer): Promise<string> {
  const id = await hashOf(data);
  const existing = await tx<StoredFile | undefined>(FILES, "readonly", (s) => s.get(id) as IDBRequest<StoredFile | undefined>);
  if (!existing) await tx(FILES, "readwrite", (s) => s.put({ id, name, data } satisfies StoredFile));
  return id;
}

export async function getFile(id: string): Promise<StoredFile | null> {
  return (await tx<StoredFile | undefined>(FILES, "readonly", (s) => s.get(id) as IDBRequest<StoredFile | undefined>)) ?? null;
}

// ---------- project files ----------

export function slug(name: string) {
  return (
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "test"
  );
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(b64: string): ArrayBuffer {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out.buffer;
}

export async function downloadProjectFile(p: Project) {
  let file: { name: string; data: string } | null = null;
  if (p.model.kind === "file") {
    const f = await getFile(p.model.fileId);
    if (f) file = { name: f.name, data: toBase64(f.data) };
  }
  const body = JSON.stringify({ format: FILE_FORMAT, version: 1, project: p, file });
  downloadBlob(new Blob([body], { type: "application/json" }), `${slug(p.name)}${FILE_SUFFIX}`);
}

/** Reads a project file and stores it as a new project (it never overwrites one you have). */
export async function importProjectFile(file: File): Promise<Project> {
  let parsed: { format?: string; project?: unknown; file?: { name: string; data: string } | null };
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    throw new Error("That file isn't a project from this app.");
  }
  const p = coerceProject(parsed.project ?? parsed);
  if (p.model.kind === "file") {
    if (parsed.file?.data) {
      const id = await storeFile(parsed.file.name, fromBase64(parsed.file.data));
      p.model = { kind: "file", fileId: id, fileName: parsed.file.name };
    } else if (!(await getFile(p.model.fileId))) {
      throw new Error("The project's 3D file isn't inside it. Open the project and add the 3D file again.");
    }
  }
  const existing = await getProject(p.id);
  const imported: Project = { ...p, id: existing ? uid() : p.id, updatedAt: Date.now() };
  await saveProject(imported);
  return imported;
}
