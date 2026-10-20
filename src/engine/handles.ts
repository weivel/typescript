import type { DiagnosticSink } from "./diagnostics.js";

/** One served instance, and the means to kill it. */
export interface Handle {
  get(): unknown;
  revoke(): void;
}

/** How a served service is wrapped so that a consumer still holding it is told when it is withdrawn. */
export interface Handles {
  around(serviceId: string, service: unknown): Handle;
}

/**
 * What a read or call through a withdrawn service throws.
 *
 * @remarks
 * Distinct from `PluginError` because nothing here is a plugin's mistake: the service was correct,
 * and then it was gone. Recognised by its `name` marker, as `PluginError` is.
 */
export interface ServiceRevoked extends Error {
  readonly name: "ServiceRevoked";
  readonly serviceId: string;
}

export function serviceRevoked(serviceId: string): ServiceRevoked {
  const failure = new Error(`service "${serviceId}" was withdrawn while a consumer still held it`);
  return Object.assign(failure, { name: "ServiceRevoked" as const, serviceId });
}

export function isServiceRevoked(value: unknown): value is ServiceRevoked {
  return value instanceof Error && value.name === "ServiceRevoked";
}

/**
 * The backing a host gets when it supplies none: the instance as it is.
 *
 * @implNote Reported on revocation rather than on wrapping. Wrapping happens on every lookup;
 * withdrawal is the moment the promise is actually broken, and it is rare.
 */
export function unwrappedHandles(diagnostics: DiagnosticSink): Handles {
  return {
    around: (serviceId, service) =>
      handedOverAsItIs(service, () =>
        diagnostics(
          `service "${serviceId}" was withdrawn, and a consumer holding it was handed the instance unwrapped, so nothing will tell it`,
        ),
      ),
  };
}

/** A backing over the language's own `Proxy`: every read or call through a revoked handle throws `ServiceRevoked`. */
export function proxyHandles(diagnostics: DiagnosticSink): Handles {
  return {
    around: (serviceId, service) => {
      if (!isWrappable(service)) {
        return handedOverAsItIs(service, () =>
          diagnostics(
            `service "${serviceId}" was withdrawn, and a consumer holding it was handed a ${typeof service}, which cannot be wrapped, so nothing will tell it`,
          ),
        );
      }
      return revocable(serviceId, service);
    },
  };
}

function handedOverAsItIs(service: unknown, onRevoke: () => void): Handle {
  return { get: () => service, revoke: onRevoke };
}

function isWrappable(service: unknown): service is object {
  return (typeof service === "object" && service !== null) || typeof service === "function";
}

/**
 * The names the language reads implicitly, answered on a revoked handle rather than refused.
 *
 * @remarks
 * Resolving a promise with a handle reads `then`, and a logger reads `Symbol.toPrimitive` and
 * `toString`. A logger stringifying a dead handle inside a catch block would otherwise throw from
 * within error handling and replace the real failure (binding 9.4).
 */
function answeredWhenRevoked(serviceId: string, key: PropertyKey): { value: unknown } | undefined {
  const description = (): string => `[revoked service "${serviceId}"]`;
  if (key === "then") return { value: undefined };
  if (key === "toString" || key === Symbol.toPrimitive) return { value: description };
  return undefined;
}

/**
 * @implNote A Proxy `get` trap must return the target's own value for a non-configurable,
 * non-writable data property, or the language throws a `TypeError`; a frozen service is made of
 * nothing else.
 */
function pinnedValue(target: object, key: PropertyKey): { value: unknown } | undefined {
  const own = Reflect.getOwnPropertyDescriptor(target, key);
  return own !== undefined && "value" in own && own.configurable === false && own.writable === false
    ? { value: own.value }
    : undefined;
}

function revocable(serviceId: string, target: object): Handle {
  let revoked = false;
  const guardedMethods = new WeakMap<Function, Function>();
  const refuseWhenRevoked = (): void => {
    if (revoked) throw serviceRevoked(serviceId);
  };

  /**
   * @implNote A Proxy over the method rather than a closure, so a class read through the handle
   * still constructs, still answers `instanceof`, and keeps its `name`, `length` and statics.
   * @implNote Called on the target, not the proxy, when invoked through the handle or detached,
   * because a class instance's private fields are not reachable through a Proxy receiver; a
   * result that IS the target is handed back as the handle, so a fluent call cannot leak it.
   */
  const guarded = (method: Function): Function => {
    const known = guardedMethods.get(method);
    if (known !== undefined) return known;
    const methodProxy: Function = new Proxy(method, {
      apply(callable, thisArgument, args) {
        refuseWhenRevoked();
        const self = thisArgument === proxy || thisArgument === undefined ? target : thisArgument;
        const result: unknown = Reflect.apply(callable, self, args);
        return result === target ? proxy : result;
      },
      construct(constructable, args, newTarget) {
        refuseWhenRevoked();
        return Reflect.construct(constructable, args, newTarget === methodProxy ? constructable : newTarget);
      },
    });
    guardedMethods.set(method, methodProxy);
    return methodProxy;
  };

  const proxy: object = new Proxy(target, {
    get(shadowed, key) {
      const pinned = pinnedValue(shadowed, key);
      if (revoked) {
        const answered = answeredWhenRevoked(serviceId, key);
        if (answered === undefined) throw serviceRevoked(serviceId);
        return pinned === undefined ? answered.value : pinned.value;
      }
      if (pinned !== undefined) return pinned.value;
      const value: unknown = Reflect.get(shadowed, key, shadowed);
      return typeof value === "function" ? guarded(value) : value;
    },
    set(shadowed, key, value) {
      refuseWhenRevoked();
      return Reflect.set(shadowed, key, value, shadowed);
    },
    has(shadowed, key) {
      refuseWhenRevoked();
      return Reflect.has(shadowed, key);
    },
    ownKeys(shadowed) {
      refuseWhenRevoked();
      return Reflect.ownKeys(shadowed);
    },
    getOwnPropertyDescriptor(shadowed, key) {
      refuseWhenRevoked();
      return Reflect.getOwnPropertyDescriptor(shadowed, key);
    },
    defineProperty(shadowed, key, descriptor) {
      refuseWhenRevoked();
      return Reflect.defineProperty(shadowed, key, descriptor);
    },
    deleteProperty(shadowed, key) {
      refuseWhenRevoked();
      return Reflect.deleteProperty(shadowed, key);
    },
    apply(shadowed, thisArgument, args) {
      refuseWhenRevoked();
      return Reflect.apply(shadowed as Function, thisArgument, args);
    },
    construct(shadowed, args, newTarget) {
      refuseWhenRevoked();
      return Reflect.construct(shadowed as Function, args, newTarget as Function);
    },
  });

  return {
    get: () => proxy,
    revoke: () => {
      revoked = true;
    },
  };
}
