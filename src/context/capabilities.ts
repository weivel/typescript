import { ReachKind, Status } from "../core/index.js";
import type { Capabilities, CapabilityType, ImplementationListener } from "./model.js";
import { failureOf } from "./refusal.js";
import { startWatching } from "./services.js";
import { ensureAttached, type Attachment, type ContextState } from "./state.js";

/** The verified implementations of `id`; a refusal is thrown. */
function all(state: ContextState, plugin: bigint, id: string): unknown[] {
  const { listed, implementations } = state.call(() => {
    const listed = state.core.allCapabilities(plugin, id);
    const implementations: unknown[] = [];
    for (const { implementation } of listed.value ?? []) {
      const offered = state.implementations.lookup(implementation);
      if (offered !== undefined) {
        state.hold(plugin, implementation, ReachKind.Capability, offered);
        implementations.push(offered.object);
      }
    }
    return { listed, implementations };
  });
  if (listed.status !== Status.Ok) {
    throw failureOf("weivel_all_capabilities", listed);
  }
  return implementations;
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

/** The capabilities of a context; a call through a detached one throws DetachedError and reaches nothing. */
export function createCapabilities(state: ContextState, attachment: Attachment): Capabilities {
  const plugin = attachment.plugin;
  return {
    all: <Implementation>(type: CapabilityType<Implementation>) => {
      ensureAttached(attachment);
      return all(state, plugin, type.id) as Implementation[];
    },
    watch: <Implementation>(type: CapabilityType<Implementation>, listener: ImplementationListener<Implementation>) => {
      ensureAttached(attachment);
      return startWatching(
        state,
        plugin,
        "weivel_watch_capability",
        () => state.core.watchCapability(plugin, type.id),
        listener as (implementation: unknown, change: string) => void,
      );
    },
  };
}
