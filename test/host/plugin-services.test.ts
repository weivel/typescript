import { describe, expect, it } from "vitest";
import type { PluginContext } from "../../src/context/index.ts";
import { alive, createHostWorld, plugin, pluginDirectory, registerDirectory, settle, type HostWorld } from "./world.ts";

const id = "weivel.config";

interface Opened {
  readonly world: HostWorld;
  readonly handles: Map<string, bigint>;
  readonly contexts: Map<string, PluginContext>;
}

/** A host holding `names` open, each consuming `id`, none of them activated. */
function opened(...names: string[]): Opened {
  const world = createHostWorld();
  const handles = registerDirectory(world, pluginDirectory(names.map((name) => plugin({ importName: name, services: { consumes: [id] } })))).registered;
  const contexts = new Map(names.map((name) => [name, alive(world.host.open(handles.get(name)!))] as const));
  return { world, handles, contexts };
}

function got(context: PluginContext): unknown {
  return context.services.get(context.service(id));
}

describe("a service the host offers one plugin", () => {
  it("reaches each plugin offered it as its own object, and a plugin offered nothing as nothing", () => {
    const { world, handles, contexts } = opened("alpha", "beta", "gamma");
    const alphas = { owner: "alpha" };
    const betas = { owner: "beta" };

    alive(world.host.registerPluginService(handles.get("alpha")!, { id }, alphas));
    alive(world.host.registerPluginService(handles.get("beta")!, { id }, betas));

    expect(got(contexts.get("alpha")!)).toBe(alphas);
    expect(got(contexts.get("beta")!)).toBe(betas);
    expect(got(contexts.get("gamma")!)).toBeUndefined();
  });

  it("settles a want with the first plugin offered it as its own object, and a plugin offered it later hears nothing", async () => {
    const { world, handles, contexts } = opened("alpha", "beta");
    const alpha = contexts.get("alpha")!;
    const heard: unknown[] = [];
    const wanted = alpha.services.want(alpha.service(id));
    contexts.get("beta")!.services.watch(alpha.service(id), (object) => heard.push(object));
    const alphas = { owner: "alpha" };
    const betas = { owner: "beta" };

    alive(world.host.registerPluginService(handles.get("alpha")!, { id }, alphas));
    alive(world.host.registerPluginService(handles.get("beta")!, { id }, betas));
    await settle();

    expect(await wanted).toBe(alphas);
    expect(heard).toEqual([undefined]);
  });

  it("is withdrawn from one plugin alone, and unregistered with the last withdrawal", () => {
    const { world, handles, contexts } = opened("alpha", "beta");
    const withdrawAlpha = alive(world.host.registerPluginService(handles.get("alpha")!, { id }, { owner: "alpha" }));
    const withdrawBeta = alive(world.host.registerPluginService(handles.get("beta")!, { id }, { owner: "beta" }));

    withdrawAlpha();
    withdrawAlpha();
    const afterOne = { alpha: got(contexts.get("alpha")!), beta: got(contexts.get("beta")!), registered: contexts.get("alpha")!.services.ids() };
    withdrawBeta();

    expect(afterOne).toEqual({ alpha: undefined, beta: { owner: "beta" }, registered: [id] });
    expect(got(contexts.get("beta")!)).toBeUndefined();
    expect(contexts.get("alpha")!.services.ids()).toEqual([]);
  });

  it("is refused for an id the host registers for every plugin, and the other way round", () => {
    const { world, handles } = opened("alpha");
    const alpha = handles.get("alpha")!;
    const unregister = alive(world.host.registerHostService({ id }, {}));

    expect(() => world.host.registerPluginService(alpha, { id }, {})).toThrow(/registered for every plugin/);
    unregister();
    alive(world.host.registerPluginService(alpha, { id }, {}));
    expect(() => world.host.registerHostService({ id }, {})).toThrow(/offered to plugins one by one/);
  });

  it("is refused a second time for the same plugin, and for a plugin the host never registered", () => {
    const { world, handles } = opened("alpha");
    alive(world.host.registerPluginService(handles.get("alpha")!, { id }, {}));

    expect(() => world.host.registerPluginService(handles.get("alpha")!, { id }, {})).toThrow(/already offered/);
    expect(() => world.host.registerPluginService(123456789n, { id }, {})).toThrow(/registered no plugin/);
  });
});
