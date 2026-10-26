import type { PluginPaths } from "./model.js";

/**
 * An app's own npm-plugin mechanism.
 *
 * @remarks
 * Absent on the descriptor means the app has none, so a consumer offers no npm rows, no
 * npm section and no npm install method rather than offering ones that cannot work.
 */
export interface AppNpmPlugins {
  /** Config files to look in, in order, for the plugin list. */
  configFiles: string[];
  packageCache?: string;
  pluginsKey: string;
  schemaUrl?: string;
}

/**
 * How an app runs a plugin at startup when it has no npm-plugin list of its own.
 *
 * @remarks
 * Data, not code, so an app declaring neither this nor an npm mechanism auto-loads
 * nothing rather than being special-cased by a host.
 */
export interface AppStartupHook {
  /** A JSON template whose strings have the `{plugin}` placeholder replaced with the plugin's name. */
  entry: unknown;
  /** The file to write, relative to the app home. */
  file: string;
  /** The key path to the array the entry joins. */
  path: string[];
}

/**
 * One app a host loads plugins into, as a reader resolves it: its declaration with every default filled in.
 *
 * @remarks
 * Everything here is data a consumer reads, never behaviour: an app is added by declaring
 * it and nothing else learns its name.
 */
export interface AppDescriptor {
  /**
   * Accent colour for this app's surfaces, as a `#rrggbb` hex string.
   *
   * @remarks
   * Presentation data beside `icon`. Absent means a consumer uses its own neutral
   * default rather than inventing one per app.
   */
  accent?: string;
  /** The subdirectory inside the app home holding its slash commands. */
  commandsSubdir: string;
  detect: AppDetect;
  discovery?: AppDiscovery;
  home: AppHome;
  /** Self-contained SVG mark for the app, rendered by dashboards. Data, not code. */
  icon?: string;
  id: string;
  integration: "env-baseurl" | "native";
  label: string;
  /** The plugin this app is reached through. Absent means the app has no loader. */
  loader?: AppLoader;
  /** The app config file a model catalog is merged into. */
  modelCatalog?: AppModelCatalog;
  /** This app's own npm-plugin mechanism. Absent means it has none. */
  npmPlugins?: AppNpmPlugins;
  /**
   * The names of the storage subdirectories inside this app's home.
   *
   * @remarks
   * Optional because a declaration rarely states them: a reader resolves each name from
   * the declaration, then an environment override, then the ecosystem default.
   */
  paths?: AppPathNames;
  projects?: AppProjects;
  /** The port this app's proxy listens on, or 0 when it needs none. */
  proxyPort: number;
  startupHook?: AppStartupHook;
  /** Session-storage formats this app writes, for usage readers. Absent means no usage data. */
  usage?: AppUsage;
  /** The wire format this app speaks, for example `anthropic`. */
  wireFormat: string;
  /**
   * The command a user types to launch this app through its loader's wrapper.
   *
   * @remarks
   * Absent means the app is launched by its own binary, so nothing writes a wrapper.
   */
  wrapperCommand?: string;
}

/**
 * One app home the host knows about.
 *
 * @remarks
 * A plugin whose job spans more than its own home takes them from the host rather than
 * resolving a registry itself, which is what keeps it from linking the library that owns the
 * registry's shape.
 */
export interface HomeDescriptor {
  app: string;
  label: string;
  /** The id of the plugin this app is reached through, absent when it has none. */
  loader?: string;
  paths: PluginPaths;
  /** Whether this home exists on disk. An absent home means that app is not installed. */
  present: boolean;
}

/**
 * The app config file a model catalog is merged into.
 *
 * @remarks
 * Absent on the descriptor means nothing is merged and a consumer reads its own model
 * cache directly.
 */
export interface AppModelCatalog {
  /** Environment variable naming the config file outright. */
  envOverride?: string;
  /** Files to try in order, relative to the app home. */
  files: string[];
  /**
   * The key inside that file holding the catalog.
   *
   * @remarks
   * Named after the app's OWN config key, which is data this package quotes rather than
   * a category it serves: it never reads what the key contains.
   */
  providerKey: string;
  schemaUrl?: string;
}

/**
 * The names of the four storage subdirectories inside an app home.
 *
 * @remarks
 * Names rather than paths: an app whose layout differs, or a user who wants its storage
 * elsewhere, changes these rather than any consumer. A consumer resolves them into absolute paths
 * rather than joining the literal names.
 */
