import koffi from "koffi";
import { createCore, EdgeSource, loadCoreLibrary, Status, type Core, type CoreLibrary, type Manifest } from "../core/index.js";
import { wrapperHooks } from "../core/core.js";
import { PluginContexts, type Logger, type PluginContext } from "../context/index.js";
import type { BoundDefinition } from "../host/description/definition.js";
import { Host, hostInternals } from "../host/host.js";
import type { HostOptions } from "../host/model.js";
import { bindBareBytesFunction, type LibraryDefinition } from "../host/libraries.js";
import type { LibraryDeclaration } from "../standard/answers.js";
import { FunctionKind } from "../standard/constants.js";
import { standardStructs } from "../standard/declarations.js";
import { loadStandard } from "../standard/standard.js";
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
  definitionCall: { warmupCalls: 100_000, callsPerBatch: 200, batches: 201 },
  describedCall: { warmupCalls: 100_000, callsPerBatch: 200, batches: 201 },
  blockingCall: { warmupCalls: 2_000, callsPerBatch: 50, batches: 201 },
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
const echoDefinitionId = "echo-definition";
const mirrorId = "described-mirror";
const consumerManifest: Manifest = {
  importName: "consumer",
  services: { consumes: [{ id: arithmeticId }, { id: echoId }, { id: echoDefinitionId }, { id: mirrorId }] },
};

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
    wrapperHooks(this.core).setDispatcher((event) => contexts.receive(event));
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

