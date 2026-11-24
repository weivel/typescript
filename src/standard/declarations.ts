import koffi from "koffi";
import { coreStructs } from "../core/declarations.js";

type KoffiType = ReturnType<typeof koffi.opaque>;
type TypeSpec = string | KoffiType;

const text = "const char *";
const count = "size_t";
const pointer = "void *";
const sizeField = { size: "uint32_t" } as const;

/** @remarks Anonymous, as the core's declarations are, so a module evaluated twice in one process is not refused. */
function structOf(fields: Record<string, TypeSpec>): KoffiType {
  return koffi.struct(fields);
}

const weivel_standard_refusal = structOf({
  ...sizeField,
  code: "uint32_t",
  detail: text,
  fix: text,
  path: text,
  storage: pointer,
});
const weivel_standard_validation_options = structOf({
  ...sizeField,
  well_known_services: koffi.pointer(coreStructs.weivel_strings),
});
const weivel_standard_validation = structOf({
  ...sizeField,
  valid: "uint32_t",
  paths: coreStructs.weivel_strings,
  refusal: weivel_standard_refusal,
  storage: pointer,
});
/** `name` is read by `name_length`, since a local name may itself hold a NUL. */
const weivel_standard_identity = structOf({
  ...sizeField,
  kind: "uint32_t",
  name: pointer,
  name_length: count,
  forge: text,
  host: text,
  number: "uint64_t",
  segments: koffi.pointer(text),
  segment_count: count,
});
const weivel_standard_discovered_plugin = structOf({
  manifest: pointer,
  manifest_path: text,
  identity_path: text,
  identity_id: text,
  repository_name: text,
  identity: weivel_standard_identity,
  entry_path: text,
  entry_present: "uint32_t",
});
const weivel_standard_discovery_failure = structOf({ file: text, refusal: weivel_standard_refusal });
const weivel_standard_discovery = structOf({
  ...sizeField,
  plugins: pointer,
  plugin_count: count,
  failures: pointer,
  failure_count: count,
  refusal: weivel_standard_refusal,
});
const weivel_standard_library_function = structOf({
  name: text,
  symbol: text,
  kind: "uint32_t",
  context: "uint32_t",
});
const weivel_standard_library_service = structOf({ id: text, functions: pointer, function_count: count });
const weivel_standard_library_contract = structOf({ capability: text, description: text });
const weivel_standard_library = structOf({
  ...sizeField,
  import_name: text,
  version: text,
  release: text,
  services: pointer,
  service_count: count,
  storage: pointer,
  descriptions: pointer,
  contracts: pointer,
  contract_count: count,
});
const weivel_standard_mirror_list = structOf({
  ...sizeField,
  templates: koffi.pointer(text),
  count,
  storage: pointer,
});
const weivel_standard_service_refusal = structOf({ ...sizeField, detail: text, fix: text, storage: pointer });
const weivel_standard_setting_value = structOf({
  kind: "uint32_t",
  boolean: "uint32_t",
  number: "double",
  text,
  text_length: count,
});
const weivel_standard_setting = structOf({ key: text, value: weivel_standard_setting_value });
const weivel_standard_settings = structOf({ ...sizeField, settings: pointer, count, storage: pointer });
const weivel_standard_setting_answer = structOf({ ...sizeField, value: weivel_standard_setting_value, storage: pointer });
const weivel_standard_settings_file = structOf({ ...sizeField, path: text, storage: pointer });
/** A definition's operations are function pointers the provider fills; this layer lays them out and calls none. */
const weivel_standard_config = structOf({
  ...sizeField,
  context: pointer,
  all: pointer,
  get: pointer,
  set: pointer,
  release_settings: pointer,
  release_answer: pointer,
  release_refusal: pointer,
  get_tree: pointer,
  release_tree: pointer,
  settings_file: pointer,
  release_settings_file: pointer,
});
const weivel_standard_secret = structOf({ ...sizeField, bytes: pointer, length: count, storage: pointer });
const weivel_standard_secrets = structOf({
  ...sizeField,
  context: pointer,
  remove: pointer,
  get: pointer,
  set: pointer,
  release_secret: pointer,
  release_refusal: pointer,
});
const weivel_standard_value = structOf({
  kind: "uint32_t",
  boolean: "uint32_t",
  number: "double",
  text: pointer,
  length: count,
  items: pointer,
  entries: pointer,
  count,
});
/** `key` is read by `key_length`, as a value's text is by `length`. */
const weivel_standard_entry = structOf({ key: pointer, key_length: count, value: weivel_standard_value });
const weivel_standard_value_tree = structOf({ ...sizeField, root: weivel_standard_value, storage: pointer });
const weivel_standard_paths = structOf({ ...sizeField, context: pointer, cache: pointer, config: pointer, plugin: pointer });
const weivel_standard_log = structOf({ ...sizeField, context: pointer, write: pointer, release_refusal: pointer });
const weivel_standard_scope = structOf({
  ...sizeField,
  config: pointer,
  secrets: pointer,
  paths: pointer,
  log: pointer,
  storage: pointer,
});
const weivel_standard_scopes = structOf({
  ...sizeField,
  context: pointer,
  open: pointer,
  release_scope: pointer,
  release_refusal: pointer,
});
const weivel_standard_host_library = structOf({ binary: text, declaration: text });
const weivel_standard_host_plugin = structOf({ directory: text, manifest: text, entry: text });
const weivel_standard_host_plan = structOf({
  ...sizeField,
  mode: "uint32_t",
  libraries: pointer,
  library_count: count,
  plugins: pointer,
  plugin_count: count,
  action_plugin: text,
  action_name: text,
  action_arguments: weivel_standard_value,
  storage: pointer,
  action_service: text,
  action_method: text,
});
const weivel_standard_host_outcome = structOf({ manifest: text, state: "uint32_t", detail: text });
const weivel_standard_host_next = structOf({ ...sizeField, has_next: "uint32_t", next: "int64_t", storage: pointer });
const weivel_standard_host = structOf({
  ...sizeField,
  context: pointer,
  start: pointer,
  started: pointer,
  tick: pointer,
  finished: pointer,
  stop: pointer,
  release_plan: pointer,
  release_next: pointer,
  release_refusal: pointer,
});

