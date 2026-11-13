import { EdgeSource, Status, type Manifest } from "../core/index.js";
import type { Logger, PluginContext } from "../context/index.js";
import { Host } from "../host/index.js";
import { busyWait, measureInterleaved, type MeasuredPath, type Sampling, type Summary } from "./measure.js";

export interface BenchmarkOptions {
  readonly coreLibraryPath?: string;
  readonly standardLibraryPath?: string;
  readonly sampling?: Partial<Sampling>;
  /** Spins this long inside every call through weivel: only a red proof, which needs a slowed path, sets it. */
  readonly addedNanoseconds?: number;
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

/** A host on the real core with a provider and a consumer opened in it, each with its context. */
class BenchmarkWorld {
  readonly host: Host;
  readonly consumer: bigint;
  readonly consumerContext: PluginContext;
  readonly providerContext: PluginContext;

  constructor(options: BenchmarkOptions) {
    this.host = Host.create({
      edgeSource: EdgeSource.Capabilities,
      ...(options.coreLibraryPath === undefined ? {} : { coreLibraryPath: options.coreLibraryPath }),
      ...(options.standardLibraryPath === undefined ? {} : { standardLibraryPath: options.standardLibraryPath }),
      log: silentLogger,
    });
    const provider = this.#open({ importName: "provider", services: { provides: [{ id: arithmeticId }] } });
    this.providerContext = provider.context;
    const consumer = this.#open({ importName: "consumer", services: { consumes: [{ id: arithmeticId }, { id: echoId }] } });
    this.consumer = consumer.plugin;
    this.consumerContext = consumer.context;
  }

  #open(manifest: Manifest): { plugin: bigint; context: PluginContext } {
    const registered = this.host.core.registerManifest(manifest);
    if (registered.value === undefined || this.host.core.openPlugin(registered.value).status !== Status.Ok) {
      throw new Error(`The core would not register and open ${manifest.importName}.`);
    }
    return { plugin: registered.value, context: this.host.contexts.create(registered.value, manifest, silentLogger) };
  }

  destroy(): void {
    this.host.destroy();
  }
}

function withWorld<Answer>(options: BenchmarkOptions, measure: (world: BenchmarkWorld) => Answer): Answer {
  const world = new BenchmarkWorld(options);
  try {
    return measure(world);
  } finally {
    world.destroy();
  }
}

function slowed(path: MeasuredPath, addedNanoseconds: number | undefined): MeasuredPath {
  if (addedNanoseconds === undefined || addedNanoseconds <= 0) {
    return path;
  }
  return (call) => {
    busyWait(addedNanoseconds);
    return path(call);
  };
}

function samplingOf(defaults: Sampling, options: BenchmarkOptions): Sampling {
  return { ...defaults, ...options.sampling };
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
  return withWorld(options, (world) => {
    const arithmetic: Arithmetic = { add: (left, right) => left + right };
    world.providerContext.services.register(world.providerContext.service<Arithmetic>(arithmeticId), arithmetic);
    const resolved = world.consumerContext.services.get(world.consumerContext.service<Arithmetic>(arithmeticId));
    if (resolved !== arithmetic) {
      throw new Error("services.get did not answer the provider's own object.");
    }
    const target = arithmetic;
    return measureInterleaved(
      {
        direct: (call) => target.add(call, 1),
        directAgain: (call) => target.add(call, 1),
        throughWeivel: slowed((call) => resolved.add(call, 1), options.addedNanoseconds),
      },
      samplingOf(defaultSamplings.sameLanguageCall, options),
    );
  });
}

/** Times weivel_get_service through koffi and the wrapper's drain, the control call the kit's C benchmark times. */
export function benchmarkControlCall(options: BenchmarkOptions = {}): Summary {
  return withWorld(options, (world) => {
    world.providerContext.services.register(world.providerContext.service<Arithmetic>(arithmeticId), { add: (left, right) => left + right });
    const core = world.host.core;
    const consumer = world.consumer;
    const getService: MeasuredPath = () => {
      const answer = core.getService(consumer, arithmeticId);
      if (answer.status !== Status.Ok) {
        throw new Error(`weivel_get_service answered status ${answer.status}.`);
      }
      return answer.value;
    };
    return measureInterleaved({ getService: slowed(getService, options.addedNanoseconds) }, samplingOf(defaultSamplings.controlCall, options)).getService;
  });
}

const echoDeclaration = JSON.stringify({
  importName: "echo",
  version: "0.1.0",
  release: "echo_release",
  services: [{ id: echoId, functions: [{ name: "echo", symbol: "echo_echo", kind: "bytes" }] }],
});

/** Times a call into a C library through the host's bytes binding: 16 bytes in, the same 16 bytes back. */
export function benchmarkLibraryCall(options: LibraryBenchmarkOptions): Summary {
  return withWorld(options, (world) => {
    const answer = world.host.loadLibrary(echoDeclaration, options.echoLibraryPath);
    if (answer.library === undefined) {
      throw new Error(`The echo declaration was refused: ${answer.refusal.detail}`);
    }
    const echo = world.consumerContext.services.get(world.consumerContext.service<{ echo(input: Uint8Array): Uint8Array }>(echoId));
    if (echo === undefined) {
      throw new Error("The consumer could not reach the echo library's service.");
    }
    const input = new Uint8Array(16).fill(7);
    return measureInterleaved({ echo: slowed(() => echo.echo(input), options.addedNanoseconds) }, samplingOf(defaultSamplings.libraryCall, options)).echo;
  });
}
