import koffi from "koffi";

type KoffiType = ReturnType<typeof koffi.opaque>;
type TypeSpec = string | KoffiType;

const handle = "uint64_t";
const text = "const char *";
const sizeField = { size: "uint32_t" } as const;

/**
 * @remarks Every type is anonymous: koffi keeps one registry of type names per process, and a module evaluated twice
 * in one process (a test runner isolating files) would refuse a named type the second time.
 */
function structOf(fields: Record<string, TypeSpec>): KoffiType {
  return koffi.struct(fields);
}

const weivel_refusal = structOf({ code: "uint32_t", detail: text, fix: text });
const weivel_log_event = structOf({ level: "uint32_t", text });
const weivel_want_event = structOf({
  want: handle,
  plugin: handle,
  implementation: handle,
  refusal: weivel_refusal,
  degraded: "uint32_t",
  subject: text,
  has_fix: "uint32_t",
});
const weivel_watch_event = structOf({ watch: handle, plugin: handle, implementation: handle, change: "uint32_t" });
const weivel_revoked_event = structOf({ plugin: handle, implementation: handle });
const weivel_reach_refusal = structOf({
  kind: "uint32_t",
  plugin: handle,
  id: text,
  refusal: weivel_refusal,
  subject: text,
  has_fix: "uint32_t",
});
const weivel_refusal_event = structOf({ refusal: weivel_refusal, subject: text, has_fix: "uint32_t" });
const weivel_number = structOf({ ...sizeField, name: text, value: "double" });
const weivel_numbers = structOf({ items: koffi.pointer(weivel_number), count: "uint32_t" });
const weivel_capacity_event = structOf({
  want: handle,
  plugin: handle,
  registration: handle,
  request: "uint64_t",
  question: "uint32_t",
  constraints: weivel_numbers,
});
const weivel_capability_event = structOf({
  watch: handle,
  plugin: handle,
  implementation: handle,
  provider: handle,
  change: "uint32_t",
});

/** WEIVEL_EVENT_PAYLOAD_WORDS. */
const EVENT_PAYLOAD_WORDS = 16;

const weivel_event_payload = koffi.union({
  log: weivel_log_event,
  refusal: weivel_refusal,
  want: weivel_want_event,
  watch: weivel_watch_event,
  revoked: weivel_revoked_event,
  reach: weivel_reach_refusal,
  capacity: weivel_capacity_event,
  capability: weivel_capability_event,
  refused: weivel_refusal_event,
  reserved: koffi.array("uint64_t", EVENT_PAYLOAD_WORDS),
});
const weivel_event = structOf({ ...sizeField, kind: "uint32_t", storage: "void *", data: weivel_event_payload });

