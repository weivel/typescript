// Generated from the library.json of runtime 0.1.0; regenerate it from the declaration rather than editing it.
import type { ServiceType } from "@weivel/typescript";

export interface PathsService {
  resolve(argument: { home: string; names?: { [key: string]: unknown }; plugin?: string; places?: { portable: string; cache: string; [key: string]: unknown }; [key: string]: unknown }): { home: string; repos: string; plugin: string; cache: string; config: string; portable?: string; pluginCache?: string };
}

export const Paths: ServiceType<PathsService> = { id: "paths" };

export interface PlacesService {
  resolve(argument: { home: string; environment?: { [key: string]: unknown }; [key: string]: unknown }): { portable: string; state: string; cache: string; secretsFile: string; forceFileStore: boolean };
}

export const Places: ServiceType<PlacesService> = { id: "places" };

export interface ConfigService {
  all(argument: { home: string; names?: { [key: string]: unknown }; portable?: string; plugin: string; config?: { [key: string]: unknown }; [key: string]: unknown }): { values: { [key: string]: unknown } };
  get(argument: { home: string; names?: { [key: string]: unknown }; portable?: string; plugin: string; config?: { [key: string]: unknown }; key: string; [key: string]: unknown }): { value?: unknown };
  set(argument: { home: string; names?: { [key: string]: unknown }; portable?: string; plugin: string; config?: { [key: string]: unknown }; key: string; value: unknown; layer?: "application" | "portable"; [key: string]: unknown }): { previous?: unknown };
}

export const Config: ServiceType<ConfigService> = { id: "config" };

export interface SettingsService {
  all(argument: { home: string; names?: { [key: string]: unknown }; portable?: string; [key: string]: unknown }): { values: { [key: string]: unknown } };
  set(argument: { home: string; names?: { [key: string]: unknown }; portable?: string; key: string; value: unknown; layer?: "application" | "portable"; [key: string]: unknown }): { previous?: unknown };
}

export const Settings: ServiceType<SettingsService> = { id: "settings" };

export interface LogService {
  write(argument: { home: string; names?: { [key: string]: unknown }; portable?: string; plugin: string; config?: { [key: string]: unknown }; start: string; time: string; level: "debug" | "info" | "warn" | "error"; message: string; noColor: boolean; [key: string]: unknown }): { console?: string };
}

export const Log: ServiceType<LogService> = { id: "log" };

export interface SecretsService {
  get(argument: { places: { secretsFile: string; forceFileStore: boolean; [key: string]: unknown }; plugin: string; name: string; [key: string]: unknown }): { value?: string };
  set(argument: { places: { secretsFile: string; forceFileStore: boolean; [key: string]: unknown }; plugin: string; name: string; value: string; [key: string]: unknown }): { place: "store" | "file" };
  delete(argument: { places: { secretsFile: string; forceFileStore: boolean; [key: string]: unknown }; plugin: string; name: string; [key: string]: unknown }): { [key: string]: never };
  clear(argument: { places: { secretsFile: string; forceFileStore: boolean; [key: string]: unknown }; plugin: string; [key: string]: unknown }): { [key: string]: never };
  reconcile(argument: { places: { secretsFile: string; forceFileStore: boolean; [key: string]: unknown }; [key: string]: unknown }): { moved: number };
}

export const Secrets: ServiceType<SecretsService> = { id: "secrets" };

export interface RegistryService {
  register(argument: { places: { state: string; [key: string]: unknown }; registration: { id: string; kind: "host"; version: string; home?: string; application?: { [key: string]: unknown }; provenance: { method: string; version: string; location: string; os: string; architecture: string; installedAt: string; [key: string]: unknown }; requiresCommand: boolean; start?: { runtime: "javascript" | "jvm" | "native"; entry: string; [key: string]: unknown }; [key: string]: unknown }; [key: string]: unknown }): { registration: { [key: string]: unknown } };
  get(argument: { places: { state: string; [key: string]: unknown }; id: string; [key: string]: unknown }): { registration?: { [key: string]: unknown } };
  list(argument: { places: { state: string; [key: string]: unknown }; [key: string]: unknown }): { hosts: { registration: { [key: string]: unknown }; orphan: boolean }[]; unreadable: string[] };
  forget(argument: { places: { state: string; cache: string; [key: string]: unknown }; id: string; [key: string]: unknown }): { forgotten: boolean };
}

