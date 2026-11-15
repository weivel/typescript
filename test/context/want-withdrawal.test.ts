import { describe, expect, it } from "vitest";
import type { Manifest } from "../../src/core/index.ts";
import { DetachedError } from "../../src/context/index.ts";
import { createWorld, settle } from "./world.ts";

const thingId = "alpha:thing";
const provider: Manifest = { importName: "alpha", services: { provides: [{ id: thingId }] } };
const consumer: Manifest = { importName: "beta", services: { consumes: [{ id: thingId }] } };

function track(promise: Promise<unknown>): { settled: boolean } {
  const outcome = { settled: false };
  promise.then(
    () => void (outcome.settled = true),
    () => void (outcome.settled = true),
  );
  return outcome;
}

describe("withdrawing a want", () => {
  it("withdraws a want that has not settled, whose result is then never delivered", async () => {
    const world = createWorld();
    const alpha = world.open(provider);
    const beta = world.open(consumer);
    const wanted = beta.context.services.want(beta.context.service(thingId));
    const outcome = track(wanted);

    expect(wanted.withdraw()).toBe(true);
    alpha.context.services.register(alpha.context.service(thingId), {});
    await settle();

    expect(outcome.settled).toBe(false);
    expect(world.dispatched.some((event) => event.kind === "want-settled")).toBe(false);
  });

  it("answers false, withdrawing nothing, for a want that has settled already", async () => {
    const world = createWorld();
    const alpha = world.open(provider);
    const service = {};
    alpha.context.services.register(alpha.context.service(thingId), service);
    const beta = world.open(consumer);
    const wanted = beta.context.services.want(beta.context.service(thingId));

    expect(wanted.withdraw()).toBe(false);
    await expect(wanted).resolves.toBe(service);
  });

  it("answers false for a want withdrawn already, and for one the core refused", async () => {
    const world = createWorld();
    world.open(provider);
    const beta = world.open(consumer);
    const wanted = beta.context.services.want(beta.context.service(thingId));
    wanted.withdraw();
    const refused = beta.context.services.want(beta.context.service("nobody:thing"));
    refused.catch(() => undefined);

    expect(wanted.withdraw()).toBe(false);
    expect(refused.withdraw()).toBe(false);
  });

  it("is answered as detached once the core has forgotten the plugin", async () => {
    const world = createWorld();
    world.open(provider);
    const beta = world.open(consumer);
    const wanted = beta.context.services.want(beta.context.service(thingId));
    wanted.catch(() => undefined);
    world.core.releasePlugin(beta.plugin);
    world.contexts.stopped(beta.plugin);
    world.core.forgetPlugin(beta.plugin);
    world.contexts.forget(beta.plugin);

    expect(() => wanted.withdraw()).toThrow(DetachedError);
  });
});