export interface AppPathNames {
  cache: string;
  config: string;
  plugin: string;
  repos: string;
}

/**
 * The plugin that connects an app to the local API.
 *
 * @remarks
 * Data, not code: a host reads this to install and track the app's loader, so an app whose
 * loader is renamed or rehosted needs no consumer change.
 */
export interface AppLoader {
  id: string;
  /** Where the loader is cloned from, as `owner/repo` or a full URL. */
  url: string;
}

/**
 * Where a marketplace looks for an app's community plugins.
 *
 * @remarks
 * Absent on the descriptor means a consumer offers only its own verified list.
 */
export interface AppDiscovery {
  /** A curated list to read, as a raw URL. */
  awesomeList?: string;
  /** A free-text search to run where the topic alone under-reports. */
  searchQuery?: string;
  topic?: string;
}

/**
 * Where an app records the projects a user has worked in.
 *
 * @remarks
 * Absent on the descriptor means no project history, rather than a consumer guessing at a
 * location.
 */
export interface AppProjects {
  historyFile?: string;
  /** The file the app writes inside a project's git directory to record the project id. */
  markerFile?: string;
  /** Session databases to try in order, absolute or relative to the app home. */
  sessionDb?: string[];
}

/**
 * Which catalog entries a contributed category holds.
 *
 * @remarks
 * A match, never a list of entries, which is what keeps a category dynamic: something
 * published tomorrow carrying the topic appears with no change to the plugin that declared the
 * category, and no plugin code runs when the catalog is read.
 */
export interface MarketplaceMatch {
  /** The catalog kind an entry must be, as the reading host names its kinds. */
  kind?: string;
  topics?: string[];
}

/** How the repo is published, to npm and as Java release assets. */
export interface ManifestPublish {
  /** The README is rendered at build time, so the release promotes it rather than testing it. */
  generatedReadme?: boolean;
  /**
   * The Gradle modules whose jars ship as release assets, each named by its own classifier.
   *
   * @remarks
   * A list rather than one name because a consumer resolves each module separately: they
   * serve different Gradle configurations, and one shaded jar would put every module on every
   * consumer's runtime classpath.
   */
  jarModule?: string[];
  /** Run the Gradle build before the tests, because a test needs its jar installed first. */
  jarPretest?: boolean;
  /** Publish only as `@intisy-ai/<name>`, because the unscoped name is unavailable. */
  scopedOnly?: boolean;
}

/** How to tell whether an app is installed. */
export interface AppDetect {
  /** The executable a user launches, looked up on the path. */
  binary: string;
  /** The npm package the app ships as, for a global-install check. */
  pkg: string;
}

/** One category a plugin adds to a host's catalog of installable things. */
export interface MarketplaceCategory {
  /** The category's id, unique across every plugin declaring one. */
  id: string;
  /** The name a surface shows. Absent means the id is shown. */
  label?: string;
  match: MarketplaceMatch;
}

/** Repository metadata, from which the GitHub description and topic set are derived. */
export interface RepoMeta {
  /** The single category topic, for example `core-library` or `dashboard`. */
  category: string;
  /** Domain topics, for example `claude` or `gemini`. */
  domains?: string[];
  /** The role phrase, capitalized, without the fixed ecosystem suffix. */
  role: string;
  /**
   * The tech topics, for example `typescript`, `java` or `svelte`.
   *
   * @remarks
   * A list rather than one primary topic, because a repo carrying a Java engine behind a
   * TypeScript package is both and describing it as either is wrong.
   */
  tech: string[];
  /** Topics this repo needs that no other rule derives, for example `github-actions`. */
  topics?: string[];
}

/** The session-storage formats an app writes, for a usage reader. */
export interface AppUsage {
  /** Format ids, each of which a consumer maps to a parser of its own. */
  formats: string[];
}

export interface ManifestMarketplace {
  categories: MarketplaceCategory[];
}

/** Where an app keeps its home directory, in the order a resolver tries. */
export interface AppHome {
  /** Paths to try in order, each with a leading `~` for the user home. */
  candidates: string[];
  /** Environment variable that overrides every candidate, set by a host driving this app. */
  envOverride?: string;
  /** The app's OWN environment variable for its config directory, which it reads itself. */
  nativeEnv?: string;
  /** Subdirectory under the XDG config directory, when the app follows that layout. */
  xdgSubdir?: string;
}
