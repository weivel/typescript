import koffi from "koffi";
import { describe, expect, it } from "vitest";
import { HOST, Status } from "../../src/core/index.ts";
import type { PluginContext, PluginEvent, RevokedPluginEvent } from "../../src/context/index.ts";
import { definitionSizeFloor, LibraryUnloadedError, type LibraryDefinition } from "../../src/host/index.ts";
import { hostInternals } from "../../src/host/host.ts";
import { ContextFact, FunctionKind, type LibraryDeclaration, type LibraryFunction } from "../../src/standard/index.ts";
import { realStandard } from "../real-standard.ts";
import { alive, createHostWorld, echoLibraryPath, type HostWorld } from "./world.ts";

const echoDefinition = koffi.struct({ size: "uint32_t", context: "void *", echo: "void *", release: "void *", count_unloads: "void *" });
const countUnloadsOperation = koffi.proto("void", ["void *", "void *"]);
/** Counters a binary writes when it closes, which may be at process exit, so none is ever freed. */
const counters: object[] = [];

function definitionFunction(symbol = "echo_service_definition"): LibraryFunction {
  return { name: "definition", symbol, kind: FunctionKind.Definition, context: 0 };
}

const bytesFunction: LibraryFunction = { name: "echo", symbol: "echo_echo", kind: FunctionKind.Bytes, context: 0 };

function declaration(services: LibraryDeclaration["services"], release: string | null = null): LibraryDeclaration {
  return { importName: "echo", version: "0.2.0", release, services };
}

const definitionOnly = declaration([{ id: "echo", functions: [definitionFunction()] }]);

/** A plugin opened on the host, consuming `ids`, with every event the host hands it recorded. */
function holder(world: HostWorld, name: string, ids: readonly string[], provides: readonly string[] = []): { context: PluginContext; events: PluginEvent[] } {
  const services = { consumes: ids.map((id) => ({ id })), provides: provides.map((id) => ({ id })) };
  const entry = provides.length > 0 ? { entry: `${name}.ts` } : {};
  const registered = alive(world.host.register({ importName: name, api: 1, services, ...entry }, { activate() {} }));
  const context = alive(world.host.open(registered.plugin!));
  const events: PluginEvent[] = [];
  context.events.listen((event) => void events.push(event));
  return { context, events };
}

/** Hands the binary a counter it adds one to when it is closed, through `definition`, and answers how to read it. */
function countUnloads(definition: LibraryDefinition): () => number {
  const operations = koffi.decode(definition.pointer, echoDefinition) as Record<string, unknown>;
  const counter = koffi.alloc("uint64_t", 1) as object;
  koffi.encode(counter, "uint64_t", 0);
  counters.push(counter);
  koffi.call(operations.count_unloads, countUnloadsOperation, operations.context, counter);
  return () => Number(koffi.decode(counter, "uint64_t") as bigint | number);
}

function revocationOf(events: readonly PluginEvent[], id: string): RevokedPluginEvent {
  const revoked = events.find((event): event is RevokedPluginEvent => event.kind === "revoked" && event.id === id);
  if (revoked === undefined) {
    throw new Error(`no revocation of ${id} reached the plugin`);
  }
  return revoked;
}

function hostReaches(world: HostWorld, id: string): boolean {
  return hostInternals(world.host).core.getService(HOST, id).status === Status.Ok;
}