export const Registry: ServiceType<RegistryService> = { id: "registry" };

export interface ChangesService {
  apply(argument: { places: { state: string; [key: string]: unknown }; host: string; change: { kind: "file" | "directory" | "json-key" | "profile-line" | "path-entry"; path?: string; content?: string; executable?: boolean; file?: string; key?: string[]; value?: unknown; line?: string; directory?: string; home?: string; source?: string; create?: boolean; shell?: string; [key: string]: unknown }; [key: string]: unknown }): { recorded: boolean; sequence?: number };
  reverse(argument: { places: { state: string; [key: string]: unknown }; host: string; [key: string]: unknown }): { reversed: number; drifted: { sequence: number; kind: string; detail: string }[] };
}

export const Changes: ServiceType<ChangesService> = { id: "changes" };

export interface CommandsService {
  request(argument: { places: { state: string; [key: string]: unknown }; environment: { [key: string]: unknown }; host: string; home: string; name: string; target: string; arguments?: string[]; [key: string]: unknown }): { name?: string };
  rename(argument: { places: { state: string; [key: string]: unknown }; environment: { [key: string]: unknown }; host: string; from: string; to: string; [key: string]: unknown }): { name: string };
  delete(argument: { places: { state: string; [key: string]: unknown }; host: string; name: string; [key: string]: unknown }): { deleted: true };
  add(argument: { places: { state: string; [key: string]: unknown }; environment: { [key: string]: unknown }; host: string; home: string; name: string; target: string; arguments?: string[]; [key: string]: unknown }): { name: string };
}

export const Commands: ServiceType<CommandsService> = { id: "commands" };

export interface InstallService {
  packages(argument: { places: { portable: string; [key: string]: unknown }; item: string; manifestPackages?: { [key: string]: unknown }; [key: string]: unknown }): { packages: { [key: string]: unknown } };
  plan(argument: { places: { portable: string; [key: string]: unknown }; item: string; manifestPackages?: { [key: string]: unknown }; methods: string[]; chosen: string; installedProviders?: string[]; catalog?: { [key: string]: unknown }[]; [key: string]: unknown }): { steps: { [key: string]: unknown }[] };
  detect(argument: { places: { portable: string; cache: string; [key: string]: unknown }; item: string; manifestPackages?: { [key: string]: unknown }; [key: string]: unknown }): { detections: { method: string; item: string; package?: string; options?: { [key: string]: unknown }; answer?: { installed: boolean; version?: string; [key: string]: unknown }; refused?: string }[] };
  entry(argument: { places: { state: string; cache: string; [key: string]: unknown }; loader: { id: string; application: { id: string; label?: string; [key: string]: unknown }; home: string; [key: string]: unknown }; [key: string]: unknown }): { written: boolean; sequences?: number[]; message?: string; fix?: string };
  runtime(argument: { cache: string; platform?: string; environment: { [key: string]: string }; [key: string]: unknown }): { name: "node"; version: string; executable: string; fetched: boolean; source: "path" | "acquired" };
  ecosystem(argument: { sources: ({ kind: "local"; path: string; [key: string]: unknown } | { kind: "https"; url: string; [key: string]: unknown })[]; places: { portable: string; state: string; cache: string; [key: string]: unknown }; environment: { [key: string]: string }; choices?: { [key: string]: string }; defaults?: string[]; requested?: string[]; platform?: string; [key: string]: unknown }): { installed: { id: string; version: string }[]; cached: string[]; unavailable: { id: string; message: string; fix: string }[]; enabled: string[]; applications: ({ id: string; state: "installed" | "detected" | "skipped" | "missing" | "unavailable" | "failed"; installedThrough?: string; origin?: { method: string; package?: string; options?: { [key: string]: unknown }; version?: string }; offered?: string[]; flag?: string; unavailable?: { method: string; message: string; fix: string }[] })[]; loaders: { id: string; application: string; home: string; commands: string[]; refusedCommands: { name: string; detail: string; fix: string }[]; entry: { written: boolean; message?: string; fix?: string } }[]; missing: { application: string; methods: string[] }[]; javascript?: { name: "node"; version: string; executable: string; fetched: boolean; source: "path" | "acquired" } };
  application(argument: { places: { portable: string; state: string; cache: string; [key: string]: unknown }; loader: string; operation: "update" | "remove"; [key: string]: unknown }): { operation: "update" | "remove"; version?: string; unrecorded?: { message: string; fix: string } };
  registerLoader(argument: { places: { portable: string; state: string; cache: string; [key: string]: unknown }; environment: { [key: string]: string }; id: string; version: string; [key: string]: unknown }): { provenance: { [key: string]: unknown }; commands: string[]; refusedCommands: { name: string; detail: string; fix: string }[] };
}

