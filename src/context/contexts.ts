import type { Core, CoreEvent, EventDispatcher, Manifest } from "../core/index.js";
import { HOST } from "../core/index.js";
import { systemClock, type Clock } from "../timer/index.js";
import { createCapabilities, provideCapability } from "./capabilities.js";
import { handleEvent } from "./event-handlers.js";
import type { CapabilityType, Logger, PluginContext, PluginEventListener, RegisterOptions, ServiceType } from "./model.js";
import { createServices, registerService } from "./services.js";
import { ContextState } from "./state.js";

export interface PluginContextsOptions {
  /** The time handed to the core with a want or a capacity answer; the timer's clock by default. */
  readonly clock?: Clock;
  /** Where what goes wrong in an object the host itself offered is logged; the console by default. */
  readonly log?: Logger;
}

export const consoleLogger: Logger = {
  debug: (message) => console.debug(message),
  info: (message) => console.info(message),
  warn: (message) => console.warn(message),
  error: (message, cause) => (cause === undefined ? console.error(message) : console.error(message, cause)),
};

/**
 * The contexts of every plugin of one core, and the objects behind the core's handles that they share.
 *
 * @remarks The host routes every event the core dispatches to `receive`, builds a plugin's context with `create`
 * once the core has opened the plugin, and calls `forget` once the core has forgotten it.
 */
export class PluginContexts {
  readonly #state: ContextState;

  /** Hand every event the core dispatches to this, in the core's order. */
  readonly receive: EventDispatcher = (event: CoreEvent) => this.#state.receive(event);

  constructor(core: Core, options: PluginContextsOptions = {}) {
    const hostLog = options.log ?? consoleLogger;
    this.#state = new ContextState(core, options.clock ?? systemClock, hostLog, (event) => handleEvent(this.#state, event));
    this.#state.plugins.set(HOST, { log: hostLog, eventListeners: new Set(), handles: new Set() });
  }

  /**
   * Runs `step` once every event the core has drained so far has reached the contexts and been handled, so a step
   * that ends a plugin's entries never runs ahead of the events its own call queued for it.
   */
  whenEventsHandled(step: () => void): void {
    this.#state.core.whenDispatched(() => this.#state.whenHandled(step));
  }

  /** Builds the context of a plugin the core has opened, its log forwarded to `log`. */
  create(plugin: bigint, manifest: Manifest, log: Logger): PluginContext {
    const handles = this.#state.plugins.get(plugin)?.handles ?? new Set<bigint>();
    const eventListeners = new Set<PluginEventListener>();
    this.#state.plugins.set(plugin, { log, eventListeners, handles });
    return {
      capabilities: createCapabilities(this.#state, plugin),
      capability: <Implementation>(id: string): CapabilityType<Implementation> => ({ id }),
      events: {
        listen: (listener) => {
          eventListeners.add(listener);
          return () => eventListeners.delete(listener);
        },
      },
      log,
      manifest,
      provide: (type, implementation) => provideCapability(this.#state, plugin, type.id, implementation),
      service: <Service>(id: string): ServiceType<Service> => ({ id }),
      services: createServices(this.#state, plugin),
    };
  }

  /**
   * Registers a service the host itself supplies, under WEIVEL_HOST; the answer unregisters it.
   *
   * @throws RefusalError when the core refuses it.
   */
  registerHostService<Service>(type: ServiceType<Service>, service: Service, options: RegisterOptions = {}): () => void {
    return registerService(this.#state, HOST, type.id, service, options.capacity);
  }

  /** What `plugin` holds for the implementation handle the core handed it, or undefined once revoked. */
  held(plugin: bigint, implementation: bigint): unknown {
    return this.#state.holdings.lookup(plugin, implementation)?.implementation;
  }

  /**
   * Ends the entries of a plugin the core has released or quarantined: every registration, implementation and watch
   * the core ended with it. Their disposers then ask the core nothing, and their objects stay answerable only to
   * the events the core queued before.
   */
  stopped(plugin: bigint): void {
    const state = this.#state.plugins.get(plugin);
    if (state === undefined || plugin === HOST) {
      return;
    }
    for (const handle of [...state.handles]) {
      this.#state.markEnded(plugin, handle);
      this.#state.dropWatch(handle);
    }
    this.#state.dropEndedWhenIdle();
  }

  /** How many live handles of the plugin the contexts track: what `forget` would drop. */
  tracked(plugin: bigint): number {
    return this.#state.plugins.get(plugin)?.handles.size ?? 0;
  }

  /** Drops everything of a plugin the core has forgotten: its context, and every object behind its handles. */
  forget(plugin: bigint): void {
    const forgotten = this.#state.plugins.get(plugin);
    if (forgotten === undefined || plugin === HOST) {
      return;
    }
    for (const handle of forgotten.handles) {
      this.#state.services.drop(handle);
      this.#state.implementations.drop(handle);
      this.#state.wants.drop(handle);
      this.#state.watches.drop(handle);
    }
    this.#state.plugins.delete(plugin);
  }
}
