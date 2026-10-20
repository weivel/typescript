import { DISCARD, isServiceRevoked, proxyHandles, ServiceHub } from "../../engine/index.js";
import { NEVER } from "../../index.js";
import type { Operation } from "../operation.js";

interface ConformanceService {
  name(): string;
}

/**
 * @implNote `use` calls the handle taken at the FIRST lookup. A handle fetched after the
 * withdrawal would simply be absent, which proves nothing about what a consumer already holding
 * one is told.
 */
export const revoke: Operation = (given) => {
  const serviceId = String((given.service as Record<string, unknown> | undefined)?.id);
  const hub = new ServiceHub({ scheduler: NEVER, diagnostics: DISCARD, wellKnown: [serviceId], handles: proxyHandles(DISCARD) });
  const registry = hub.forConsumer("the-conformance-plugin");
  let unregister: (() => void) | undefined;
  let held: ConformanceService | undefined;
  const lookups: boolean[] = [];
  const result: Record<string, unknown> = {};
  for (const step of arrayOf(given.steps)) {
    if (step === "register") {
      unregister = registry.register(serviceId, { name: () => "the conformance service" });
    } else if (step === "lookup") {
      const found = hub.get(serviceId);
      lookups.push(found !== undefined);
      held ??= found as ConformanceService | undefined;
    } else if (step === "revoke") {
      unregister?.();
    } else if (step === "use") {
      Object.assign(result, use(held));
    } else {
      throw new Error(`unknown step '${String(step)}'`);
    }
  }
  return { ...result, lookups };
};

function use(held: ConformanceService | undefined): Record<string, unknown> {
  if (held === undefined) throw new Error("no handle was held, so 'use' has nothing to use");
  try {
    return { name: held.name(), used: true, reason: null };
  } catch (failure) {
    if (!isServiceRevoked(failure)) throw failure;
    return { used: false, reason: "revoked" };
  }
}

function arrayOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