export const Install: ServiceType<InstallService> = { id: "install" };

export interface FetchService {
  get(argument: { url: string; destination: string; sha256?: string; etag?: string; lastModified?: string; maxBytes?: number; timeoutSeconds?: number; [key: string]: unknown }): { outcome: "stored" | "not-modified"; sha256?: string; bytes?: number; etag?: string; lastModified?: string };
}

export const Fetch: ServiceType<FetchService> = { id: "fetch" };

export interface CatalogService {
  read(argument: { text: string; origin: string; [key: string]: unknown }): { catalog: { format: 1; items: { [key: string]: unknown }; [key: string]: unknown } };
  sources(argument: { settings: { [key: string]: unknown }; [key: string]: unknown }): { sources: ({ kind: "local"; path: string; [key: string]: unknown } | { kind: "https"; url: string; [key: string]: unknown })[]; skipped: { index: number; detail: string }[] };
  merge(argument: { catalogs: ({ source: { kind: "local"; path: string; [key: string]: unknown } | { kind: "https"; url: string; [key: string]: unknown }; catalog: { format: 1; items: { [key: string]: unknown }; [key: string]: unknown }; [key: string]: unknown })[]; [key: string]: unknown }): { catalog: { format: 1; items: { [key: string]: unknown }; [key: string]: unknown }; shadowed: ({ id: string; source: { kind: "local"; path: string; [key: string]: unknown } | { kind: "https"; url: string; [key: string]: unknown } })[] };
  check(argument: { source: { kind: "local"; path: string; [key: string]: unknown } | { kind: "https"; url: string; [key: string]: unknown }; cache: string; now: string; intervalHours: number; [key: string]: unknown }): { kind: "skipped" | "unchanged" | "changed" | "failed"; catalog?: { format: 1; items: { [key: string]: unknown }; [key: string]: unknown }; detail?: string };
  current(argument: { sources: ({ kind: "local"; path: string; [key: string]: unknown } | { kind: "https"; url: string; [key: string]: unknown })[]; cache: string; [key: string]: unknown }): { catalog: { format: 1; items: { [key: string]: unknown }; [key: string]: unknown } };
  resolve(argument: { catalog: { format: 1; items: { [key: string]: unknown }; [key: string]: unknown }; enabled: { id: string; pin?: string; [key: string]: unknown }[]; installed: { [key: string]: string[] }; kind?: "plugin" | "host" | "library"; [key: string]: unknown }): { run: { [key: string]: string }; fetch: { id: string; version: string }[] };
}

export const Catalog: ServiceType<CatalogService> = { id: "catalog" };

export interface CacheService {
  install(argument: { cache: string; id: string; item: { [key: string]: unknown }; version: string; platform?: string; [key: string]: unknown }): { id: string; version: string; directory: string; fetched: string[]; cached: string[] };
  installed(argument: { cache: string; platform?: string; [key: string]: unknown }): { bundles: { [key: string]: string[] }; libraries: { [key: string]: string[] } };
  check(argument: { directory: string; [key: string]: unknown }): { kind: "absent" | "intact" | "damaged"; detail?: string; fix?: string; file?: string };
  platform(argument: { [key: string]: unknown }): { platform: string };
  sweep(argument: { cache: string; state: string; [key: string]: unknown }): { removed: string[] };
}

export const Cache: ServiceType<CacheService> = { id: "cache" };

