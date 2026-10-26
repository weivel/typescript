import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { isPluginError } from "../../engine/index.js";
import type { PluginRuntime } from "../../engine/index.js";
import type { Plugin, PluginContext, PluginError, PluginManifest } from "../../index.js";
import { ECHO_PIN } from "../__fixtures__/echo-pin.js";
import { startPlugins } from "../plugin-host.js";
import { jsonOf } from "./bridge.js";
import { acquireLibrary, currentPlatformKey, openLibrary, parseDeclaration } from "./index.js";
import type { LibraryDeclaration, LibraryPin } from "./index.js";

const NETWORK_TIMEOUT_MS = 60000;

type EchoService = Record<"echo" | "fail" | "repeat" | "garbage", (argument: unknown) => unknown>;

function freshCache(): string {
  return mkdtempSync(join(tmpdir(), "weivel-library-"));
}

function runtime(): PluginRuntime {
  return {
    config: { all: () => ({}), get: () => undefined, set: async () => {} },
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    paths: { home: "/home", repos: "/home/repos", plugin: "/home/plugin", cache: "/home/cache", config: "/home/config" },
    events: { publish: () => {}, subscribe: () => () => {} },
  };
}

function manifest(id: string, extra: Partial<PluginManifest> = {}): PluginManifest {
  return { id, api: 1, entry: "dist/index.js", capabilities: [], ...extra };
}

function scanOf(...plugins: Array<{ manifest: PluginManifest; module: unknown }>) {
  return {
    loaded: plugins.map((plugin) => ({ manifest: plugin.manifest, manifestPath: `/home/plugin/${plugin.manifest.id}.json`, entryPath: `/home/plugin/${plugin.manifest.id}.js` })),
    failed: [],
    modules: new Map(plugins.map((plugin) => [`/home/plugin/${plugin.manifest.id}.js`, plugin.module])),
  };
}

function echoConsumer(seen: { echo?: EchoService }): { manifest: PluginManifest; module: { default: Plugin } } {
  return {
    manifest: manifest("consumer", { services: { consumes: [{ id: "echo", optional: false }] } }),
    module: {
      default: {
        activate: (ctx: PluginContext) => { seen.echo = ctx.services.get(ctx.service("echo")) as EchoService; },
        deactivate: () => {},
      },
    },
  };
}

function bystander(): { manifest: PluginManifest; module: { default: Plugin } } {
  return { manifest: manifest("bystander"), module: { default: { activate: () => {}, deactivate: () => {} } } };
}

async function startWith(libraries: readonly LibraryPin[], libraryCache: string, ...plugins: Array<{ manifest: PluginManifest; module: unknown }>) {
  return startWithServices([], libraries, libraryCache, ...plugins);
}

async function startWithServices(
  services: ReadonlyArray<{ id: string; implementation: unknown }>,
  libraries: readonly LibraryPin[],
  libraryCache: string,
  ...plugins: Array<{ manifest: PluginManifest; module: unknown }>
) {
  const scan = scanOf(...plugins);
  return startPlugins({
    app: "test",
    pluginDir: "/home/plugin",
    runtimeFor: () => runtime(),
    scan,
    importEntry: async (entryPath: string) => scan.modules.get(entryPath),
    services,
    libraries,
    libraryCache,
  });
}

function permissionDenied(): Error {
  return Object.assign(new Error("EPERM: operation not permitted, rename"), { code: "EPERM" });
}

function refusalOf(work: () => unknown): PluginError {
  try {
    work();
  } catch (error) {
    if (isPluginError(error)) return error;
    throw error;
  }
  throw new Error("expected a refusal, and the call returned");
}

async function rejectionOf(work: Promise<unknown>): Promise<PluginError> {
  try {
    await work;
  } catch (error) {
    if (isPluginError(error)) return error;
    throw error;
  }
  throw new Error("expected a refusal, and the work resolved");
}

function countingFetch(): { fetchImpl: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    urls.push(String(input));
    return fetch(input, init);
  }) as typeof fetch;
  return { fetchImpl, urls };
}

function withDigit(digest: string): string {
  return `${digest[0] === "0" ? "1" : "0"}${digest.slice(1)}`;
}

const BYTE_ORDER_MARK = Uint8Array.of(0xef, 0xbb, 0xbf);

