import koffi from "koffi";
import { createCore, EdgeSource, loadCoreLibrary, Status, type Core, type CoreLibrary, type Manifest } from "../core/index.js";
import { PluginContexts, type Logger, type PluginContext } from "../context/index.js";
import { Host } from "../host/index.js";
import { bindBareBytesFunction } from "../host/libraries.js";
import type { LibraryDeclaration } from "../standard/answers.js";
import { FunctionKind } from "../standard/constants.js";
import { CoreTimer } from "../timer/index.js";
import {
  measureInterleaved,
  sampleInterleaved,
  summarise,
  summariseRoundRatios,
  type MeasuredPath,
  type PathDecorator,
  type Sampling,
  type Summary,
} from "./measure.js";

export interface BenchmarkOptions {
  readonly coreLibraryPath?: string;
  /** The bound core library to call through; loaded from `coreLibraryPath` when absent. */
  readonly coreLibrary?: CoreLibrary;
  readonly sampling?: Partial<Sampling>;
  /** Wraps each measured path, named as the benchmark's summaries name it. */
  readonly decorate?: PathDecorator;
}

export interface LibraryBenchmarkOptions extends BenchmarkOptions {
  /** A build of the core's `echo` test library, whose `echo_echo` answers its input. */
  readonly echoLibraryPath: string;
}

/** The plain object a provider registers; the call measured is `add`. */
export interface Arithmetic {
  add(left: number, right: number): number;
}

const arithmeticId = "provider:arithmetic";
const echoId = "echo";

const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

export const defaultSamplings = {
  sameLanguageCall: { warmupCalls: 2_000_000, callsPerBatch: 10_000, batches: 301 },
  controlCall: { warmupCalls: 100_000, callsPerBatch: 200, batches: 201 },
  libraryCall: { warmupCalls: 100_000, callsPerBatch: 200, batches: 201 },
} as const satisfies Record<string, Sampling>;

function samplingOf(defaults: Sampling, options: BenchmarkOptions): Sampling {
  return { ...defaults, ...options.sampling };
}

interface OpenedPlugin {
  readonly plugin: bigint;
  readonly context: PluginContext;
}

function openPlugin(core: Core, contexts: PluginContexts, manifest: Manifest): OpenedPlugin {
  const registered = core.registerManifest(manifest);
  if (registered.value === undefined || core.openPlugin(registered.value).status !== Status.Ok) {
    throw new Error(`The core would not register and open ${manifest.importName}.`);
  }
  return { plugin: registered.value, context: contexts.create(registered.value, manifest, silentLogger) };
}

const providerManifest: Manifest = { importName: "provider", services: { provides: [{ id: arithmeticId }] } };
const consumerManifest: Manifest = { importName: "consumer", services: { consumes: [{ id: arithmeticId }, { id: echoId }] } };

/**
 * The library as it was given, but for weivel_core_create, which also hands the core it created to `created`: the
 * wrapper keeps its core to itself, and a bare call needs the very core the wrapper calls.
 */
function keepingCreatedCore(library: CoreLibrary, created: (core: object) => void): CoreLibrary {
  const create = library.functions.weivel_core_create;
  const keeping = (...parameters: unknown[]): number => {
    const status = create(...parameters);
    created((parameters[1] as unknown[])[0] as object);
    return status;
  };
  return { path: library.path, functions: { ...library.functions, weivel_core_create: keeping } };
}

/** A core, its contexts and its armed timer, as a host composes them, with a provider and a consumer opened in it. */
class CoreWorld {
  readonly library: CoreLibrary;
  readonly core: Core;
  /** The core the wrapper calls, as weivel_core_create answered it, for a call made without the wrapper. */
  readonly bareCore: object;
  readonly #timer: CoreTimer;
  readonly provider: OpenedPlugin;
  readonly consumer: OpenedPlugin;

  constructor(options: BenchmarkOptions) {
    this.library = options.coreLibrary ?? loadCoreLibrary(options.coreLibraryPath);
    let bareCore: object | undefined;
    const created = createCore({ library: keepingCreatedCore(this.library, (core) => (bareCore = core)) });
    if (created.value === undefined || bareCore === undefined) {
      throw new Error(`weivel_core_create answered status ${created.status}.`);
    }
    this.core = created.value;
    this.bareCore = bareCore;
    const contexts = new PluginContexts(this.core, { log: silentLogger });
    this.core.setDispatcher((event) => contexts.receive(event));
    this.#timer = new CoreTimer(this.core);
    this.provider = openPlugin(this.core, contexts, providerManifest);
    this.consumer = openPlugin(this.core, contexts, consumerManifest);
  }

  destroy(): void {
    this.#timer.stop();
    this.core.destroy();
  }
}

function withCoreWorld<Answer>(options: BenchmarkOptions, measure: (world: CoreWorld) => Answer): Answer {
  const world = new CoreWorld(options);
  try {
    return measure(world);
  } finally {
    world.destroy();
  }
}

export interface SameLanguageCallSummaries {
  /** The call made on the provider's object directly. */
  readonly direct: Summary;
  /** The same direct call again, sampled beside the others: how far two identical paths differ is the noise. */
  readonly directAgain: Summary;
  /** The call made on the object the consumer's `services.get` resolved. */
  readonly throughWeivel: Summary;
}

/**
 * Times a call on a service a consumer resolved through weivel against the same call made on the provider's object
 * directly.
 *
 * @remarks Both timed paths run the same code, a call on the provider's own object, so the timing can show only
 * noise. The proof that weivel puts nothing between a consumer and a provider of the same language is the identity
 * check before it: the object `services.get` resolved is the provider's object itself, or the benchmark throws.
 */
