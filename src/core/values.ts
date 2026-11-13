import type { Bound, Choice, RefusalCode } from "./constants.js";
import { sizeOf } from "./declarations.js";

/** A refusal as the core answered it, every text copied out of the core's storage. */
export interface Refusal {
  readonly code: RefusalCode;
  readonly detail: string | null;
  readonly fix: string | null;
  /** What the refusal is about, as its code says; null when it names nothing. */
  readonly subject: string | null;
  readonly hasFix: boolean;
}

export interface NamedNumber {
  readonly name: string;
  readonly value: number;
}

export interface ServiceOffer {
  readonly id: string;
  readonly attributes?: readonly NamedNumber[];
}

export interface ServiceWant {
  readonly id: string;
  readonly provider?: string;
  readonly optional?: Choice;
  readonly degradable?: Choice;
  readonly constraints?: readonly NamedNumber[];
}

/** A weivel_manifest as a value; a field left out takes the header's default. */
export interface Manifest {
  readonly importName: string;
  readonly api?: number;
  readonly entry?: string;
  readonly targets?: readonly string[];
  readonly capabilities?: { readonly provides?: readonly string[]; readonly consumes?: readonly string[] };
  readonly services?: { readonly provides?: readonly ServiceOffer[]; readonly consumes?: readonly ServiceWant[] };
  readonly permissions?: readonly string[];
  readonly identity?: string;
}

export interface ConstraintEntry {
  readonly constraintName: string;
  readonly attributeName: string;
  readonly bound: Bound;
}

/** weivel_core_options as a value; a field left out takes the header's default. */
export interface CoreOptions {
  readonly initialEventCapacity?: number;
  readonly minimumLogLevel?: number;
  readonly api?: number;
  readonly applications?: readonly string[];
  readonly wellKnownServices?: readonly string[];
  readonly constraintVocabulary?: readonly ConstraintEntry[];
}

/** weivel_want_options as a value; a field left out takes the header's default. */
export interface WantOptions {
  readonly timed?: Choice;
  readonly now?: number;
  readonly timeoutMillis?: number;
  readonly budgeted?: Choice;
  readonly budgetMillis?: number;
  readonly pollMillis?: number;
}

export interface QuarantineReason {
  readonly code?: RefusalCode;
  readonly detail: string;
  readonly fix: string;
}

/** A provider's answer to a capacity question: `attributes` for an attributes question, `serves` for a serve one. */
export interface CapacityAnswer {
  readonly request: bigint;
  readonly attributes?: readonly NamedNumber[];
  readonly serves?: Choice;
}

interface EncodedList<Item> {
  items: Item[] | null;
  count: number;
}

function encodeList<Value, Item>(values: readonly Value[] | undefined, encode: (value: Value) => Item): EncodedList<Item> {
  if (values === undefined || values.length === 0) {
    return { items: null, count: 0 };
  }
  return { items: values.map(encode), count: values.length };
}

export function encodeStrings(values: readonly string[] | undefined): EncodedList<string> {
  return encodeList(values, (value) => value);
}

function encodeNumbers(values: readonly NamedNumber[] | undefined) {
  return encodeList(values, (number) => ({ size: sizeOf("weivel_number"), name: number.name, value: number.value }));
}

function encodeOffer(offer: ServiceOffer) {
  return { size: sizeOf("weivel_service_offer"), id: offer.id, attributes: encodeNumbers(offer.attributes) };
}

function encodeWant(want: ServiceWant) {
  return {
    size: sizeOf("weivel_service_want"),
    id: want.id,
    provider: want.provider ?? null,
    optional: want.optional ?? 0,
    degradable: want.degradable ?? 0,
    constraints: encodeNumbers(want.constraints),
  };
}

export function encodeManifest(manifest: Manifest) {
  return {
    size: sizeOf("weivel_manifest"),
    import_name: manifest.importName,
    api: manifest.api ?? 0,
    entry: manifest.entry ?? null,
    targets: encodeStrings(manifest.targets),
    capabilities: {
      provides: encodeStrings(manifest.capabilities?.provides),
      consumes: encodeStrings(manifest.capabilities?.consumes),
    },
    services: {
      provides: encodeList(manifest.services?.provides, encodeOffer),
      consumes: encodeList(manifest.services?.consumes, encodeWant),
    },
    permissions: encodeStrings(manifest.permissions),
    identity: manifest.identity ?? null,
  };
}

function encodeConstraintEntry(entry: ConstraintEntry) {
  return {
    size: sizeOf("weivel_constraint_entry"),
    constraint_name: entry.constraintName,
    attribute_name: entry.attributeName,
    bound: entry.bound,
  };
}

export function encodeCoreOptions(options: CoreOptions) {
  return {
    size: sizeOf("weivel_core_options"),
    initial_event_capacity: options.initialEventCapacity ?? 0,
    minimum_log_level: options.minimumLogLevel ?? 0,
    api: options.api ?? 0,
    applications: encodeStrings(options.applications),
    well_known_services: encodeStrings(options.wellKnownServices),
    constraint_vocabulary: encodeList(options.constraintVocabulary, encodeConstraintEntry),
  };
}

export function encodeWantOptions(options: WantOptions) {
  return {
    size: sizeOf("weivel_want_options"),
    timed: options.timed ?? 0,
    now: options.now ?? 0,
    timeout_millis: options.timeoutMillis ?? 0,
    budgeted: options.budgeted ?? 0,
    budget_millis: options.budgetMillis ?? 0,
    poll_millis: options.pollMillis ?? 0,
  };
}

export function encodePluginOptions(payload: bigint) {
  return { size: sizeOf("weivel_plugin_options"), payload };
}

export function encodeQuarantineReason(reason: QuarantineReason) {
  return { size: sizeOf("weivel_quarantine_reason"), code: reason.code ?? 0, detail: reason.detail, fix: reason.fix };
}

export function encodeCapacity(answer: CapacityAnswer) {
  return {
    size: sizeOf("weivel_capacity"),
    request: answer.request,
    attributes: encodeNumbers(answer.attributes),
    serves: answer.serves ?? 0,
  };
}