const neverAnswers = (() => new Promise<Response>(() => {})) as typeof fetch;

function withByteOrderMark(bytes: Uint8Array): Uint8Array {
  return Uint8Array.from([...BYTE_ORDER_MARK, ...bytes]);
}

/** Puts a release's assets where the cache keeps them and pins exactly these declaration bytes, so nothing is downloaded. */
function stageRelease(cache: string, binaryPath: string, declarationBytes: Uint8Array): LibraryPin {
  const directory = join(cache, ...ECHO_PIN.repository.split("/"), ECHO_PIN.tag);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "library.json"), declarationBytes);
  copyFileSync(binaryPath, join(directory, basename(binaryPath)));
  const declarationDigest = createHash("sha256").update(declarationBytes).digest("hex");
  return { ...ECHO_PIN, sha256: { ...ECHO_PIN.sha256, "library.json": declarationDigest } };
}

function withMirrorService(declarationText: string): Uint8Array {
  const declared = JSON.parse(declarationText) as LibraryDeclaration;
  const [echoService] = declared.services;
  return new TextEncoder().encode(JSON.stringify({ ...declared, services: [echoService, { ...echoService, id: "mirror" }] }));
}

function mirrorConsumer(seen: { mirror?: unknown }): { manifest: PluginManifest; module: { default: Plugin } } {
  return {
    manifest: manifest("mirror-consumer", { services: { consumes: [{ id: "mirror", optional: false }] } }),
    module: {
      default: {
        activate: (ctx: PluginContext) => { seen.mirror = ctx.services.get(ctx.service("mirror")); },
        deactivate: () => {},
      },
    },
  };
}

function withoutPlatform(pin: LibraryPin, platformKey: string): LibraryPin {
  const sha256 = Object.fromEntries(Object.entries(pin.sha256).filter(([key]) => key !== platformKey));
  return { ...pin, sha256 };
}

