import { RefusalError } from "../context/index.js";
import { refuseUnknownKeys, type Observer } from "./expectations.js";
import { kitRefusal, type KitRefusal } from "./refusals.js";
import type { LayerVector } from "./vectors.js";
import { inertEntry, settled, type DriverWorld } from "./world.js";

interface WantGiven {
  readonly service: { readonly id: string };
  readonly registerAtMillis: number | null;
  readonly timeoutMillis: number | null;
  readonly horizonMillis: number;
  readonly schedulerRunsBeforeRegistering?: boolean;
}

const consumerName = "consumer";
const providerName = "provider";

function checkGiven(vector: LayerVector): WantGiven {
  refuseUnknownKeys(`The vector ${vector.id}'s given`, vector.given, [
    "service",
    "registerAtMillis",
    "timeoutMillis",
    "horizonMillis",
    "schedulerRunsBeforeRegistering",
  ]);
  const given = vector.given as unknown as WantGiven;
  refuseUnknownKeys(`The vector ${vector.id}'s service`, given.service, ["id"]);
  return given;
}

/** The core options a want vector runs under: the service is well-known, so the provider may register it as named. */
export function wantCoreOptions(vector: LayerVector) {
  return { wellKnownServices: [checkGiven(vector).service.id] };
}

interface WantOutcome {
  served: boolean;
  timedOut: boolean;
  atMillis: number | null;
  refusal: KitRefusal | null;
}

function followWant(want: Promise<unknown>, world: DriverWorld): WantOutcome {
  const outcome: WantOutcome = { served: false, timedOut: false, atMillis: null, refusal: null };
  want.then(
    () => Object.assign(outcome, { served: true, atMillis: world.time.now() }),
    (reason: unknown) => {
      if (!(reason instanceof RefusalError)) {
        throw reason;
      }
      Object.assign(outcome, { timedOut: true, atMillis: world.time.now(), refusal: kitRefusal(reason) });
    },
  );
  return outcome;
}

/**
 * Asks at time 0 on the driver's virtual time and runs time to the horizon, registering the provider at
 * `registerAtMillis`. The scheduler runs the tasks due on the way there unless `schedulerRunsBeforeRegistering` is
 * false, when only the clock moves, so the registration meets a deadline the layer's timer has not fired.
 */
export async function driveWant(vector: LayerVector, world: DriverWorld): Promise<Record<string, Observer>> {
  const given = checkGiven(vector);
  const id = given.service.id;
  world.register([
    { manifest: { importName: consumerName, api: 1, services: { consumes: [{ id }] } }, entry: inertEntry },
    { manifest: { importName: providerName, api: 1, services: { provides: [{ id }] }, entry: `${providerName}.ts` }, entry: inertEntry },
  ]);
  const consumer = world.open(consumerName);
  const provider = world.open(providerName);
  const outcome = followWant(
    consumer.services.want(consumer.service(id), given.timeoutMillis === null ? {} : { timeoutMillis: given.timeoutMillis }),
    world,
  );
  await settled();
  if (given.registerAtMillis !== null) {
    if (given.schedulerRunsBeforeRegistering === false) {
      world.time.moveClockTo(given.registerAtMillis);
    } else {
      await world.time.runUntil(given.registerAtMillis);
    }
    provider.services.register(provider.service(id), { provider: providerName });
    await settled();
  }
  await world.time.runUntil(given.horizonMillis);
  return {
    settled: () => outcome.served,
    timedOut: () => outcome.timedOut,
    atMillis: () => outcome.atMillis,
    refusal: () => outcome.refusal,
    timer: () => world.timerMoves.map((move) => [...move]),
    fired: () => [...world.time.fired],
  };
}