/** A host as the library benchmarks run it: the capabilities' edges, a silent log, and `extra` beside them. */
function benchmarkHost(options: BenchmarkOptions, extra: Partial<HostOptions> = {}): Host {
  return Host.create({
    edgeSource: EdgeSource.Capabilities,
    ...(options.coreLibraryPath === undefined ? {} : { coreLibraryPath: options.coreLibraryPath }),
    log: silentLogger,
    ...extra,
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
  const host = benchmarkHost(options);
  const bareLibrary = koffi.load(options.echoLibraryPath);
  try {
    host.loadLibrary(echoDeclaration, options.echoLibraryPath);
    const { core, contexts } = hostInternals(host);
    const consumer = openPlugin(core, contexts, consumerManifest).context;
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

const echoDefinitionDeclaration: LibraryDeclaration = {
  importName: "echo",
  version: "0.2.0",
  release: null,
  services: [{ id: echoDefinitionId, functions: [{ name: "definition", symbol: "echo_service_definition", kind: FunctionKind.Definition, context: 0 }] }],
};

/** The head of the echo library's `echo_definition`: its size, context and the two operations the call makes. */
const echoDefinitionHead = koffi.struct({ size: "uint32_t", context: "void *", echo: "void *", release: "void *" });
const echoOperation = koffi.proto("int32_t", ["void *", "const void *", "size_t", "_Out_ void **", "_Out_ size_t *"]);
const releaseOperation = koffi.proto("void", ["void *", "void *"]);

/**
 * The definition's `echo` called at `definition`, its answer released through the definition's own `release`.
 *
 * @implNote Both operations are read out of the struct once, here, before the timed loop, for every path alike: one
 * load more per call on one side would be a cost and not noise.
 */
function definitionEcho(definition: object, input: Uint8Array): MeasuredPath {
  const head = koffi.decode(definition, echoDefinitionHead) as { context: unknown; echo: unknown; release: unknown };
  const output: (object | null)[] = [null];
  const outputLength: number[] = [0];
  return () => {
    const status = koffi.call(head.echo, echoOperation, head.context, input, input.length, output, outputLength) as number;
    if (output[0] !== null) {
      koffi.call(head.release, releaseOperation, head.context, output[0]);
    }
    if (status !== 0 || Number(outputLength[0]) !== input.length) {
      throw new Error(`The definition's echo answered status ${String(status)} with ${String(outputLength[0])} bytes.`);
    }
    return status;
  };
}

/**
 * Times the echo definition's `echo` called through the definition a consumer resolved against the same operation
 * called through the pointer `echo_service_definition` answered, 16 bytes in and the same 16 back.
 *
 * @remarks The two are the same pointer, so the ratio is 1 by construction and bounds only the measurement's noise; it
 * is judged as the same-language pair is. The proof that the host adds no wrapper, count or copy is the identity check
 * before it: the address the consumer resolved is the address the symbol answered, or the benchmark throws.
 */
export async function benchmarkDefinitionCall(options: LibraryBenchmarkOptions): Promise<SameLanguageCallSummaries> {
  const host = benchmarkHost(options);
  const bareLibrary = koffi.load(options.echoLibraryPath);
  try {
    host.loadLibrary(echoDefinitionDeclaration, options.echoLibraryPath);
    const { core, contexts } = hostInternals(host);
    const consumer = openPlugin(core, contexts, consumerManifest).context;
    const resolved = consumer.services.get(consumer.service<LibraryDefinition>(echoDefinitionId));
    const answered = (bareLibrary.func("echo_service_definition", "void *", []) as () => object)();
    if (resolved === undefined || koffi.address(resolved.pointer) !== koffi.address(answered)) {
      throw new Error("The definition the consumer resolved is not the pointer echo_service_definition answered.");
    }
    const input = new Uint8Array(16).fill(7);
    return measureInterleaved(
      {
        direct: definitionEcho(answered, input),
        directAgain: definitionEcho(answered, input),
        throughWeivel: definitionEcho(resolved.pointer, input),
      },
      samplingOf(defaultSamplings.definitionCall, options),
      options.decorate,
    );
  } finally {
    bareLibrary.unload();
    await host.destroy();
  }
}

export interface DescribedBenchmarkOptions extends LibraryBenchmarkOptions {
  /** A build of the standard's `described` test library. */
  readonly describedLibraryPath: string;
  /** The standard whose check the host runs on the description; the package's own `native/` when absent. */
  readonly standardLibraryPath?: string;
}

export interface DescribedCallSummaries extends FfiCallSummaries {
  /** The echo library's bytes call through the host, sampled in the same rounds, for its time beside the pair's. */
  readonly echoCall: Summary;
}

const describedDeclaration: LibraryDeclaration = {
  importName: "described",
  version: "1.0.0",
  release: null,
  services: [
    {
      id: mirrorId,
      description: "described_mirror_description",
      functions: [{ name: "definition", symbol: "described_mirror_definition", kind: FunctionKind.Definition, context: 0 }],
    },
  ],
};

/** The text and counted array both paths hand `reflect`, shaped as a request's path and header names. */
const describedLabel = "request";
const describedTags: readonly string[] = ["accept", "host", "content-length"];

/** What `reflect` answered that both paths read back: the sample's text and counted array. */
interface Reflected {
  readonly label: string | null;
  readonly tags: readonly (string | null)[];
}

function reflectedMatches(reflected: Reflected): boolean {
  return reflected.label === describedLabel && reflected.tags.length === describedTags.length && reflected.tags.every((tag, index) => tag === describedTags[index]);
}

/** @implNote The fixture's types are declared by hand here alone, since the control is a binding written by hand. */
const handPoint = koffi.struct({ label: "const char *", x: "int64_t", y: "double" });
const handSample = koffi.struct({
  size: "uint32_t",
  shade: "uint32_t",
  tier: "uint32_t",
  flags: "uint32_t",
  big: "uint64_t",
  delta: "int64_t",
  ratio: "double",
  label: "const char *",
  tags: "const char **",
  tag_count: "size_t",
  bytes: "void *",
  length: "size_t",
  origin: handPoint,
  best: "void *",
  points: "void *",
  point_count: "size_t",
  numbers: "void *",
  number_count: "size_t",
  held: standardStructs.weivel_standard_value,
  extra: "void *",
  values: "void *",
  value_count: "size_t",
});
const handReflection = koffi.struct({ size: "uint32_t", sample: handSample, storage: "void *" });
const handMirrorHead = koffi.struct({
  size: "uint32_t",
  context: "void *",
  reflect: "void *",
  tree: "void *",
  find: "void *",
  measure: "void *",
  negate: "void *",
  halve: "void *",
  invert: "void *",
  swap_shade: "void *",
  grow: "void *",
  weigh: "void *",
  count_releases: "void *",
  release_reflection: "void *",
  release_tree: "void *",
  release_refusal: "void *",
});
const handReflectOperation = koffi.proto("int32_t", ["void *", koffi.pointer(handSample), "void *", "void *"]);
const pointerSize = koffi.sizeof("void *");

interface HandMirror {
  readonly context: unknown;
  readonly reflect: unknown;
  readonly release_reflection: unknown;
  readonly release_refusal: unknown;
}

interface DecodedReflection {
  readonly sample: { readonly label: string | null; readonly tags: object | null; readonly tag_count: number | bigint };
}

/** A measured path, and what frees the native blocks it holds once the measuring is done. */
interface HeldPath {
  readonly path: MeasuredPath;
  readonly free: () => void;
}

function sizedBlock(type: ReturnType<typeof koffi.struct>): object {
  const block = koffi.alloc(type, 1) as object;
  koffi.encode(block, type, { size: koffi.sizeof(type) });
  return block;
}

function decodedTexts(pointer: object | null, count: number): (string | null)[] {
  const texts: (string | null)[] = [];
  for (let index = 0; index < count; index++) {
    texts.push(koffi.decode(pointer, index * pointerSize, "const char *") as string | null);
  }
  return texts;
}

/**
 * `reflect` called through a bare koffi binding of the mirror, its sample encoded by koffi from the struct declared by
 * hand, its answer read back and released, and its refusal released, as the generic binding releases both.
 *
 * @implNote The answer and the refusal are one block each, kept across calls, as a binding written by hand for one
 * operation keeps them; the release empties both again.
 */
function handReflect(definition: object): HeldPath {
  const mirror = koffi.decode(definition, handMirrorHead) as HandMirror;
  const sample = { size: koffi.sizeof(handSample), label: describedLabel, tags: describedTags, tag_count: describedTags.length };
  const reflection = sizedBlock(handReflection);
  const refusal = sizedBlock(standardStructs.weivel_standard_service_refusal);
  const path: MeasuredPath = () => {
    const status = koffi.call(mirror.reflect, handReflectOperation, mirror.context, sample, reflection, refusal) as number;
    try {
      if (status !== Status.Ok) {
        throw new Error(`The bare reflect answered status ${status}.`);
      }
      const answered = (koffi.decode(reflection, handReflection) as DecodedReflection).sample;
      return { label: answered.label, tags: decodedTexts(answered.tags, Number(answered.tag_count)) } satisfies Reflected;
    } finally {
      koffi.call(mirror.release_reflection, releaseOperation, mirror.context, reflection);
      koffi.call(mirror.release_refusal, releaseOperation, mirror.context, refusal);
    }
  };
  return {
    path,
    free: () => {
      koffi.free(reflection);
      koffi.free(refusal);
    },
  };
}

function refuseUnlessReflected(reflected: Reflected | undefined, path: string): void {
  if (reflected === undefined || !reflectedMatches(reflected)) {
    throw new Error(`The ${path} reflect did not answer the sample it was handed.`);
  }
}

/**
 * Times the described mirror's `reflect`, a sample holding a text and a counted array of three texts in and its
 * reflection out, called on the bound object a consumer resolved, as a plugin calls it, against the same operation
 * called through a bare koffi binding marshalled by hand, with the same input and its answer released the same way.
 * The echo library's bytes call through the host is sampled in the same rounds, for its time beside theirs.
 *
 * @remarks The bound method answers a promise, which the timed loop does not await: the call runs on the calling
 * thread when the method is called, and awaiting would time the microtask queue, not the binding. A rejection there is
 * an unhandled rejection, which fails the run; both paths' answers are checked once before the timing.
 */
export async function benchmarkDescribedCall(options: DescribedBenchmarkOptions): Promise<DescribedCallSummaries> {
  const standard = loadStandard(options.standardLibraryPath);
  const host = benchmarkHost(options, {
    descriptionCheck: (description, definition) => standard.checkDescription(description, definition),
  });
  const bareLibrary = koffi.load(options.describedLibraryPath);
  let hand: HeldPath | undefined;
  try {
    host.loadLibrary(echoDeclaration, options.echoLibraryPath);
    host.loadLibrary(describedDeclaration, options.describedLibraryPath);
    const { core, contexts } = hostInternals(host);
    const consumer = openPlugin(core, contexts, consumerManifest).context;
    const echo = consumer.services.get(consumer.service<{ echo(input: Uint8Array): Uint8Array }>(echoId));
    const mirror = consumer.services.get(consumer.service<BoundDefinition>(mirrorId));
    if (echo === undefined || mirror?.reflect === undefined) {
      throw new Error("The consumer could not reach the echo library's service and the described mirror's reflect.");
    }
    const reflect = mirror.reflect;
    hand = handReflect((bareLibrary.func("described_mirror_definition", "void *", []) as () => object)());
    const input = { sample: { label: describedLabel, tags: describedTags } };
    refuseUnlessReflected(((await reflect(input)) as { sample?: Reflected }).sample, "bound");
    refuseUnlessReflected(hand.path(0) as Reflected, "bare");
    const echoInput = new Uint8Array(16).fill(7);
    const samples = sampleInterleaved(
      { bareCall: hand.path, weivelCall: () => reflect(input), echoCall: () => echo.echo(echoInput) },
      samplingOf(defaultSamplings.describedCall, options),
      options.decorate,
    );
    return {
      bareCall: summarise(samples.bareCall),
      weivelCall: summarise(samples.weivelCall),
      echoCall: summarise(samples.echoCall),
      roundRatio: summariseRoundRatios(samples.weivelCall, samples.bareCall),
    };
  } finally {
    hand?.free();
    bareLibrary.unload();
    await host.destroy();
  }
}

const walkerId = "described-walker";
const walkerConsumerManifest: Manifest = { importName: "walker-consumer", services: { consumes: [{ id: walkerId }] } };
const walkerDeclaration: LibraryDeclaration = {
  importName: "described",
  version: "1.0.0",
  release: null,
  services: [
    {
      id: walkerId,
      description: "described_walker_description",
      functions: [{ name: "definition", symbol: "described_walker_definition", kind: FunctionKind.Definition, context: 0 }],
    },
  ],
};

/** The walker's head up to `wait`, declared by hand as a binding written for one operation declares it. */
const handWalkerHead = koffi.struct({
  size: "uint32_t",
  context: "void *",
  open: "void *",
  use: "void *",
  visit: "void *",
  release_cursor: "void *",
  release_refusal: "void *",
  wait: "void *",
});
const handWaitOperation = koffi.proto("int32_t", ["void *", "uint64_t", "void *"]);

/** A path whose every call is awaited before the next starts, as a caller awaiting a blocking call does. */
export type AwaitedPath = (call: number) => Promise<unknown>;

async function timeAwaitedBatch(path: AwaitedPath, calls: number): Promise<number> {
  const start = process.hrtime.bigint();
  for (let call = 0; call < calls; call++) {
    await path(call);
  }
  return Number(process.hrtime.bigint() - start) / calls;
}

function timeDirectBatch(path: MeasuredPath, calls: number): number {
  const start = process.hrtime.bigint();
  for (let call = 0; call < calls; call++) {
    path(call);
  }
  return Number(process.hrtime.bigint() - start) / calls;
}

/**
 * Samples the direct path and the awaited path one batch each per round, which goes first alternating by round, so
 * a change in the machine's speed during the run falls on both alike.
 */
async function sampleBlockingPair(direct: MeasuredPath, awaited: AwaitedPath, sampling: Sampling): Promise<FfiCallSummaries> {
  timeDirectBatch(direct, sampling.warmupCalls);
  await timeAwaitedBatch(awaited, sampling.warmupCalls);
  const bare: number[] = [];
  const weivel: number[] = [];
  for (let round = 0; round < sampling.batches; round++) {
    if (round % 2 === 0) {
      bare.push(timeDirectBatch(direct, sampling.callsPerBatch));
      weivel.push(await timeAwaitedBatch(awaited, sampling.callsPerBatch));
    } else {
      weivel.push(await timeAwaitedBatch(awaited, sampling.callsPerBatch));
      bare.push(timeDirectBatch(direct, sampling.callsPerBatch));
    }
  }
  return { bareCall: summarise(bare), weivelCall: summarise(weivel), roundRatio: summariseRoundRatios(weivel, bare) };
}

/**
 * Times the described walker's `wait`, which its description marks blocking, called and awaited on the bound object a
 * consumer resolved, so it runs on koffi's worker thread, against the same `wait` called directly through a bare koffi
 * binding on the calling thread, with the same input and its answer read back.
 *
 * @remarks The ratio is the worker round trip's price, not the binding's: a blocking call buys a free event loop for
 * it, which a direct call cannot.
 */
export async function benchmarkBlockingCall(options: DescribedBenchmarkOptions): Promise<FfiCallSummaries> {
  const standard = loadStandard(options.standardLibraryPath);
  const host = benchmarkHost(options, {
    descriptionCheck: (description, definition) => standard.checkDescription(description, definition),
  });
  const bareLibrary = koffi.load(options.describedLibraryPath);
  const waited = koffi.alloc("uint64_t", 1) as object;
  try {
    host.loadLibrary(walkerDeclaration, options.describedLibraryPath);
    const { core, contexts } = hostInternals(host);
    const consumer = openPlugin(core, contexts, walkerConsumerManifest).context;
    const walker = consumer.services.get(consumer.service<BoundDefinition>(walkerId));
    if (walker?.wait === undefined) {
      throw new Error("The consumer could not reach the described walker's wait.");
    }
    const wait = walker.wait;
    const head = koffi.decode((bareLibrary.func("described_walker_definition", "void *", []) as () => object)(), handWalkerHead) as { context: unknown; wait: unknown };
    const direct: MeasuredPath = (call) => {
      const status = koffi.call(head.wait, handWaitOperation, head.context, call, waited) as number;
      if (status !== Status.Ok) {
        throw new Error(`The bare wait answered status ${status}.`);
      }
      return koffi.decode(waited, "uint64_t");
    };
    const awaited: AwaitedPath = (call) => wait({ ticks: call });
    if ((await awaited(7)) !== 7 || Number(direct(7)) !== 7) {
      throw new Error("A wait did not answer the ticks it was handed.");
    }
    return await sampleBlockingPair(direct, awaited, samplingOf(defaultSamplings.blockingCall, options));
  } finally {
    koffi.free(waited);
    bareLibrary.unload();
    await host.destroy();
  }
}