describe("a C library", () => {
  let echo: EchoService;
  let binaryPath: string;
  let declaration: LibraryDeclaration;

  beforeAll(async () => {
    const seen: { echo?: EchoService } = {};
    const cache = freshCache();
    const loaded = await startWith([ECHO_PIN], cache, echoConsumer(seen));
    expect(loaded.quarantined).toEqual([]);
    expect(loaded.started).toEqual(["consumer"]);
    echo = seen.echo as EchoService;
    ({ binaryPath, declaration } = await acquireLibrary(ECHO_PIN, cache));
  }, NETWORK_TIMEOUT_MS);

  it("offers each declared function as a method of its service", () => {
    expect(echo.echo({ a: [1, 2] })).toEqual({ a: [1, 2] });
  });

  it("raises a library failure as a refusal carrying its fix", () => {
    const refusal = refusalOf(() => echo.fail({}));
    expect(refusal.fix).toBe("call echo instead");
    expect(refusal.detail).toContain("echo refused on purpose");
  });

  it("returns a one-mebibyte result intact", () => {
    const result = echo.repeat({ count: 1048576 }) as string;
    expect(result.length).toBe(1048576);
  });

  it("refuses invalid UTF-8 from a library as a refusal, not a parser error", () => {
    const refusal = refusalOf(() => echo.garbage({}));
    expect(refusal.pluginId).toBe("echo");
    expect(refusal.detail).toContain("garbage");
  });

  it("refuses a binary whose digest differs from its pin", async () => {
    const cache = freshCache();
    const platformKey = currentPlatformKey();
    const pin = { ...ECHO_PIN, sha256: { ...ECHO_PIN.sha256, [platformKey]: withDigit(ECHO_PIN.sha256[platformKey]) } };

    const refusal = await rejectionOf(acquireLibrary(pin, cache));

    expect(refusal.detail).toContain("SHA-256");
    expect(readdirSync(cache, { recursive: true }).map(String).filter((entry) => /\.(dll|so|dylib|tmp)$/.test(entry))).toEqual([]);
  }, NETWORK_TIMEOUT_MS);

  it("re-verifies a cached file instead of trusting it", async () => {
    const cache = freshCache();
    const first = await acquireLibrary(ECHO_PIN, cache);
    writeFileSync(first.binaryPath, "not the library");
    const { fetchImpl, urls } = countingFetch();

    const second = await acquireLibrary(ECHO_PIN, cache, fetchImpl);
    const library = openLibrary(second.binaryPath, second.declaration);

    expect(urls.filter((url) => url.endsWith(".dll") || url.endsWith(".so"))).toHaveLength(1);
    expect(urls.filter((url) => url.endsWith("library.json"))).toEqual([]);
    expect(library.call("echo_echo", { again: true })).toEqual({ again: true });
    library.close();
  }, NETWORK_TIMEOUT_MS);

  it("refuses a library with no binary for this platform and still starts the rest", async () => {
    const platformKey = currentPlatformKey();
    const seen: { echo?: EchoService } = {};

    const loaded = await startWith([withoutPlatform(ECHO_PIN, platformKey)], freshCache(), echoConsumer(seen), bystander());

    expect(loaded.started).toEqual(["bystander"]);
    const [libraryRefusal, consumerRefusal] = loaded.quarantined;
    expect(libraryRefusal.detail).toContain(platformKey);
    expect(consumerRefusal.pluginId).toBe("consumer");
    expect(seen.echo).toBeUndefined();
    await loaded.stop();
  }, NETWORK_TIMEOUT_MS);

  it("names the platform when neither the pin nor the release carries it", async () => {
    const refusal = await rejectionOf(acquireLibrary(ECHO_PIN, freshCache(), fetch, "darwin-arm64"));
    expect(refusal.detail).toContain("darwin-arm64");
  }, NETWORK_TIMEOUT_MS);

  it("keeps the embedder's own service when a library offers the same id, refusing the library's copy", async () => {
    const seen: { echo?: EchoService } = {};
    const embedderEcho = { echo: () => "the embedder's" };

    const loaded = await startWithServices([{ id: "echo", implementation: embedderEcho }], [ECHO_PIN], freshCache(), echoConsumer(seen));

    expect(loaded.started).toEqual(["consumer"]);
    expect(seen.echo?.echo({})).toBe("the embedder's");
    const [refusal] = loaded.quarantined;
    expect(refusal.pluginId).toBe("echo");
    expect(refusal.detail).toContain("the embedding host");
    expect(refusal.detail).toContain("weivel/bindings@v0.1.1");
    await loaded.stop();
  }, NETWORK_TIMEOUT_MS);

  it("refuses the second library's copy of a service id the first library already offers", async () => {
    const seen: { echo?: EchoService } = {};

    const loaded = await startWith([ECHO_PIN, ECHO_PIN], freshCache(), echoConsumer(seen));

    expect(loaded.started).toEqual(["consumer"]);
    expect(loaded.quarantined).toHaveLength(1);
    expect(loaded.quarantined[0].detail).toMatch(/both library echo \(weivel\/bindings@v0\.1\.1\) and library echo/);
    expect(seen.echo?.echo({ still: "served" })).toEqual({ still: "served" });
    await loaded.stop();
  }, NETWORK_TIMEOUT_MS);

  it("offers none of a library's services when one of them collides", async () => {
    const cache = freshCache();
    const pin = stageRelease(cache, binaryPath, withMirrorService(readFileSync(join(binaryPath, "..", "library.json"), "utf8")));
    const seen: { mirror?: unknown } = {};

    const loaded = await startWithServices([{ id: "echo", implementation: { echo: () => "the embedder's" } }], [pin], cache, mirrorConsumer(seen));

    expect(loaded.started).toEqual([]);
    expect(seen.mirror).toBeUndefined();
    const [libraryRefusal, consumerRefusal] = loaded.quarantined;
    expect(libraryRefusal.pluginId).toBe("echo");
    expect(libraryRefusal.detail).toContain("both the embedding host and library echo (weivel/bindings@v0.1.1)");
    expect(consumerRefusal.pluginId).toBe("mirror-consumer");
    await loaded.stop();
  });

  it("refuses a library.json that starts with a byte order mark as not JSON", async () => {
    const cache = freshCache();
    const pin = stageRelease(cache, binaryPath, withByteOrderMark(readFileSync(join(binaryPath, "..", "library.json"))));

    const refusal = await rejectionOf(acquireLibrary(pin, cache, neverAnswers));

    expect(refusal.detail).toContain("library.json is not JSON");
  });

  it("accepts a cached file another host renamed into place first, when it matches the pin", async () => {
    const cache = freshCache();
    const rename = async (_from: string, to: string) => {
      if (to.endsWith(".dll") || to.endsWith(".so")) copyFileSync(binaryPath, to);
      else writeFileSync(to, readFileSync(join(binaryPath, "..", "library.json")));
      throw permissionDenied();
    };

    const acquired = await acquireLibrary(ECHO_PIN, cache, fetch, currentPlatformKey(), { rename });
    const library = openLibrary(acquired.binaryPath, acquired.declaration);

    expect(library.call("echo_echo", { raced: true })).toEqual({ raced: true });
    library.close();
  }, NETWORK_TIMEOUT_MS);

  it("refuses an asset it could not rename into place when nothing valid is there", async () => {
    const rename = async () => { throw permissionDenied(); };

    const refusal = await rejectionOf(acquireLibrary(ECHO_PIN, freshCache(), fetch, currentPlatformKey(), { rename }));

    expect(refusal.detail).toContain("EPERM");
  }, NETWORK_TIMEOUT_MS);

  it("refuses at load a declared symbol the binary does not export", () => {
    const [service] = declaration.services;
    const missing = { ...service.functions[0], name: "missing", symbol: "echo_missing" };
    const declaring = { ...declaration, services: [{ ...service, functions: [...service.functions, missing] }] };

    const refusal = refusalOf(() => openLibrary(binaryPath, declaring));

    expect(refusal.detail).toContain("echo_missing");
  });

  it("releases every result exactly once", () => {
    let releases = 0;
    const library = openLibrary(binaryPath, declaration, {
      wrapRelease: (release) => (pointer) => { releases++; release(pointer); },
    });
    const symbols = ["echo_echo", "echo_fail", "echo_garbage", "echo_repeat"];
    for (let call = 0; call < 100; call++) {
      const symbol = symbols[call % symbols.length];
      try {
        library.call(symbol, symbol === "echo_repeat" ? { count: 3 } : {});
      } catch (error) {
        if (!isPluginError(error)) throw error;
      }
    }
    library.close();
    expect(releases).toBe(100);
  });

  it("refuses a closed library rather than calling into unloaded code", () => {
    const library = openLibrary(binaryPath, declaration);
    library.close();
    expect(refusalOf(() => library.call("echo_echo", {})).detail).toContain("closed");
  });
});

