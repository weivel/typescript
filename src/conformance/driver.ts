import { EdgeSource, type CoreOptions } from "../core/index.js";
import { driveConsume } from "./consume.js";
import { driveLifecycle, lifecycleEdgeSource } from "./lifecycle.js";
import { observe, type Observer } from "./expectations.js";
import type { LayerVector } from "./vectors.js";
import { wantCoreOptions, driveWant } from "./want.js";
import { DriverWorld, type DriverLogEntry, type DriverOptions } from "./world.js";

/**
 * What the driver saw of one vector: `observed` in the shape of the vector's `then`, every log written, and what
 * reached the host's error sink.
 */
export interface LayerWitness {
  readonly id: string;
  readonly observed: Record<string, unknown>;
  readonly logs: readonly DriverLogEntry[];
  readonly sunk: readonly unknown[];
}

interface OpDriver {
  readonly coreOptions: (vector: LayerVector) => CoreOptions;
  readonly edgeSource: (vector: LayerVector) => EdgeSource;
  readonly drive: (vector: LayerVector, world: DriverWorld) => Promise<Record<string, Observer>>;
}

const opDrivers: Readonly<Record<string, OpDriver>> = {
  consume: { coreOptions: () => ({}), edgeSource: () => EdgeSource.Capabilities, drive: driveConsume },
  want: { coreOptions: wantCoreOptions, edgeSource: () => EdgeSource.Capabilities, drive: driveWant },
  lifecycle: { coreOptions: () => ({}), edgeSource: lifecycleEdgeSource, drive: driveLifecycle },
};

/**
 * Builds the vector's `given` through a host on the real core and standard, drives it, and answers every field of
 * its `then` from the run. What the host's shutdown makes the run's listeners hear or log afterwards is not read.
 *
 * @throws Error for an op, a given field, a step kind or a `then` field this driver does not know.
 */
export async function witnessLayerVector(vector: LayerVector, options: DriverOptions = {}): Promise<LayerWitness> {
  const opDriver = opDrivers[vector.op];
  if (opDriver === undefined) {
    throw new Error(`The vector ${vector.id} has the op ${vector.op}, which this driver does not drive.`);
  }
  const world = new DriverWorld(options, opDriver.coreOptions(vector), opDriver.edgeSource(vector));
  try {
    const observers = await opDriver.drive(vector, world);
    return { id: vector.id, observed: observe(vector.id, vector.then, observers), logs: [...world.logs], sunk: [...world.sunk] };
  } finally {
    await world.close(options);
  }
}