const weivel_strings = structOf({ items: koffi.pointer(text), count: "uint32_t" });
const weivel_service_offer = structOf({ ...sizeField, id: text, attributes: weivel_numbers });
const weivel_service_offers = structOf({ items: koffi.pointer(weivel_service_offer), count: "uint32_t" });
const weivel_service_want = structOf({
  ...sizeField,
  id: text,
  provider: text,
  optional: "uint32_t",
  degradable: "uint32_t",
  constraints: weivel_numbers,
});
const weivel_service_wants = structOf({ items: koffi.pointer(weivel_service_want), count: "uint32_t" });
const weivel_capability_declarations = structOf({ provides: weivel_strings, consumes: weivel_strings });
const weivel_service_declarations = structOf({ provides: weivel_service_offers, consumes: weivel_service_wants });
const weivel_manifest = structOf({
  ...sizeField,
  import_name: text,
  api: "uint32_t",
  entry: text,
  targets: weivel_strings,
  capabilities: weivel_capability_declarations,
  services: weivel_service_declarations,
  permissions: weivel_strings,
  identity: text,
});
const weivel_constraint_entry = structOf({
  ...sizeField,
  constraint_name: text,
  attribute_name: text,
  bound: "uint32_t",
});
const weivel_constraint_vocabulary = structOf({ items: koffi.pointer(weivel_constraint_entry), count: "uint32_t" });
const weivel_core_options = structOf({
  ...sizeField,
  initial_event_capacity: "uint32_t",
  minimum_log_level: "uint32_t",
  api: "uint32_t",
  applications: weivel_strings,
  well_known_services: weivel_strings,
  constraint_vocabulary: weivel_constraint_vocabulary,
});
const weivel_support = structOf({
  ...sizeField,
  supported: "uint32_t",
  axis: "uint32_t",
  refusal: weivel_refusal,
  storage: "void *",
  subject: text,
  has_fix: "uint32_t",
});
const weivel_edge = structOf({ provider: handle, consumer: handle });
const weivel_cycle = structOf({ members: koffi.pointer(handle), count: "uint32_t" });
const weivel_plugin_refusal = structOf({ plugin: handle, refusal: weivel_refusal });
const weivel_refusal_subject = structOf({ subject: text, has_fix: "uint32_t" });
const weivel_activation_plan = structOf({
  ...sizeField,
  order: koffi.pointer(handle),
  order_count: "uint32_t",
  edges: koffi.pointer(weivel_edge),
  edge_count: "uint32_t",
  cycles: koffi.pointer(weivel_cycle),
  cycle_count: "uint32_t",
  refusals: koffi.pointer(weivel_plugin_refusal),
  refusal_count: "uint32_t",
  storage: "void *",
  refusal_subjects: koffi.pointer(weivel_refusal_subject),
});
const weivel_plugin_options = structOf({ ...sizeField, payload: "uint64_t" });
const weivel_quarantine_reason = structOf({ ...sizeField, code: "uint32_t", detail: text, fix: text });
const weivel_want_options = structOf({
  ...sizeField,
  timed: "uint32_t",
  now: "int64_t",
  timeout_millis: "int64_t",
  budgeted: "uint32_t",
  budget_millis: "int64_t",
  poll_millis: "int64_t",
});
const weivel_capacity = structOf({ ...sizeField, request: "uint64_t", attributes: weivel_numbers, serves: "uint32_t" });
const weivel_service_list = structOf({ ...sizeField, ids: weivel_strings, storage: "void *" });
const weivel_capability_implementation = structOf({ ...sizeField, implementation: handle, provider: handle });
const weivel_capability_list = structOf({
  ...sizeField,
  items: koffi.pointer(weivel_capability_implementation),
  count: "uint32_t",
  storage: "void *",
});
const weivel_ledger_row = structOf({
  ...sizeField,
  plugin: handle,
  import_name: text,
  identity: text,
  status: "uint32_t",
  verified: "uint32_t",
  refusal: weivel_refusal,
  capabilities_declared: weivel_strings,
  permissions: weivel_strings,
  services_provided: weivel_strings,
  capabilities_provided: weivel_strings,
  services_consumed: weivel_strings,
  storage: "void *",
  capabilities_consumed: weivel_strings,
  subject: text,
  has_fix: "uint32_t",
});
const weivel_declaration_refusal = structOf({
  ...sizeField,
  kind: "uint32_t",
  plugin: handle,
  id: text,
  code: "uint32_t",
  subject: text,
  has_fix: "uint32_t",
});
const weivel_ledger_snapshot = structOf({
  ...sizeField,
  rows: koffi.pointer(weivel_ledger_row),
  row_count: "uint32_t",
  refusals: koffi.pointer(weivel_declaration_refusal),
  refusal_count: "uint32_t",
  storage: "void *",
});

/** Every struct core.h declares, under its header name, laid out field for field as the header lays it out. */
export const coreStructs = {
  weivel_refusal,
  weivel_log_event,
  weivel_want_event,
  weivel_watch_event,
  weivel_revoked_event,
  weivel_reach_refusal,
  weivel_refusal_event,
  weivel_number,
  weivel_numbers,
  weivel_capacity_event,
  weivel_capability_event,
  weivel_event,
  weivel_strings,
  weivel_service_offer,
  weivel_service_offers,
  weivel_service_want,
  weivel_service_wants,
  weivel_capability_declarations,
  weivel_service_declarations,
  weivel_manifest,
  weivel_constraint_entry,
  weivel_constraint_vocabulary,
  weivel_core_options,
  weivel_support,
  weivel_edge,
  weivel_cycle,
  weivel_plugin_refusal,
  weivel_refusal_subject,
  weivel_activation_plan,
  weivel_plugin_options,
  weivel_quarantine_reason,
  weivel_want_options,
  weivel_capacity,
  weivel_service_list,
  weivel_capability_implementation,
  weivel_capability_list,
  weivel_ledger_row,
  weivel_declaration_refusal,
  weivel_ledger_snapshot,
} as const;

export type CoreStructName = keyof typeof coreStructs;

/** `sizeof` of a header struct as these declarations lay it out: the value every struct the layer builds carries. */
export function sizeOf(name: CoreStructName): number {
  return koffi.sizeof(coreStructs[name]);
}

export function offsetOf(name: CoreStructName, field: string): number {
  return koffi.offsetof(coreStructs[name], field);
}

const corePointer = koffi.pointer(koffi.opaque());
const pendingEvents = "uint32_t *";
const handleOut = koffi.out(koffi.pointer(handle));
const status = "int";

function pointerTo(name: CoreStructName): KoffiType {
  return koffi.pointer(coreStructs[name]);
}