/**
 * Every struct the standard's headers declare by name but `weivel/description.h`'s, laid out field for field as the
 * headers lay them out. The core's structs they embed or point at (weivel_strings, weivel_manifest) are the core's
 * own declarations, and a description's are the host's, which alone reads one.
 */
export const standardStructs = {
  weivel_standard_refusal,
  weivel_standard_validation_options,
  weivel_standard_validation,
  weivel_standard_identity,
  weivel_standard_discovered_plugin,
  weivel_standard_discovery_failure,
  weivel_standard_discovery,
  weivel_standard_library_function,
  weivel_standard_library_service,
  weivel_standard_library_contract,
  weivel_standard_library,
  weivel_standard_mirror_list,
  weivel_standard_service_refusal,
  weivel_standard_setting_value,
  weivel_standard_setting,
  weivel_standard_settings,
  weivel_standard_setting_answer,
  weivel_standard_settings_file,
  weivel_standard_config,
  weivel_standard_secret,
  weivel_standard_secrets,
  weivel_standard_paths,
  weivel_standard_log,
  weivel_standard_scope,
  weivel_standard_scopes,
  weivel_standard_host_library,
  weivel_standard_host_plugin,
  weivel_standard_host_plan,
  weivel_standard_host_outcome,
  weivel_standard_host_next,
  weivel_standard_host,
  weivel_standard_value,
  weivel_standard_entry,
  weivel_standard_value_tree,
} as const;

export type StandardStructName = keyof typeof standardStructs;

export function standardSizeOf(name: StandardStructName): number {
  return koffi.sizeof(standardStructs[name]);
}

const status = "int";
const bytes = "const void *";
const pointerOut = koffi.out(koffi.pointer(pointer));

function pointerTo(name: StandardStructName): KoffiType {
  return koffi.pointer(standardStructs[name]);
}

type Signature = [result: TypeSpec, parameters: TypeSpec[]];

