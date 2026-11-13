import { describe, expect, it } from "vitest";
import { HOST, Status } from "../../src/core/index.ts";
import { LibraryCallError, LibraryUnloadedError, type LibraryService } from "../../src/host/index.ts";
import { StandardRefusalCode } from "../../src/standard/index.ts";
import { createHostWorld, echoLibraryPath, plugin, pluginDirectory, type HostWorld } from "./world.ts";

const echoFunctions = [
  { name: "echo", symbol: "echo_echo", kind: "bytes" },
  { name: "fail", symbol: "echo_fail", kind: "bytes" },
  { name: "garbage", symbol: "echo_garbage", kind: "bytes" },
];

function declaration(functions: readonly Record<string, unknown>[] = echoFunctions): string {
  return JSON.stringify({ importName: "echo", version: "0.1.0", release: "echo_release", services: [{ id: "echo", functions }] });
}

function loadedEcho(world: HostWorld): LibraryService {
  const answer = world.host.loadLibrary(declaration(), echoLibraryPath);
  if (answer.library === undefined) {
    throw new Error(`the echo declaration was refused: ${answer.refusal.detail}`);
  }
  return answer.library.services.get("echo")!;
}

function hostReaches(world: HostWorld, id: string): boolean {
  return world.host.core.getService(HOST, id).status === Status.Ok;
}

describe("a C library loaded as host services", () => {
  it("is reached by a plugin as the host's own object, each bytes function answering the library's bytes", async () => {
    const world = createHostWorld();
    const echo = loadedEcho(world);
    const handles = world.host.discover(
      pluginDirectory([
        plugin(
          { importName: "caller", services: { consumes: ["echo"] } },
          "const echo = context.services.get(context.service('echo')); probe.reached = echo; probe.answered = echo.echo(new Uint8Array([1, 2, 0, 255]));",
        ),
      ]),
    );

    await world.host.activate(handles.registered.map((hosted) => hosted.plugin));
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
    const answer = world.host.loadLibrary(declaration(), echoLibraryPath);
    expect(hostReaches(world, "echo")).toBe(true);

    answer.library!.unload();

    expect(hostReaches(world, "echo")).toBe(false);
  });

  it("refuse a call a plugin still holds once unloaded, never reaching the unloaded code, and unload once", () => {
    const world = createHostWorld();
    const answer = world.host.loadLibrary(declaration(), echoLibraryPath);
    const held = answer.library!.services.get("echo")!;

    answer.library!.unload();
    answer.library!.unload();

    expect(() => held.echo!(new Uint8Array([1]))).toThrow(LibraryUnloadedError);
    expect(() => held.echo!(new Uint8Array([1]))).toThrow("echo_echo belongs to a C library that has been unloaded.");
  });

  it("unload once, so a second unload leaves another load of the same file working", () => {
    const world = createHostWorld();
    const first = world.host.loadLibrary(declaration(), echoLibraryPath).library!;
    const second = world.host.loadLibrary(declaration(), echoLibraryPath).library!;

    first.unload();
    first.unload();

    expect(second.services.get("echo")!.echo!(new Uint8Array([9]))).toEqual(new Uint8Array([9]));
  });

  it("refuses a json function by its field path, binding and registering nothing", () => {
    const world = createHostWorld();
    const withJson = [echoFunctions[0]!, { name: "repeat", symbol: "echo_echo", kind: "json", argument: true, result: true }];

    const answer = world.host.loadLibrary(declaration(withJson), echoLibraryPath);

    expect(answer.library).toBeUndefined();
    expect(answer.refusal).toMatchObject({ code: StandardRefusalCode.InvalidValue, path: "services[0].functions[1].kind" });
    expect(answer.refusal?.detail).toContain('"json"');
    expect(hostReaches(world, "echo")).toBe(false);
  });

  it("answers the standard's refusal of a declaration it will not read", () => {
    const world = createHostWorld();

    const answer = world.host.loadLibrary(declaration([{ name: "echo", symbol: "not a symbol", kind: "bytes" }]), echoLibraryPath);

    expect(answer.refusal).toMatchObject({ code: StandardRefusalCode.InvalidValue, path: "services[0].functions[0].symbol" });
    expect(hostReaches(world, "echo")).toBe(false);
  });

  it("throws for a library that does not export a symbol its declaration names, registering nothing", () => {
    const world = createHostWorld();

    expect(() => world.host.loadLibrary(declaration([{ name: "echo", symbol: "echo_absent", kind: "bytes" }]), echoLibraryPath)).toThrow(
      /does not export every symbol echo declares/,
    );
    expect(() => world.host.loadLibrary(declaration(), `${echoLibraryPath}.absent`)).toThrow(/is not at/);
    expect(hostReaches(world, "echo")).toBe(false);
  });
});