type Signature = [result: TypeSpec, parameters: TypeSpec[]];

const coreSignatures = {
  weivel_core_create: [status, [pointerTo("weivel_core_options"), koffi.out(koffi.pointer(corePointer)), pendingEvents]],
  weivel_core_destroy: [status, [corePointer]],
  weivel_next_event: [status, [corePointer, pointerTo("weivel_event"), pendingEvents]],
  weivel_event_release: [status, [pointerTo("weivel_event")]],
  weivel_next_deadline: [status, [corePointer, koffi.out(koffi.pointer("int64_t")), pendingEvents]],
  weivel_advance: [status, [corePointer, "int64_t", pendingEvents]],
  weivel_supports: [status, [corePointer, pointerTo("weivel_manifest"), pointerTo("weivel_support"), pendingEvents]],
  weivel_support_release: [status, [pointerTo("weivel_support")]],
  weivel_register_manifest: [status, [corePointer, pointerTo("weivel_manifest"), handleOut, pendingEvents]],
  weivel_plan_activation: [
    status,
    [
      corePointer,
      koffi.pointer(handle),
      "uint32_t",
      "uint32_t",
      pointerTo("weivel_strings"),
      pointerTo("weivel_activation_plan"),
      pendingEvents,
    ],
  ],
  weivel_activation_plan_release: [status, [pointerTo("weivel_activation_plan")]],
  weivel_open_plugin: [status, [corePointer, handle, pointerTo("weivel_plugin_options"), pendingEvents]],
  weivel_plugin_payload: [status, [corePointer, handle, koffi.out(koffi.pointer("uint64_t")), pendingEvents]],
  weivel_release_plugin: [status, [corePointer, handle, pendingEvents]],
  weivel_quarantine_plugin: [status, [corePointer, handle, pointerTo("weivel_quarantine_reason"), pendingEvents]],
  weivel_forget_plugin: [status, [corePointer, handle, pendingEvents]],
  weivel_register_service: [status, [corePointer, handle, text, handleOut, pendingEvents]],
  weivel_unregister: [status, [corePointer, handle, pendingEvents]],
  weivel_handle_state: [status, [corePointer, handle, koffi.out(koffi.pointer("uint32_t")), pendingEvents]],
  weivel_get_service: [status, [corePointer, handle, text, handleOut, pendingEvents]],
  weivel_want_service: [status, [corePointer, handle, text, pointerTo("weivel_want_options"), handleOut, pendingEvents]],
  weivel_report_capacity: [status, [corePointer, handle, handle, pointerTo("weivel_capacity"), "int64_t", pendingEvents]],
  weivel_watch_service: [status, [corePointer, handle, text, handleOut, pendingEvents]],
  weivel_service_ids: [status, [corePointer, handle, pointerTo("weivel_service_list"), pendingEvents]],
  weivel_unbound_services: [status, [corePointer, handle, pointerTo("weivel_service_list"), pendingEvents]],
  weivel_service_list_release: [status, [pointerTo("weivel_service_list")]],
  weivel_provide_capability: [status, [corePointer, handle, text, handleOut, pendingEvents]],
  weivel_verify_activation: [status, [corePointer, handle, pendingEvents]],
  weivel_all_capabilities: [status, [corePointer, handle, text, pointerTo("weivel_capability_list"), pendingEvents]],
  weivel_capability_list_release: [status, [pointerTo("weivel_capability_list")]],
  weivel_watch_capability: [status, [corePointer, handle, text, handleOut, pendingEvents]],
  weivel_ledger: [status, [corePointer, pointerTo("weivel_ledger_snapshot"), pendingEvents]],
  weivel_ledger_snapshot_release: [status, [pointerTo("weivel_ledger_snapshot")]],
  weivel_ledger_entry: [status, [corePointer, handle, pointerTo("weivel_ledger_row"), pendingEvents]],
  weivel_ledger_row_release: [status, [pointerTo("weivel_ledger_row")]],
} as const satisfies Record<string, Signature>;

export type CoreFunctionName = keyof typeof coreSignatures;

/** Every core.h function, bound from one loaded library; each answers a weivel_status as a number. */
export type CoreFunctions = Record<CoreFunctionName, (...parameters: unknown[]) => number>;

export const coreFunctionNames = Object.keys(coreSignatures) as CoreFunctionName[];

export function bindCoreFunctions(library: koffi.IKoffiLib): CoreFunctions {
  const bound: Partial<CoreFunctions> = {};
  for (const name of coreFunctionNames) {
    const [result, parameters] = coreSignatures[name] as Signature;
    bound[name] = library.func(name, result, parameters) as (...parameters: unknown[]) => number;
  }
  return bound as CoreFunctions;
}
