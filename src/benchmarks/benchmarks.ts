import koffi from "koffi";
import { coreStructs, createCore, EdgeSource, loadCoreLibrary, Status, type Core, type CoreLibrary, type Manifest } from "../core/index.js";
import { PluginContexts, type Logger, type PluginContext } from "../context/index.js";
import { Host } from "../host/index.js";
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
  readonly standardLibraryPath?: string;
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

/** A core and its contexts, as a host composes them, with a provider and a consumer opened in it. */
class CoreWorld {
  readonly library: CoreLibrary;
  readonly core: Core;
  readonly provider: OpenedPlugin;
  readonly consumer: OpenedPlugin;

  constructor(options: BenchmarkOptions) {
    this.library = options.coreLibrary ?? loadCoreLibrary(options.coreLibraryPath);
    const created = createCore({ library: this.library });
    if (created.value === undefined) {
      throw new Error(`weivel_core_create answered status ${created.status}.`);
    }
    this.core = created.value;
    const contexts = new PluginContexts(this.core, { log: silentLogger });
    this.core.setDispatcher((event) => contexts.receive(event));
    this.provider = openPlugin(this.core, contexts, providerManifest);
    this.consumer = openPlugin(this.core, contexts, consumerManifest);
  }

  destroy(): void {
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
 * directly. The resolved service is the provider's own object, so after the lookup the call is a plain call.
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
  /** A call that does no work, through the same koffi binding: the bare cost of crossing into C. */
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

/**
 * Times weivel_get_service through koffi and the wrapper's drain, the control call the kit's C benchmark times,
 * against weivel_support_release on an all-zero answer through the same bound library, which the core answers as a
 * no-op.
 */
export function benchmarkControlCall(options: BenchmarkOptions = {}): FfiCallSummaries {
  return withCoreWorld(options, (world) => {
    world.provider.context.services.register(world.provider.context.service<Arithmetic>(arithmeticId), { add: (left, right) => left + right });
    const core = world.core;
    const consumer = world.consumer.plugin;
    const emptyAnswer = Buffer.alloc(koffi.sizeof(coreStructs.weivel_support));
    const releaseEmpty = world.library.functions.weivel_support_release;
    return ffiPair(
      {
        bareCall: () => releaseEmpty(emptyAnswer),
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

const echoDeclaration = JSON.stringify({
  importName: "echo",
  version: "0.1.0",
  release: "echo_release",
  services: [{ id: echoId, functions: [{ name: "echo", symbol: "echo_echo", kind: "bytes" }] }],
});

/**
 * Times a call into a C library through the host's bytes binding, 16 bytes in and the same 16 back, against
 * `echo_release(NULL)`, which frees nothing, bound by koffi the way the host binds a library's release.
 */
export async function benchmarkLibraryCall(options: LibraryBenchmarkOptions): Promise<FfiCallSummaries> {
  const host = Host.create({
    edgeSource: EdgeSource.Capabilities,
    ...(options.coreLibraryPath === undefined ? {} : { coreLibraryPath: options.coreLibraryPath }),
    ...(options.standardLibraryPath === undefined ? {} : { standardLibraryPath: options.standardLibraryPath }),
    log: silentLogger,
  });
  const bareLibrary = koffi.load(options.echoLibraryPath);
  try {
    const answer = host.loadLibrary(echoDeclaration, options.echoLibraryPath);
    if (answer.library === undefined) {
      throw new Error(`The echo declaration was refused: ${answer.refusal.detail}`);
    }
    const consumer = openPlugin(host.core, host.contexts, consumerManifest).context;
    const echo = consumer.services.get(consumer.service<{ echo(input: Uint8Array): Uint8Array }>(echoId));
    if (echo === undefined) {
      throw new Error("The consumer could not reach the echo library's service.");
    }
    const releaseNothing = bareLibrary.func("echo_release", "void", ["void *"]) as (buffer: null) => void;
    const input = new Uint8Array(16).fill(7);
    return ffiPair(
      { bareCall: () => releaseNothing(null), weivelCall: () => echo.echo(input) },
      samplingOf(defaultSamplings.libraryCall, options),
      options.decorate,
    );
  } finally {
    bareLibrary.unload();
    await host.destroy();
  }
}