export function benchmarkSameLanguageCall(options: BenchmarkOptions = {}): SameLanguageCallSummaries {
  return withCoreWorld(options, (world) => {
    const arithmetic: Arithmetic = { add: (left, right) => left + right };
    world.provider.context.services.register(world.provider.context.service<Arithmetic>(arithmeticId), arithmetic);
    const resolved = world.consumer.context.services.get(world.consumer.context.service<Arithmetic>(arithmeticId));
    if (resolved !== arithmetic) {
      throw new Error("services.get did not answer the provider's own object.");
    }
    const target = arithmetic;
    return measureInterleaved(
      {
        direct: (call) => target.add(call, 1),
        directAgain: (call) => target.add(call, 1),
        throughWeivel: (call) => resolved.add(call, 1),
      },
      samplingOf(defaultSamplings.sameLanguageCall, options),
      options.decorate,
    );
  });
}

export interface FfiCallSummaries {
  /** The C function the weivel call makes, called through the bare koffi binding with the same arguments. */
  readonly bareCall: Summary;
  /** The call weivel makes. */
  readonly weivelCall: Summary;
  /** The weivel call's batch time over the bare call's in the same round, per round. */
  readonly roundRatio: Summary;
}

function ffiPair(paths: Readonly<Record<"bareCall" | "weivelCall", MeasuredPath>>, sampling: Sampling, decorate?: PathDecorator): FfiCallSummaries {
  const samples = sampleInterleaved(paths, sampling, decorate);
  return {
    bareCall: summarise(samples.bareCall),
    weivelCall: summarise(samples.weivelCall),
    roundRatio: summariseRoundRatios(samples.weivelCall, samples.bareCall),
  };
}

/** The control call made on the core directly, through the very koffi function the wrapper calls, with nothing around it. */
function bareGetService(world: CoreWorld, plugin: bigint, id: string): MeasuredPath {
  const getService = world.library.functions.weivel_get_service;
  const core = world.bareCore;
  const handle: unknown[] = [0];
  const pending = new Uint32Array(1);
  return () => {
    const status = getService(core, plugin, id, handle, pending);
    if (status !== Status.Ok || pending[0] !== 0) {
      throw new Error(`The bare weivel_get_service answered status ${status} with ${pending[0]} events waiting.`);
    }
    return handle[0];
  };
}

/**
 * Times weivel_get_service through koffi and the wrapper's drain, with the core's timer armed as a host arms it, the
 * control call the kit's C benchmark times, against the same weivel_get_service on the same core, plugin and id,
 * called through the same bound function without the wrapper.
 */
export function benchmarkControlCall(options: BenchmarkOptions = {}): FfiCallSummaries {
  return withCoreWorld(options, (world) => {
    world.provider.context.services.register(world.provider.context.service<Arithmetic>(arithmeticId), { add: (left, right) => left + right });
    const core = world.core;
    const consumer = world.consumer.plugin;
    return ffiPair(
      {
        bareCall: bareGetService(world, consumer, arithmeticId),
        weivelCall: () => {
          const answer = core.getService(consumer, arithmeticId);
          if (answer.status !== Status.Ok) {
            throw new Error(`weivel_get_service answered status ${answer.status}.`);
          }
          return answer.value;
        },
      },
      samplingOf(defaultSamplings.controlCall, options),
      options.decorate,
    );
  });
}

const echoDeclaration: LibraryDeclaration = {
  importName: "echo",
  version: "0.1.0",
  release: "echo_release",
  services: [{ id: echoId, functions: [{ name: "echo", symbol: "echo_echo", kind: FunctionKind.Bytes, context: 0 }] }],
};

/** `echo_echo` called through a bare koffi binding of the host's bytes ABI, its answer released as the host releases it. */
function bareEcho(library: koffi.IKoffiLib, input: Uint8Array): MeasuredPath {
  const echo = bindBareBytesFunction(library, "echo_echo");
  const release = library.func("echo_release", "void", ["void *"]) as (buffer: object) => void;
  const output: (object | null)[] = [null];
  const outputLength: number[] = [0];
  return () => {
    const status = echo(input, input.length, output, outputLength);
    if (output[0] !== null) {
      release(output[0]);
    }
    if (status !== 0 || Number(outputLength[0]) !== input.length) {
      throw new Error(`The bare echo_echo answered status ${String(status)} with ${String(outputLength[0])} bytes.`);
    }
    return status;
  };
}

/**
 * Times a call into a C library through the host's bytes binding, 16 bytes in and the same 16 back, against the same
 * `echo_echo` with the same input called through a bare koffi binding, its answer released as the host releases it.
 */
export async function benchmarkLibraryCall(options: LibraryBenchmarkOptions): Promise<FfiCallSummaries> {
  const host = Host.create({
    edgeSource: EdgeSource.Capabilities,
    ...(options.coreLibraryPath === undefined ? {} : { coreLibraryPath: options.coreLibraryPath }),
    log: silentLogger,
  });
  const bareLibrary = koffi.load(options.echoLibraryPath);
  try {
    host.loadLibrary(echoDeclaration, options.echoLibraryPath);
    const consumer = openPlugin(host.core, host.contexts, consumerManifest).context;
    const echo = consumer.services.get(consumer.service<{ echo(input: Uint8Array): Uint8Array }>(echoId));
    if (echo === undefined) {
      throw new Error("The consumer could not reach the echo library's service.");
    }
    const input = new Uint8Array(16).fill(7);
    return ffiPair(
      { bareCall: bareEcho(bareLibrary, input), weivelCall: () => echo.echo(input) },
      samplingOf(defaultSamplings.libraryCall, options),
      options.decorate,
    );
  } finally {
    bareLibrary.unload();
    await host.destroy();
  }
}
