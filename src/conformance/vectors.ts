import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

/** A layer vector as the kit writes it: `then` states what the layer suite must witness for `given`. */
export interface LayerVector {
  readonly id: string;
  readonly op: string;
  readonly covers?: string;
  readonly given: Readonly<Record<string, unknown>>;
  readonly then: Readonly<Record<string, unknown>>;
}

function vectorFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        return vectorFiles(path);
      }
      return entry.isFile() && entry.name.endsWith(".json") ? [path] : [];
    })
    .sort();
}

/** The id the kit gives the vector at `path`: its path under the layer directory, without `.json`. */
function idOfPath(directory: string, path: string): string {
  return relative(directory, path).split(sep).join("/").replace(/\.json$/, "");
}

function parseVector(directory: string, path: string): LayerVector {
  const vector = JSON.parse(readFileSync(path, "utf8")) as LayerVector;
  const expectedId = idOfPath(directory, path);
  if (vector.id !== expectedId) {
    throw new Error(`The layer vector at ${path} names itself ${vector.id}, where its path names ${expectedId}.`);
  }
  return vector;
}

/** Every layer vector under `directory`, at any depth, in the order of their paths. */
export function readLayerVectors(directory: string): LayerVector[] {
  return vectorFiles(directory).map((path) => parseVector(directory, path));
}

/** The vector under `directory` whose id is `id`. */
export function readLayerVector(directory: string, id: string): LayerVector {
  const vector = readLayerVectors(directory).find((candidate) => candidate.id === id);
  if (vector === undefined) {
    throw new Error(`No layer vector under ${directory} has the id ${id}.`);
  }
  return vector;
}

/** The ids of the vectors under `directory` that no name in `witnessed` names, in the order of their paths. */
export function unwitnessedVectorIds(directory: string, witnessed: Iterable<string>): string[] {
  const named = new Set(witnessed);
  return readLayerVectors(directory)
    .map((vector) => vector.id)
    .filter((id) => !named.has(id));
}
