import { describe, expect, it } from "vitest";
import { isServiceRevoked, proxyHandles, unwrappedHandles } from "../../src/engine/index.js";

class Counter {
  #count = 0;

  increment(): number {
    this.#count += 1;
    return this.#count;
  }

  get count(): number {
    return this.#count;
  }
}

function caught(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("proxyHandles", () => {
  it("returns a frozen service's own values through a live handle", () => {
    const summary = (): string => "frozen";
    const nested = { depth: 1 };
    const frozen = Object.freeze({ summary, nested, label: "accounts" });
    const live = proxyHandles(() => {}).around("accounts", frozen).get() as typeof frozen;
    expect(live.summary).toBe(summary);
    expect(live.nested).toBe(nested);
    expect(live.label).toBe("accounts");
    expect(live.summary()).toBe("frozen");
  });

  it("keeps a class instance's private state working through a live handle", () => {
    const live = proxyHandles(() => {}).around("counter", new Counter()).get() as Counter;
    expect(live.increment()).toBe(1);
    const detached = live.increment;
    expect(detached()).toBe(2);
    expect(live.count).toBe(2);
  });

  it("hands the same function for the same property on every read", () => {
    const live = proxyHandles(() => {}).around("counter", new Counter()).get() as Counter;
    expect(live.increment).toBe(live.increment);
  });

  it("resolves an awaited live handle to the handle itself", async () => {
    const handle = proxyHandles(() => {}).around("accounts", { name: () => "a" });
    const live = handle.get();
    expect(await Promise.resolve(live)).toBe(live);
  });

  it("still answers then, toString and toPrimitive once revoked", () => {
    const handle = proxyHandles(() => {}).around("accounts", { name: () => "a" });
    const held = handle.get() as Record<PropertyKey, unknown>;
    handle.revoke();
    expect(() => String(held)).not.toThrow();
    expect(() => `${held}`).not.toThrow();
    expect(() => held.then).not.toThrow();
    expect(held.then).toBeUndefined();
    expect(String(held)).toContain("accounts");
  });

  it("refuses any other read through a revoked handle, naming the service", () => {
    const handle = proxyHandles(() => {}).around("accounts", { name: () => "a", size: 3 });
    const held = handle.get() as { name(): string; size: number };
    handle.revoke();
    const failure = caught(() => held.size);
    expect(isServiceRevoked(failure)).toBe(true);
    expect((failure as { serviceId: string }).serviceId).toBe("accounts");
    expect((failure as Error).name).toBe("ServiceRevoked");
    expect(isServiceRevoked(caught(() => held.name()))).toBe(true);
  });

  it("refuses a method read before revocation and called after", () => {
    const handle = proxyHandles(() => {}).around("counter", new Counter());
    const increment = (handle.get() as Counter).increment;
    handle.revoke();
    expect(isServiceRevoked(caught(() => increment()))).toBe(true);
  });

  it("refuses a call through a revoked function service", () => {
    const handle = proxyHandles(() => {}).around("greeter", () => "hello");
    const greet = handle.get() as () => string;
    expect(greet()).toBe("hello");
    handle.revoke();
    expect(isServiceRevoked(caught(() => greet()))).toBe(true);
  });

  it("hands a primitive over as it is and reports only when it is revoked", () => {
    const reported: string[] = [];
    const handle = proxyHandles((message) => reported.push(message)).around("limit", 42);
    expect(handle.get()).toBe(42);
    expect(reported).toEqual([]);
    handle.revoke();
    expect(reported).toHaveLength(1);
    expect(reported[0]).toContain("limit");
  });
});

describe("proxyHandles transparency", () => {
  class Widget {
    static kind = "widget";
  }

  class Fluent {
    #count = 0;

    self(): this {
      return this;
    }

    increment(): number {
      this.#count += 1;
      return this.#count;
    }
  }

  it("constructs and recognises a class read through a live handle", () => {
    const live = proxyHandles(() => {}).around("widgets", { Widget }).get() as { Widget: typeof Widget };
    const made = new live.Widget();
    expect(made).toBeInstanceOf(Widget);
    expect(made instanceof live.Widget).toBe(true);
    expect(live.Widget.kind).toBe("widget");
  });

  it("refuses to construct a class read through a revoked handle", () => {
    const handle = proxyHandles(() => {}).around("widgets", { Widget });
    const ClassRead = (handle.get() as { Widget: typeof Widget }).Widget;
    handle.revoke();
    expect(isServiceRevoked(caught(() => new ClassRead()))).toBe(true);
  });

  it("keeps a method's own name and length", () => {
    const live = proxyHandles(() => {}).around("counter", new Counter()).get() as Counter;
    expect(live.increment.name).toBe(Counter.prototype.increment.name);
    expect(live.increment.length).toBe(Counter.prototype.increment.length);
  });

  it("hands back the handle, not the instance, from a method returning this", () => {
    const handle = proxyHandles(() => {}).around("fluent", new Fluent());
    const escaped = (handle.get() as Fluent).self();
    expect(escaped).toBe(handle.get());
    handle.revoke();
    expect(isServiceRevoked(caught(() => escaped.increment()))).toBe(true);
  });
});

describe("unwrappedHandles", () => {
  it("hands the instance over and reports when it is revoked", () => {
    const reported: string[] = [];
    const service = { name: () => "a" };
    const handle = unwrappedHandles((message) => reported.push(message)).around("accounts", service);
    expect(handle.get()).toBe(service);
    expect(reported).toEqual([]);
    handle.revoke();
    expect(reported).toHaveLength(1);
    expect(reported[0]).toContain("accounts");
  });
});

describe("isServiceRevoked", () => {
  it("recognises nothing but a revocation", () => {
    expect(isServiceRevoked(new Error("boom"))).toBe(false);
    expect(isServiceRevoked({ name: "ServiceRevoked" })).toBe(false);
    expect(isServiceRevoked(undefined)).toBe(false);
  });
});
