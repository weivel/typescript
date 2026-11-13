import type { CoreEvent } from "../core/index.js";

/**
 * The layer's objects by the core's handles. It holds no rule of its own: an entry goes when the core's answer or
 * event that ends it arrives, and a handle with no entry, stale or never known, answers absent.
 */
export class HandleTable<Value> {
  readonly #entries = new Map<bigint, Value>();

  add(handle: bigint, value: Value): void {
    this.#entries.set(handle, value);
  }

  lookup(handle: bigint): Value | undefined {
    return this.#entries.get(handle);
  }

  has(handle: bigint): boolean {
    return this.#entries.has(handle);
  }

  drop(handle: bigint): boolean {
    return this.#entries.delete(handle);
  }

  get size(): number {
    return this.#entries.size;
  }
}

/**
 * What each plugin holds: the object it was handed for an implementation handle, per holding plugin. A holding goes
 * only with the WEIVEL_EVENT_REVOKED that ends it.
 *
 * @remarks No call drops a plugin's holdings: the core revokes all of them on release and quarantine, and revokes
 * what a released plugin took late before weivel_forget_plugin forgets it.
 */
export class HoldingTable<Value> {
  readonly #holdingsByPlugin = new Map<bigint, HandleTable<Value>>();

  hold(plugin: bigint, implementation: bigint, value: Value): void {
    let holdings = this.#holdingsByPlugin.get(plugin);
    if (holdings === undefined) {
      holdings = new HandleTable<Value>();
      this.#holdingsByPlugin.set(plugin, holdings);
    }
    holdings.add(implementation, value);
  }

  lookup(plugin: bigint, implementation: bigint): Value | undefined {
    return this.#holdingsByPlugin.get(plugin)?.lookup(implementation);
  }

  /** Drops the holding a revoked event names, when the event is one; answers whether it dropped one. */
  apply(event: CoreEvent): boolean {
    if (event.kind !== "revoked") {
      return false;
    }
    const holdings = this.#holdingsByPlugin.get(event.plugin);
    const dropped = holdings?.drop(event.implementation) ?? false;
    if (holdings?.size === 0) {
      this.#holdingsByPlugin.delete(event.plugin);
    }
    return dropped;
  }

  /** How many plugins hold anything. */
  get holderCount(): number {
    return this.#holdingsByPlugin.size;
  }
}
