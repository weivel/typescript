import { DISCARD, ServiceHub } from "../../engine/index.js";
import { ManualScheduler } from "../manual-scheduler.js";
import type { Operation } from "../operation.js";
import { settledTurn, settlementOf } from "./settlement.js";

/**
 * @implNote The timeout is passed only when the vector names one. Defaulting an absent one would
 * turn the engine's unbounded wait into the driver's bounded one, and the vector about waiting
 * without a deadline would then measure the driver.
 * @implNote The clock is advanced one due tick at a time with a turn between, because a promise
 * settles a reaction later than the tick that settled it, and `atMillis` is the tick's time.
 */
export const want: Operation = async (given) => {
  const serviceId = String((given.service as Record<string, unknown> | undefined)?.id);
  const clock = new ManualScheduler();
  const hub = new ServiceHub({ scheduler: clock, diagnostics: DISCARD, wellKnown: [serviceId] });
  const timeout = numberOrNull(given.timeoutMillis);
  const asked = timeout === null ? hub.forConsumer("the-consumer").want(serviceId) : hub.forConsumer("the-consumer").want(serviceId, timeout);
  let atMillis: number | null = null;
  const settlement = settlementOf(asked, () => {
    atMillis = clock.now();
  });
  const registerAt = numberOrNull(given.registerAtMillis);
  if (registerAt !== null) {
    clock.schedule(() => {
      hub.forConsumer("the-provider").register(serviceId, { name: () => "the conformance service" });
    }, registerAt);
  }
  const horizon = numberOrNull(given.horizonMillis) ?? 0;
  for (let due = clock.nextDueMillis(); due !== undefined && due <= horizon; due = clock.nextDueMillis()) {
    clock.advanceTo(due);
    await settledTurn();
  }
  clock.advanceTo(horizon);
  await settledTurn();
  return { settled: settlement.state === "settled", timedOut: settlement.state === "rejected", atMillis };
};

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}
