import { ReachKind, Status } from "../core/index.js";
import type { Capabilities, CapabilityType, ImplementationListener } from "./model.js";
import { failureOf } from "./refusal.js";
import { startWatching } from "./services.js";
import type { ContextState } from "./state.js";

function all(state: ContextState, plugin: bigint, id: string): unknown[] {
  return state.call(() => {
    const implementations: unknown[] = [];
    for (const { implementation } of state.core.allCapabilities(plugin, id).value ?? []) {
      const offered = state.implementations.lookup(implementation);
      if (offered !== undefined) {
        state.hold(plugin, implementation, ReachKind.Capability, offered);
        implementations.push(offered.object);
      }
    }
    return implementations;
  });
}

/** Provides `object` as the plugin's implementation of `id`, throwing the core's refusal. */
export function provideCapability(state: ContextState, plugin: bigint, id: string, object: unknown): void {
  const result = state.call(() => {
    const provided = state.core.provideCapability(plugin, id);
    if (provided.status === Status.Ok && provided.value !== undefined) {
      state.implementations.add(provided.value, { id, object, owner: plugin });
      state.rememberHandle(plugin, provided.value);
    }
    return provided;
  });
  if (result.status !== Status.Ok) {
    throw failureOf("weivel_provide_capability", result);
  }
}

export function createCapabilities(state: ContextState, plugin: bigint): Capabilities {
  return {
    all: <Implementation>(type: CapabilityType<Implementation>) => all(state, plugin, type.id) as Implementation[],
    watch: <Implementation>(type: CapabilityType<Implementation>, listener: ImplementationListener<Implementation>) =>
      startWatching(
        state,
        plugin,
        () => state.core.watchCapability(plugin, type.id),
        listener as (implementation: unknown, change: string) => void,
      ),
  };
}
