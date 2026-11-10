import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { libraryBinaryName } from "./library/index.js";
import { readDeployedManifests } from "./plugin-manifests.js";

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), "loader-manifests-"));
  mkdirSync(join(dir, "plugin"), { recursive: true });
  return join(dir, "plugin");
}

function write(pluginDir: string, id: string, manifest: unknown, withEntry = true): void {
  writeFileSync(join(pluginDir, `${id}.json`), JSON.stringify(manifest), "utf-8");
  if (withEntry) writeFileSync(join(pluginDir, `${id}.js`), "export default {};", "utf-8");
}

describe("readDeployedManifests", () => {
  it("returns nothing for a home with no plugin directory", () => {
    const scan = readDeployedManifests(join(tmpdir(), "loader-manifests-absent", "plugin"));
    expect(scan).toEqual({ loaded: [], failed: [] });
  });

  it("loads a valid manifest and resolves its entry beside it", () => {
    const dir = home();
    write(dir, "demo", { importName: "demo", api: 1, entry: "dist/index.js", capabilities: ["settings"] });
    const scan = readDeployedManifests(dir);
    expect(scan.failed).toEqual([]);
    expect(scan.loaded).toHaveLength(1);
    expect(scan.loaded[0].manifest.id).toBe("local:demo");
    expect(scan.loaded[0].entryPath).toBe(join(dir, "demo.js"));
  });

  it("resolves no entry for a manifest whose bundle is missing", () => {
    const dir = home();
    write(dir, "no-bundle", { importName: "no-bundle", api: 1, entry: "dist/index.js", capabilities: ["settings"] }, false);
    expect(readDeployedManifests(dir).loaded[0].entryPath).toBeNull();
  });

  it("resolves no entry for a library manifest that declares none", () => {
    const dir = home();
    writeFileSync(join(dir, "lib.json"), JSON.stringify({ importName: "lib", api: 1 }), "utf-8");
    const scan = readDeployedManifests(dir);
    expect(scan.loaded[0].entryPath).toBeNull();
    expect(scan.failed).toEqual([]);
  });

  it("reports an invalid manifest without discarding the valid ones", () => {
    const dir = home();
    write(dir, "good", { importName: "good", api: 1, entry: "dist/index.js", capabilities: ["settings"] });
    const badPath = join(dir, "bad.json");
    writeFileSync(badPath, JSON.stringify({ api: 1 }), "utf-8");
    const scan = readDeployedManifests(dir);
    expect(scan.loaded.map((plugin) => plugin.manifest.id)).toEqual(["local:good"]);
    expect(scan.failed).toHaveLength(1);
    expect(scan.failed[0].detail).toContain("importName");
    expect(scan.failed[0].detail).toContain(badPath);
  });

  it("reports unparseable JSON as a failure naming the file", () => {
    const dir = home();
    writeFileSync(join(dir, "broken.json"), "{not json", "utf-8");
    const scan = readDeployedManifests(dir);
    expect(scan.loaded).toEqual([]);
    expect(scan.failed).toHaveLength(1);
    expect(scan.failed[0].pluginId).toBe("broken");
    expect(scan.failed[0].fix).toContain("plugin.json");
  });

  it("ignores a file that is not a manifest", () => {
    const dir = home();
    write(dir, "demo", { importName: "demo", api: 1, entry: "dist/index.js", capabilities: ["settings"] });
    writeFileSync(join(dir, "notes.txt"), "hello", "utf-8");
    const scan = readDeployedManifests(dir);
    expect(scan.loaded).toHaveLength(1);
    expect(scan.failed).toEqual([]);
  });

  it("ignores the deploy directory's own package.json marker", () => {
    const dir = home();
    writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }), "utf-8");
    const scan = readDeployedManifests(dir);
    expect(scan.loaded).toEqual([]);
    expect(scan.failed).toEqual([]);
  });

  it("loads the real sidecar alongside the package.json marker with no failures", () => {
    const dir = home();
    write(dir, "demo", { importName: "demo", api: 1, entry: "dist/index.js", capabilities: ["settings"] });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }), "utf-8");
    const scan = readDeployedManifests(dir);
    expect(scan.loaded.map((plugin) => plugin.manifest.id)).toEqual(["local:demo"]);
    expect(scan.failed).toEqual([]);
  });

  it("orders the result by id so a host activates deterministically", () => {
    const dir = home();
    write(dir, "zebra", { importName: "zebra", api: 1, entry: "dist/index.js", capabilities: ["settings"] });
    write(dir, "alpha", { importName: "alpha", api: 1, entry: "dist/index.js", capabilities: ["settings"] });
    expect(readDeployedManifests(dir).loaded.map((plugin) => plugin.manifest.id)).toEqual(["local:alpha", "local:zebra"]);
  });

  it("reports a non-directory plugin path as a failure", () => {
    const dir = home();
    write(dir, "demo", { importName: "demo", api: 1, entry: "dist/index.js", capabilities: ["settings"] });
    const filePath = join(dir, "demo.js");
    const scan = readDeployedManifests(filePath);
    expect(scan.loaded).toEqual([]);
    expect(scan.failed).toHaveLength(1);
    expect(scan.failed[0].pluginId).toBe("plugin-dir");
    expect(scan.failed[0].detail).toContain(filePath);
  });

  it("reports a manifest whose import name does not match its filename", () => {
    const dir = home();
    write(dir, "demo", { importName: "different", api: 1, entry: "dist/index.js", capabilities: ["settings"] });
    const scan = readDeployedManifests(dir);
    expect(scan.loaded).toEqual([]);
    expect(scan.failed).toHaveLength(1);
    expect(scan.failed[0].pluginId).toBe("demo");
    expect(scan.failed[0].detail).toContain("different");
    expect(scan.failed[0].detail).toContain("demo");
  });

  it("loads a manifest that provides a well-known service the caller named, rather than quarantining it as squatting", () => {
    const dir = home();
    write(dir, "accounts-provider", { importName: "accounts-provider", api: 1, entry: "dist/index.js", capabilities: [], services: { provides: ["accounts"] } });
    const scan = readDeployedManifests(dir, [{ id: "accounts" }]);
    expect(scan.failed).toEqual([]);
    expect(scan.loaded.map((plugin) => plugin.manifest.id)).toEqual(["local:accounts-provider"]);
  });

  it("quarantines the same bare provide when the caller names no vocabulary", () => {
    const dir = home();
    write(dir, "accounts-provider", { importName: "accounts-provider", api: 1, entry: "dist/index.js", capabilities: [], services: { provides: ["accounts"] } });
    const scan = readDeployedManifests(dir);
    expect(scan.loaded).toEqual([]);
    expect(scan.failed).toHaveLength(1);
    expect(scan.failed[0].detail).toContain("accounts");
  });

  it("reports a mismatched import name and allows only valid ones", () => {
    const dir = home();
    write(dir, "good1", { importName: "good1", api: 1, entry: "dist/index.js", capabilities: ["settings"] });
    write(dir, "good2", { importName: "good2", api: 1, entry: "dist/index.js", capabilities: ["settings"] });
    write(dir, "bad", { importName: "wrong", api: 1, entry: "dist/index.js", capabilities: ["settings"] });
    const scan = readDeployedManifests(dir);
    expect(scan.loaded.map(p => p.manifest.id)).toEqual(["local:good1", "local:good2"]);
    expect(scan.failed).toHaveLength(1);
    expect(scan.failed[0].pluginId).toBe("bad");
    expect(scan.failed[0].detail).toContain("wrong");
    expect(scan.failed[0].detail).toContain("bad");
  });

  it("loads with the identity file's id", () => {
    const dir = home();
    write(dir, "calendar", { importName: "calendar", api: 1, entry: "dist/index.js", capabilities: [] });
    writeFileSync(join(dir, "calendar_identity.json"), JSON.stringify({ id: "github:42", name: "calendar-repo" }), "utf-8");
    const scan = readDeployedManifests(dir);
    expect(scan.failed).toEqual([]);
    expect(scan.loaded.map((plugin) => [plugin.manifest.id, plugin.manifest.name, plugin.manifest.importName])).toEqual([["github:42", "calendar-repo", "calendar"]]);
  });

  it("treats a plugin with no identity file as local", () => {
    const dir = home();
    write(dir, "calendar", { importName: "calendar", api: 1, entry: "dist/index.js", capabilities: [] });
    const [plugin] = readDeployedManifests(dir).loaded;
    expect([plugin.manifest.id, plugin.manifest.name]).toEqual(["local:calendar", "calendar"]);
  });

  it("ignores an id the manifest states for itself", () => {
    const dir = home();
    write(dir, "calendar", { importName: "calendar", id: "github:666", api: 1, entry: "dist/index.js", capabilities: [] });
    const scan = readDeployedManifests(dir);
    expect(scan.loaded.map((plugin) => plugin.manifest.id)).toEqual(["local:calendar"]);
  });

  it("refuses a malformed identity file with a fix, and does not load the plugin as local", () => {
    const dir = home();
    write(dir, "calendar", { importName: "calendar", api: 1, entry: "dist/index.js", capabilities: [] });
    const identityPath = join(dir, "calendar_identity.json");
    writeFileSync(identityPath, "{not json", "utf-8");
    const scan = readDeployedManifests(dir);
    expect(scan.loaded).toEqual([]);
    expect(scan.failed).toHaveLength(1);
    expect(scan.failed[0].pluginId).toBe("calendar");
    expect(scan.failed[0].detail).toContain(identityPath);
    expect(scan.failed[0].fix).not.toBe("");
  });

  it("refuses an identity file missing its name", () => {
    const dir = home();
    write(dir, "calendar", { importName: "calendar", api: 1, entry: "dist/index.js", capabilities: [] });
    writeFileSync(join(dir, "calendar_identity.json"), JSON.stringify({ id: "github:1" }), "utf-8");
    const scan = readDeployedManifests(dir);
    expect(scan.loaded).toEqual([]);
    expect(scan.failed[0].detail).toContain("name");
  });

  it("refuses an identity id outside the grammar", () => {
    const dir = home();
    write(dir, "calendar", { importName: "calendar", api: 1, entry: "dist/index.js", capabilities: [] });
    writeFileSync(join(dir, "calendar_identity.json"), JSON.stringify({ id: "Calendar", name: "calendar" }), "utf-8");
    const scan = readDeployedManifests(dir);
    expect(scan.loaded).toEqual([]);
    expect(scan.failed).toHaveLength(1);
    expect(scan.failed[0].detail).toContain("Calendar");
  });

  it("names the deployed file by import name even when the id has a colon", () => {
    const dir = home();
    write(dir, "calendar", { importName: "calendar", api: 1, entry: "dist/index.js", capabilities: [] });
    writeFileSync(join(dir, "calendar_identity.json"), JSON.stringify({ id: "github:7/sub", name: "calendar" }), "utf-8");
    const [plugin] = readDeployedManifests(dir).loaded;
    expect(plugin.entryPath).toBe(join(dir, "calendar.js"));
  });

  it("refuses a second plugin with the same import name, naming both files", () => {
    const dir = home();
    write(dir, "calendar", { importName: "calendar", api: 1, entry: "dist/index.js", capabilities: [] });
    write(dir, "calendar-copy", { importName: "calendar", api: 1, entry: "dist/index.js", capabilities: [] });
    const scan = readDeployedManifests(dir);
    expect(scan.loaded.map((plugin) => plugin.manifest.importName)).toEqual(["calendar"]);
    expect(scan.failed).toHaveLength(1);
    expect(scan.failed[0].detail).toContain(join(dir, "calendar.json"));
    expect(scan.failed[0].detail).toContain(join(dir, "calendar-copy.json"));
  });

  it("loads a plugin named x.identity as itself and keeps x local", () => {
    const dir = home();
    write(dir, "x", { importName: "x", api: 1, entry: "dist/index.js", capabilities: [] });
    write(dir, "x.identity", { importName: "x.identity", id: "github:666", name: "stolen", api: 1, entry: "dist/index.js", capabilities: [] });
    const scan = readDeployedManifests(dir);
    expect(scan.failed).toEqual([]);
    expect(scan.loaded.map((plugin) => [plugin.manifest.importName, plugin.manifest.id])).toEqual([
      ["x", "local:x"],
      ["x.identity", "local:x.identity"],
    ]);
  });

  it("refuses the later of two plugins with one identity id and still loads the rest", () => {
    const dir = home();
    for (const importName of ["alpha", "beta", "gamma"]) {
      write(dir, importName, { importName, api: 1, entry: "dist/index.js", capabilities: [] });
    }
    for (const importName of ["alpha", "beta"]) {
      writeFileSync(join(dir, `${importName}_identity.json`), JSON.stringify({ id: "github:1", name: importName }), "utf-8");
    }
    const scan = readDeployedManifests(dir);
    expect(scan.loaded.map((plugin) => plugin.manifest.importName)).toEqual(["alpha", "gamma"]);
    expect(scan.failed).toHaveLength(1);
    expect(scan.failed[0].pluginId).toBe("beta");
    expect(scan.failed[0].detail).toContain(join(dir, "alpha.json"));
    expect(scan.failed[0].detail).toContain(join(dir, "beta.json"));
    expect(scan.failed[0].fix).not.toBe("");
  });
});

describe("libraryBinaryName", () => {
  it("derives the binary name", () => {
    expect(libraryBinaryName("forebay-library")).toBe("forebay_library");
    expect(libraryBinaryName("forebay.library-x")).toBe("forebay_library_x");
    expect(libraryBinaryName("echo")).toBe("echo");
  });
});