const standardSignatures = {
  weivel_standard_refusal_release: ["void", [pointerTo("weivel_standard_refusal")]],
  weivel_standard_manifest_view: [pointer, [pointer]],
  weivel_standard_manifest_release: ["void", [pointer]],
  weivel_standard_validation_release: ["void", [pointerTo("weivel_standard_validation")]],
  weivel_standard_load_manifest: [
    status,
    [bytes, count, pointerTo("weivel_standard_validation_options"), pointerOut, pointerTo("weivel_standard_validation")],
  ],
  weivel_standard_discover: [
    status,
    [text, pointerTo("weivel_standard_validation_options"), pointerTo("weivel_standard_discovery")],
  ],
  weivel_standard_discovery_release: ["void", [pointerTo("weivel_standard_discovery")]],
  weivel_standard_identity_parse: [
    status,
    [bytes, count, pointerTo("weivel_standard_identity"), pointerTo("weivel_standard_refusal")],
  ],
  weivel_standard_identity_release: ["void", [pointerTo("weivel_standard_identity")]],
  weivel_standard_identity_compare: ["int", [pointerTo("weivel_standard_identity"), pointerTo("weivel_standard_identity")]],
  weivel_standard_read_library: [
    status,
    [bytes, count, pointerTo("weivel_standard_library"), pointerTo("weivel_standard_refusal")],
  ],
  weivel_standard_library_release: ["void", [pointerTo("weivel_standard_library")]],
  weivel_standard_read_mirrors: [
    status,
    [bytes, count, pointerTo("weivel_standard_mirror_list"), pointerTo("weivel_standard_refusal")],
  ],
  weivel_standard_load_mirrors: [
    status,
    [text, pointerTo("weivel_standard_mirror_list"), pointerTo("weivel_standard_refusal")],
  ],
  weivel_standard_mirror_list_release: ["void", [pointerTo("weivel_standard_mirror_list")]],
  weivel_standard_mirror_expand: [status, [text, text, pointerOut, pointerTo("weivel_standard_refusal")]],
  weivel_standard_text_release: ["void", [pointer]],
  weivel_standard_service_config: [text, []],
  weivel_standard_service_secrets: [text, []],
  weivel_standard_service_paths: [text, []],
  weivel_standard_service_log: [text, []],
  weivel_standard_service_scope: [text, []],
  weivel_standard_service_host: [text, []],
  weivel_standard_config_description: [pointer, []],
  weivel_standard_secrets_description: [pointer, []],
  weivel_standard_paths_description: [pointer, []],
  weivel_standard_log_description: [pointer, []],
  weivel_standard_sha256: ["void", [bytes, count, "uint8_t *"]],
  weivel_standard_sha256_hex: ["void", [bytes, count, "char *"]],
  weivel_standard_is_sha256_hex: ["int", [text]],
  weivel_standard_verify_download: [status, [bytes, count, text, pointerTo("weivel_standard_refusal")]],
  weivel_standard_description_check: [status, [pointer, pointerTo("weivel_standard_refusal")]],
  weivel_standard_description_answers: [status, [pointer, pointer, pointerTo("weivel_standard_refusal")]],
} as const satisfies Record<string, Signature>;

export type StandardFunctionName = keyof typeof standardSignatures;

export type StandardFunctions = Record<StandardFunctionName, (...parameters: unknown[]) => unknown>;

export const standardFunctionNames = Object.keys(standardSignatures) as StandardFunctionName[];

/**
 * What the standard's headers declare and this layer leaves unbound.
 *
 * @remarks `weivel_standard_read_manifest` converts without validating, so a host reading through it could hand the
 * core a manifest that skipped validation; `weivel_standard_validate` answers exactly the validation
 * `weivel_standard_load_manifest` answers beside the manifest; the JSON reader would carry JSON across the C boundary.
 */
export const unboundStandardFunctionNames = [
  "weivel_standard_read_manifest",
  "weivel_standard_validate",
  "weivel_json_parse",
  "weivel_json_free",
  "weivel_json_kind_of",
  "weivel_json_object_get",
  "weivel_json_object_size",
  "weivel_json_object_key_at",
  "weivel_json_object_value_at",
  "weivel_json_array_length",
  "weivel_json_array_at",
  "weivel_json_as_string",
  "weivel_json_string_length",
  "weivel_json_as_bool",
  "weivel_json_as_int64",
  "weivel_json_as_double",
] as const;

export function bindStandardFunctions(library: koffi.IKoffiLib): StandardFunctions {
  const bound: Partial<StandardFunctions> = {};
  for (const name of standardFunctionNames) {
    const [result, parameters] = standardSignatures[name] as Signature;
    bound[name] = library.func(name, result, parameters) as (...parameters: unknown[]) => unknown;
  }
  return bound as StandardFunctions;
}
