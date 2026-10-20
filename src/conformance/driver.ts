import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { pathToFileURL } from "node:url";
import type { Operations, Outcome, Vector } from "./operation.js";
import { operations } from "./operations.js";

/**
 * Answers one vector from the engine.
 *
 * @remarks
 * Dispatch passes `given` only, so a vector's `then` cannot reach an op: the runner judges, the
 * driver answers.
 */
export function answer(vector: Vector, table: Operations = operations): Outcome {
  const operation = Object.hasOwn(table, vector.op) ? table[vector.op] : undefined;
  if (operation === undefined) {
    return { id: vector.id, witnessed: false, result: { reason: "not implemented" } };
  }
  try {
    return { id: vector.id, witnessed: true, result: operation(givenOf(vector)) };
  } catch (error) {
    return { id: vector.id, witnessed: true, result: { error: String(error) } };
  }
}

function givenOf(vector: Vector): Record<string, unknown> {
  const { given } = vector;
  return typeof given === "object" && given !== null ? (given as Record<string, unknown>) : {};
}

/** Reads one vector per line of `input` and writes one outcome per line of `output`. */
export async function serve(input: Readable, output: Writable, table: Operations = operations): Promise<void> {
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (line.trim() !== "") {
      output.write(`${JSON.stringify(answer(JSON.parse(line) as Vector, table))}\n`);
    }
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  serve(process.stdin, process.stdout).catch((error: unknown) => {
    process.stderr.write(`${String(error)}\n`);
    process.exit(1);
  });
}