export interface UpdatesService {
  apply(argument: { places: { state: string; cache: string; [key: string]: unknown }; hostId: string; settings?: { [key: string]: unknown }; defaults?: { [key: string]: string }; running?: { [key: string]: string }; libraries?: string[]; platform?: string; [key: string]: unknown }): { plugins: { [key: string]: string }; run: { [key: string]: string }; next: { [key: string]: string }; rollback: { [key: string]: string }; unrecorded: { message: string; fix: string }[]; runRecord: string };
  check(argument: { places: { state: string; cache: string; [key: string]: unknown }; hostId: string; now: string; settings?: { [key: string]: unknown }; defaults?: { [key: string]: string }; problems?: { id: string; version: string; [key: string]: unknown }[]; platform?: string; [key: string]: unknown }): { checked: ({ kind: "skipped" | "unchanged" | "changed" | "failed"; detail?: string })[]; fetched: string[]; refused: { id: string; message: string; fix: string }[]; removed: string[] };
  rollback(argument: { places: { state: string; cache: string; [key: string]: unknown }; hostId: string; item: string; [key: string]: unknown }): { run: { [key: string]: string }; next: { [key: string]: string }; rollback: { [key: string]: string } };
}

export const Updates: ServiceType<UpdatesService> = { id: "updates" };

export interface BootService {
  read(argument: { cache: string; hostId: string; [key: string]: unknown }): { hint?: { libraries: { [key: string]: string }; host?: string } };
  write(argument: { cache: string; hostId: string; libraries: { [key: string]: string }; host?: string; state?: string; [key: string]: unknown }): { hint: { libraries: { [key: string]: string }; host?: string } };
  resolve(argument: { cache: string; hostId?: string; arguments?: string[]; platform?: string; [key: string]: unknown }): { executable: string; arguments: string[]; version: string; directory: string };
}

export const Boot: ServiceType<BootService> = { id: "boot" };

export interface ProcessesService {
  hold(argument: { state: string; hostId: string; holder: number; start: { executable: string; arguments?: string[]; environment?: { [key: string]: string }; directory?: string; [key: string]: unknown }; [key: string]: unknown }): { pid: number; started: boolean; outsideJob?: boolean };
  release(argument: { state: string; hostId: string; holder: number; [key: string]: unknown }): { holders: number[] };
  prune(argument: { state: string; hostId: string; self: number; now?: number; checkMilliseconds?: number; [key: string]: unknown }): { exit: boolean };
  recordRun(argument: { state: string; hostId: string; run: { [key: string]: string }; checkMilliseconds?: number; record?: string; [key: string]: unknown }): { record: string };
  liveRuns(argument: { state: string; now?: number; [key: string]: unknown }): { runs: { [key: string]: string }[] };
  removeRuns(argument: { state: string; hostId: string; record?: string; [key: string]: unknown }): { [key: string]: never };
}

export const Processes: ServiceType<ProcessesService> = { id: "processes" };

export interface HostsService {
  register(argument: { places: { state: string; [key: string]: unknown }; identity: { id: string; version: string; home?: string; application?: { [key: string]: unknown }; requiresCommand: boolean; commands: { name: string; target: string; arguments?: string[]; [key: string]: unknown }[]; start?: { runtime: "javascript" | "jvm" | "native"; entry: string; [key: string]: unknown }; [key: string]: unknown }; provenance: { [key: string]: unknown }; environment: { [key: string]: string }; [key: string]: unknown }): { provenance: { [key: string]: unknown }; commands: string[]; refusedCommands: { name: string; detail: string; fix: string }[] };
  list(argument: { places: { state: string; [key: string]: unknown }; [key: string]: unknown }): { hosts: { registration: { [key: string]: unknown }; orphan: boolean }[]; unreadable: string[] };
  remove(argument: { places: { state: string; cache: string; [key: string]: unknown }; id: string; [key: string]: unknown }): { reversed: number; drifted: unknown[]; forgotten: boolean };
  provenance(argument: { origin: { method: string; package?: string; options?: { [key: string]: unknown }; version?: string; [key: string]: unknown }; application: { binary: string; [key: string]: unknown }; home: string; environment: { [key: string]: string }; now?: number; [key: string]: unknown }): { method: string; package?: string; options?: { [key: string]: unknown }; version?: string; location: string; os: string; architecture: string; installedAt: string };
}

export const Hosts: ServiceType<HostsService> = { id: "hosts" };

