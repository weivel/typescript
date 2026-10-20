import { DISCARD, ServiceHub } from "../../engine/index.js";
import { ManualScheduler } from "../manual-scheduler.js";
import type { Operation } from "../operation.js";
import type { Settlement } from "./settlement.js";
import { settledTurn, settlementOf } from "./settlement.js";

export const scope: Operation = async (given) => {
  const clock = new ManualScheduler();
  const hub = new ServiceHub({ scheduler: clock, diagnostics: DISCARD });
  const lookups: boolean[] = [];
  const wants: Settlement[] = [];
  for (const each of arrayOf(given.steps)) {
    const step = each as Record<string, unknown>;
    const consumer = String(step.consumer);
    if ("register" in step) {
      hub.forConsumer(consumer).register(String(step.register), { name: () => "the conformance service" });
    } else if ("want" in step) {
      wants.push(settlementOf(hub.forConsumer(consumer).want(String(step.want))));
    } else if ("release" in step) {
      hub.release(String(step.release));
    } else if ("lookup" in step) {
      lookups.push(hub.get(String(step.lookup)) !== undefined);
    } else {
      throw new Error(`unknown scope step ${JSON.stringify(step)}`);
    }
  }
  clock.fireAll();
  await settledTurn();
  return { lookups, wants: wants.map((settlement) => settlement.state) };
};

function arrayOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