describe("a definition service", () => {
  it("is the struct's own address, at least two pointers long, carrying the library it came from", () => {
    const world = createHostWorld();
    const library = alive(world.host.loadLibrary(definitionOnly, echoLibraryPath));
    const definition = library.definitions.get("echo")!;
    const { context } = holder(world, "agenda", ["echo"]);

    expect(definitionSizeFloor).toBe(2 * koffi.sizeof("void *"));
    expect(context.services.get(context.service("echo"))).toBe(definition);
    expect(definition.library).toBe("echo");
    expect(koffi.decode(definition.pointer, "uint32_t")).toBe(koffi.sizeof(echoDefinition));
  });

  it("is read by the standard as the definition kind, and needs no release when every service is one", () => {
    const read = realStandard().readLibrary(
      JSON.stringify({ importName: "echo", version: "0.2.0", services: [{ id: "echo", functions: [{ name: "definition", symbol: "echo_service_definition", kind: "definition" }] }] }),
    );

    expect(read.value?.release).toBeNull();
    expect(read.value?.services[0]!.functions[0]!.kind).toBe(FunctionKind.Definition);
    expect(() => alive(createHostWorld().host.loadLibrary(read.value!, echoLibraryPath))).not.toThrow();
  });

  it.each([
    ["beside another function", declaration([{ id: "echo", functions: [definitionFunction(), bytesFunction] }], "echo_release"), /beside another function/],
    ["with context facts", declaration([{ id: "echo", functions: [{ ...definitionFunction(), context: ContextFact.Home }] }]), /reads context facts/],
    ["with bytes functions and no release", declaration([{ id: "echo", functions: [bytesFunction] }]), /bytes functions and no release/],
  ])("refuses a declaration the caller built %s, registering nothing", (_case, built, message) => {
    const world = createHostWorld();

    expect(() => world.host.loadLibrary(built, echoLibraryPath)).toThrow(message);
    expect(hostReaches(world, "echo")).toBe(false);
  });

  it("is revoked at the unload while the binary stays open, and a bytes call made after it is still refused", () => {
    const world = createHostWorld();
    const library = alive(
      world.host.loadLibrary(declaration([{ id: "echo-bytes", functions: [bytesFunction] }, { id: "echo", functions: [definitionFunction()] }], "echo_release"), echoLibraryPath),
    );
    const { context, events } = holder(world, "agenda", ["echo", "echo-bytes"]);
    const bytes = context.services.get(context.service<Record<string, (input: Uint8Array) => Uint8Array>>("echo-bytes"))!;
    const unloads = countUnloads(context.services.get(context.service<LibraryDefinition>("echo"))!);

    library.unload();

    expect(unloads()).toBe(0);
    expect(revocationOf(events, "echo")).toBeDefined();
    expect(() => bytes.echo!(new Uint8Array([1]))).toThrow(LibraryUnloadedError);
  });

  it("closes the binary at the last definition release though a bytes answer is still held, since it was copied and released before its call answered", () => {
    const world = createHostWorld();
    const library = alive(
      world.host.loadLibrary(declaration([{ id: "echo-bytes", functions: [bytesFunction] }, { id: "echo", functions: [definitionFunction()] }], "echo_release"), echoLibraryPath),
    );
    const { context, events } = holder(world, "agenda", ["echo", "echo-bytes"]);
    const unloads = countUnloads(context.services.get(context.service<LibraryDefinition>("echo"))!);
    const kept = context.services.get(context.service<Record<string, (input: Uint8Array) => Uint8Array>>("echo-bytes"))!.echo!(new Uint8Array([4, 2]));

    library.unload();
    revocationOf(events, "echo").release();

    expect(unloads()).toBe(1);
    expect(kept).toEqual(new Uint8Array([4, 2]));
  });

  it("counts a holding a watch made, kept until the watcher releases it, a second release asking the core nothing", () => {
    const sunk: unknown[] = [];
    const world = createHostWorld({}, { onListenerError: (error) => void sunk.push(error) });
    const { context, events } = holder(world, "agenda", ["echo"]);
    const heard: unknown[] = [];
    context.services.watch(context.service<LibraryDefinition>("echo"), (definition) => void heard.push(definition));
    const library = alive(world.host.loadLibrary(definitionOnly, echoLibraryPath));
    const unloads = countUnloads(heard[0] as LibraryDefinition);

    library.unload();
    expect(unloads()).toBe(0);
    revocationOf(events, "echo").release();
    revocationOf(events, "echo").release();

    expect(unloads()).toBe(1);
    expect(sunk).toEqual([]);
  });

  it("closes the binary when the host is destroyed, though a holder never released its holding", async () => {
    const world = createHostWorld();
    const library = alive(world.host.loadLibrary(definitionOnly, echoLibraryPath));
    const { context } = holder(world, "agenda", ["echo"]);
    const unloads = countUnloads(context.services.get(context.service<LibraryDefinition>("echo"))!);

    library.unload();
    expect(unloads()).toBe(0);
    await world.host.destroy();

    expect(unloads()).toBe(1);
  });

  it("is undone as a load that fails partway when the core refuses its registration, closing the binary", () => {
    const sunk: unknown[] = [];
    const world = createHostWorld({}, { onListenerError: (error) => void sunk.push(error) });
    const first = alive(world.host.loadLibrary(declaration([{ id: "echo-first", functions: [definitionFunction()] }]), echoLibraryPath));
    const unloads = countUnloads(first.definitions.get("echo-first")!);

    expect(() => world.host.loadLibrary(declaration([{ id: "echo-second", functions: [definitionFunction()] }, { id: "", functions: [definitionFunction("echo_other_service_definition")] }]), echoLibraryPath)).toThrow();
    expect(hostReaches(world, "echo-second")).toBe(false);
    first.unload();

    expect(unloads()).toBe(1);
  });
});

describe("a plugin's registration awaiting releases", () => {
  it("tells the plugin once every holding has been released since its unregistration", () => {
    const world = createHostWorld();
    const owner = holder(world, "owner", [], ["owner:feed"]);
    const consumer = holder(world, "consumer", ["owner:feed"]);
    const service = { feed: true };
    const unregister = owner.context.services.register(owner.context.service("owner:feed"), service, { awaitReleases: true });
    expect(consumer.context.services.get(consumer.context.service("owner:feed"))).toBe(service);

    unregister();
    expect(owner.events).toEqual([]);
    revocationOf(consumer.events, "owner:feed").release();

    expect(owner.events).toEqual([{ kind: "holdings-released", id: "owner:feed", service }]);
  });

  it("hands an owner the release event its own release queued, when nothing held the registration then", async () => {
    const world = createHostWorld();
    const owner = holder(world, "owner", [], ["owner:feed"]);
    const service = {};
    owner.context.services.register(owner.context.service("owner:feed"), service, { awaitReleases: true });

    await world.host.release(alive(world.host.ledger()).rows.find((row) => row.importName === "owner")!.plugin);

    expect(owner.events).toEqual([{ kind: "holdings-released", id: "owner:feed", service }]);
  });

  it("hands an owner quarantined since nothing of a release queued after its quarantine, and reports nothing", () => {
    const sunk: unknown[] = [];
    const world = createHostWorld({}, { onListenerError: (error) => void sunk.push(error) });
    const registered = alive(
      world.host.register(
        { importName: "owner", api: 1, entry: "owner.ts", services: { provides: [{ id: "owner:feed" }] }, capabilities: { provides: ["never-provided"], consumes: [] } },
        { activate() {} },
      ),
    );
    const context = alive(world.host.open(registered.plugin!));
    const events: PluginEvent[] = [];
    context.events.listen((event) => void events.push(event));
    const consumer = holder(world, "consumer", ["owner:feed"]);
    context.services.register(context.service("owner:feed"), {}, { awaitReleases: true });
    consumer.context.services.get(consumer.context.service("owner:feed"));

    expect(alive(world.host.verify(registered.plugin!)).state).toBe("quarantined");
    revocationOf(consumer.events, "owner:feed").release();

    expect(events.filter((event) => event.kind === "holdings-released")).toEqual([]);
    expect(sunk).toEqual([]);
  });
});