export interface LoaderService {
  check(argument: { standard: unknown; [key: string]: unknown }): { issues: { path: string; detail: string; fix: string }[] };
  home(argument: { home: { envOverride?: string; nativeEnv?: string; xdgSubdir?: string; candidates: string[]; [key: string]: unknown }; environment: { [key: string]: string }; [key: string]: unknown }): { home: string; source: "override" | "native" | "xdg" | "candidate" | "default" };
  installed(argument: { places: { cache: string; [key: string]: unknown }; id: string; version: string; [key: string]: unknown }): { standard: { [key: string]: unknown } };
}

export const Loader: ServiceType<LoaderService> = { id: "loader" };

export interface DetectService {
  onPath(argument: { binary: string; environment: { [key: string]: string }; [key: string]: unknown }): { path?: string };
}

export const Detect: ServiceType<DetectService> = { id: "detect" };

export interface ListsService {
  plugins(argument: { installed: { id: string; [key: string]: unknown }[]; detected: { id: string; [key: string]: unknown }[]; available: { id: string; [key: string]: unknown }[]; [key: string]: unknown }): { items: ({ id: string; state: "installed" | "detected" | "available"; [key: string]: unknown })[] };
  applications(argument: { catalog: { items: { [key: string]: unknown }; [key: string]: unknown }; places: { state: string; [key: string]: unknown }; environment: { [key: string]: string }; detections: { method: string; item: string; package?: string; options?: { [key: string]: unknown }; answer?: { installed: boolean; version?: string; [key: string]: unknown }; refused?: string; [key: string]: unknown }[]; [key: string]: unknown }): { items: ({ id: string; label?: string; state: "installed" | "detected" | "available" })[] };
}

export const Lists: ServiceType<ListsService> = { id: "lists" };

export interface UiService {
  navigation(argument: { descriptions: { id: string; [key: string]: unknown }[]; ui: { [key: string]: unknown }; [key: string]: unknown }): { entries: ({ plugin: string; kind: "view" | "settings" | "action"; id: string; title?: string; pinned: boolean })[]; preferences: { [key: string]: unknown } };
  settingsView(argument: { description: { id: string; [key: string]: unknown }; [key: string]: unknown }): { title: string; nodes: ({ id: string; parent?: string; component: "form" | "field"; field?: string; label?: string })[] };
  plan(argument: { descriptions: { id: string; [key: string]: unknown }[]; screen: { plugin: string; kind: "view" | "settings" | "action"; id?: string; [key: string]: unknown }; answers?: { plugin: string; binding: { service: string; method: string; [key: string]: unknown }; arguments: { [key: string]: unknown }; answer?: unknown; checked?: { against: string; members?: string[]; issues: { message: string; fix: string; path?: string; [key: string]: unknown }[]; [key: string]: unknown }[]; error?: { detail: string; fix: string; [key: string]: unknown }; unavailable?: true; [key: string]: unknown }[]; [key: string]: unknown }): { calls?: { plugin: string; binding: { service: string; method: string }; arguments: { [key: string]: unknown }; checks: { against: string; members?: string[] }[] }[]; done?: true };
  render(argument: { descriptions: { id: string; [key: string]: unknown }[]; screen: { plugin: string; kind: "view" | "settings" | "action"; id?: string; [key: string]: unknown }; answers: { plugin: string; binding: { service: string; method: string; [key: string]: unknown }; arguments: { [key: string]: unknown }; answer?: unknown; checked?: { against: string; members?: string[]; issues: { message: string; fix: string; path?: string; [key: string]: unknown }[]; [key: string]: unknown }[]; error?: { detail: string; fix: string; [key: string]: unknown }; unavailable?: true; [key: string]: unknown }[]; [key: string]: unknown }): { plugin: string; kind: "view" | "settings"; view?: string; title?: string; nodes: ({ id: string; component: string; parent?: string; state: "ready" | "error" | "unavailable"; data?: unknown; error?: { detail: string; fix: string; path?: string }; props: { [key: string]: unknown } })[] };
  pluginList(argument: { installed: { id: string; [key: string]: unknown }[]; detected: { id: string; [key: string]: unknown }[]; available: { id: string; [key: string]: unknown }[]; [key: string]: unknown }): { kind: "host"; title: string; nodes: ({ id: string; component: "table"; state: "ready"; data: { items: ({ id: string; state: "installed" | "detected" | "available"; unavailable?: true; install?: true; [key: string]: unknown })[] }; props: { [key: string]: unknown } })[] };
}

export const Ui: ServiceType<UiService> = { id: "ui" };
