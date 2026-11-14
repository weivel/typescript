import { describe, expect, it } from "vitest";
import { HOST, Status } from "../../src/core/index.ts";
import { LibraryCallError, LibraryUnloadedError, type LibraryService } from "../../src/host/index.ts";
import { FunctionKind, type LibraryDeclaration } from "../../src/standard/index.ts";
import { realStandard } from "../real-standard.ts";
import { activated, alive, createHostWorld, echoLibraryPath, plugin, pluginDirectory, registerDirectory, type HostWorld } from "./world.ts";

const echoFunctions = [
  { name: "echo", symbol: "echo_echo", kind: "bytes" },
  { name: "fail", symbol: "echo_fail", kind: "bytes" },
  { name: "garbage", symbol: "echo_garbage", kind: "bytes" },
];

/** The echo library's declaration as the standard reads it. */
function declaration(functions: readonly Record<string, unknown>[] = echoFunctions): LibraryDeclaration {
  const json = JSON.stringify({ importName: "echo", version: "0.1.0", release: "echo_release", services: [{ id: "echo", functions }] });
  const read = realStandard().readLibrary(json);
  if (read.value === undefined) {
    throw new Error(`the standard refused the echo declaration: ${read.refusal?.detail}`);
  }
  return read.value;
}

function loadedEcho(world: HostWorld): LibraryService {
  return alive(world.host.loadLibrary(declaration(), echoLibraryPath)).services.get("echo")!;
}

function hostReaches(world: HostWorld, id: string): boolean {
  return world.host.core.getService(HOST, id).status === Status.Ok;
}

describe("a C library loaded as host services", () => {
  it("is reached by a plugin as the host's own object, each bytes function answering the library's bytes", async () => {
    const world = createHostWorld();
    const echo = loadedEcho(world);
    const handles = registerDirectory(
      world,
      pluginDirectory([
        plugin(
          { importName: "caller", services: { consumes: ["echo"] } },
          "const echo = context.services.get(context.service('echo')); probe.reached = echo; probe.answered = echo.echo(new Uint8Array([1, 2, 0, 255]));",
        ),
      ]),
    );

    await activated(world.host, [...handles.registered.values()]);
    const reached = globalThis.weivelHostProbe as unknown as { reached: unknown; answered: Uint8Array };

    expect(reached.reached).toBe(echo);
    expect(reached.answered).toEqual(new Uint8Array([1, 2, 0, 255]));
    expect(echo.echo!(new Uint8Array(0))).toEqual(new Uint8Array(0));
  });

  it("hands back bytes that are not UTF-8 untouched", () => {
    const world = createHostWorld();

    expect(loadedEcho(world).garbage!(new Uint8Array([7]))).toEqual(new Uint8Array([0xff, 0xfe]));
  });

  it("throws a function's refusal with its status and the text its body carried", () => {
    const world = createHostWorld();
    const echo = loadedEcho(world);

    let thrown: unknown;
    try {
      echo.fail!(new Uint8Array([1]));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(LibraryCallError);
    expect((thrown as LibraryCallError).status).toBe(1);
    expect((thrown as LibraryCallError).symbol).toBe("echo_fail");
    expect((thrown as LibraryCallError).message).toBe("echo_fail answered status 1: echo refused on purpose");
  });

  it("are unregistered when the library is unloaded", () => {
    const world = createHostWorld();
    const library = alive(world.host.loadLibrary(declaration(), echoLibraryPath));
    expect(hostReaches(world, "echo")).toBe(true);

    library.unload();

    expect(hostReaches(world, "echo")).toBe(false);
  });

  it("refuse a call a plugin still holds once unloaded, never reaching the unloaded code, and unload once", () => {
    const world = createHostWorld();
    const library = alive(world.host.loadLibrary(declaration(), echoLibraryPath));
    const held = library.services.get("echo")!;

    library.unload();
    library.unload();

    expect(() => held.echo!(new Uint8Array([1]))).toThrow(LibraryUnloadedError);
    expect(() => held.echo!(new Uint8Array([1]))).toThrow("echo_echo belongs to a C library that has been unloaded.");
  });

  it("unload once, so a second unload leaves a later load of the same file working", () => {
    const world = createHostWorld();
    const first = alive(world.host.loadLibrary(declaration(), echoLibraryPath));
    first.unload();
    const second = alive(world.host.loadLibrary(declaration(), echoLibraryPath));

    first.unload();

    expect(second.services.get("echo")!.echo!(new Uint8Array([9]))).toEqual(new Uint8Array([9]));
  });

  it("are unloaded when the host is destroyed, so a held call is refused and a later unload does nothing", async () => {
    const world = createHostWorld();
    const library = alive(world.host.loadLibrary(declaration(), echoLibraryPath));
    const held = library.services.get("echo")!;

    await world.host.destroy();

    expect(() => held.echo!(new Uint8Array([1]))).toThrow(LibraryUnloadedError);
    expect(() => library.unload()).not.toThrow();
  });

  it("refuses a declaration built with a kind other than bytes, binding and registering nothing", () => {
    const world = createHostWorld();
    const read = declaration();
    const retired = { ...read, services: [{ id: "echo", functions: [{ name: "echo", symbol: "echo_echo", kind: 1, context: 0 }] }] };

    expect(() => alive(world.host.loadLibrary(retired, echoLibraryPath))).toThrow(/function echo is of kind 1; this layer binds the bytes kind alone/);
    expect(read.services[0]!.functions[0]!.kind).toBe(FunctionKind.Bytes);
    expect(hostReaches(world, "echo")).toBe(false);
  });

  it("throws for a library that does not export a symbol its declaration names, registering nothing", () => {
    const world = createHostWorld();

    expect(() => alive(world.host.loadLibrary(declaration([{ name: "echo", symbol: "echo_absent", kind: "bytes" }]), echoLibraryPath))).toThrow(
      /does not export every symbol echo declares/,
    );
    expect(() => alive(world.host.loadLibrary(declaration(), `${echoLibraryPath}.absent`))).toThrow(/is not at/);
    expect(hostReaches(world, "echo")).toBe(false);
  });
});