describe("acquireLibrary", () => {
  it("refuses a download that does not finish within its deadline, naming the URL", async () => {
    const refusal = await rejectionOf(acquireLibrary(ECHO_PIN, freshCache(), neverAnswers, currentPlatformKey(), { downloadDeadlineMs: 50 }));

    expect(refusal.detail).toContain("https://github.com/weivel/bindings/releases/download/v0.1.1/library.json did not finish within 50 ms");
  });

  it("refuses a platform key that is not <os>-<arch> in lowercase letters and digits", async () => {
    for (const platformKey of ["../../x", "Win32-x64", "linux", "linux-x64-musl", ""]) {
      const refusal = await rejectionOf(acquireLibrary(ECHO_PIN, freshCache(), neverAnswers, platformKey));
      expect(refusal.detail, platformKey).toContain(`a platform key is <os>-<arch> as Node spells them, for example linux-x64, not ${platformKey}`);
    }
  });
});

describe("a library's answer", () => {
  it("is refused as not JSON when it starts with a byte order mark", () => {
    const refusal = refusalOf(() => jsonOf("echo", "echo.echo", withByteOrderMark(new TextEncoder().encode("{}"))));
    expect(refusal.detail).toBe("echo.echo answered text that is not JSON");
  });
});

describe("parseDeclaration", () => {
  it("names each schema violation in the refusal's detail", () => {
    const refusal = refusalOf(() => parseDeclaration(JSON.stringify({ id: "Echo", version: "", binary: "echo", release: "echo_release", services: [] })));
    expect(refusal.detail).toContain("id");
    expect(refusal.detail).toContain("version");
    expect(refusal.detail).toContain("services");
  });

  it("refuses text that is not JSON", () => {
    expect(refusalOf(() => parseDeclaration("{")).detail).toContain("library.json");
  });
});
