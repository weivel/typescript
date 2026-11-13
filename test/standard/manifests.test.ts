import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Choice, Status } from "../../src/core/index.ts";
import { IdentityKind, StandardRefusalCode, identifiedManifest } from "../../src/standard/index.ts";
import { createRecordedCore } from "../real-core.ts";
import { directoryWith, realStandard } from "../real-standard.ts";

const standard = realStandard();

const fullManifest = {
  importName: "clock",
  api: 2,
  entry: "clock.js",
  targets: ["node"],
  capabilities: { provides: ["clock.tick"], consumes: ["clock.tock"] },
  services: {
    provides: ["clock:now", { id: "clock:zone", attributes: { latency: 3.5 } }],
    consumes: ["calendar:day", { id: "calendar:week", provider: "forge:42", degradable: true, constraints: { latency: 9 } }],
  },
  permissions: ["time"],
};

function manifestText(importName: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ importName, api: 1, ...extra });
}

function identityText(id: string, name: string): string {
  return JSON.stringify({ id, name });
}

describe("loading a manifest", () => {
  it("answers every field the standard read, and no identity, since a manifest never carries its own", () => {
    const loaded = standard.loadManifest(JSON.stringify(fullManifest));

    expect(loaded.status).toBe(Status.Ok);
    expect(loaded.refusal).toBeUndefined();
    expect(loaded.paths).toEqual([]);
    expect(loaded.value).toEqual({
      importName: "clock",
      api: 2,
      entry: "clock.js",
      targets: ["node"],
      capabilities: { provides: ["clock.tick"], consumes: ["clock.tock"] },
      services: {
        provides: [
          { id: "clock:now", attributes: [] },
          { id: "clock:zone", attributes: [{ name: "latency", value: 3.5 }] },
        ],
        consumes: [
          { id: "calendar:day", provider: undefined, optional: Choice.Default, degradable: Choice.Default, constraints: [] },
          {
            id: "calendar:week",
            provider: "forge:42",
            optional: Choice.Default,
            degradable: Choice.Yes,
            constraints: [{ name: "latency", value: 9 }],
          },
        ],
      },
      permissions: ["time"],
      identity: undefined,
    });
  });

  it("validates before it reads, refusing what the reader alone would convert", () => {
    const loaded = standard.loadManifest(manifestText("Not An Import Name"));

    expect(loaded.status).toBe(Status.Refused);
    expect(loaded.value).toBeUndefined();
    expect(loaded.refusal?.code).toBe(StandardRefusalCode.InvalidValue);
    expect(loaded.refusal?.path).toBe("importName");
  });

  it("keeps the standard's path for a key that is not plain, bracket-quoted, and names every wrong field in order", () => {
    const loaded = standard.loadManifest(
      manifestText("clock", { services: { provides: [{ id: "clock:now", attributes: { "a.b": "fast" } }] }, targets: 7 }),
    );

    expect(loaded.status).toBe(Status.Refused);
    expect(loaded.refusal).toMatchObject({ code: StandardRefusalCode.WrongType, path: loaded.paths[0] });
    expect(loaded.paths).toEqual(["targets", 'services.provides[0].attributes["a.b"]']);
  });

  it("answers a refusal whose path bracket-quotes a key that is not plain, exactly as the standard wrote it", () => {
    const loaded = standard.loadManifest(
      manifestText("clock", { services: { provides: [{ id: "clock:now", attributes: { "a.b": "fast" } }] } }),
    );

    expect(loaded.refusal?.path).toBe('services.provides[0].attributes["a.b"]');
  });

  it("applies rule V2 only for a host that names its well-known services", () => {
    const text = manifestText("clock", { services: { provides: ["now"] } });

    expect(standard.loadManifest(text).status).toBe(Status.Ok);
    expect(standard.loadManifest(text, { wellKnownServices: ["now"] }).status).toBe(Status.Ok);
    const refused = standard.loadManifest(text, { wellKnownServices: [] });
    expect(refused.status).toBe(Status.Refused);
    expect(refused.refusal).toMatchObject({ code: StandardRefusalCode.NotWellKnown, path: "services.provides[0]" });
  });

  it("answers a manifest the real core registers", () => {
    const { core } = createRecordedCore();
    const loaded = standard.loadManifest(JSON.stringify(fullManifest));

    const registered = core.registerManifest(loaded.value!);

    expect(registered.status).toBe(Status.Ok);
    expect(core.ledgerEntry(registered.value!).value).toMatchObject({
      importName: "clock",
      capabilitiesDeclared: ["clock.tick"],
    });
  });
});

describe("discovering a directory", () => {
  function laidOutDirectory(): string {
    return directoryWith({
      "ten.json": manifestText("ten", { entry: "ten.js" }),
      "ten.js": "",
      "ten_identity.json": identityText("forge:10", "ten-repository"),
      "nine.json": manifestText("nine", { entry: "missing.js" }),
      "nine_identity.json": identityText("forge:9/tools", "nine-repository"),
      "alone.json": manifestText("alone"),
      "broken.json": "{",
      "misnamed.json": manifestText("other"),
      "notes.txt": "not a manifest",
    });
  }

  it("answers plugins in the standard's identity order, every path exactly as the standard joined it", () => {
    const directory = laidOutDirectory();

    const discovered = standard.discover(directory);

    expect(discovered.status).toBe(Status.Ok);
    expect(discovered.value!.plugins.map((plugin) => plugin.manifest.importName)).toEqual(["nine", "ten", "alone"]);
    const [nine, ten, alone] = discovered.value!.plugins;
    expect(nine).toMatchObject({
      manifestPath: `${directory}/nine.json`,
      identityPath: `${directory}/nine_identity.json`,
      identityId: "forge:9/tools",
      repositoryName: "nine-repository",
      identity: { kind: IdentityKind.Forge, forge: "forge", host: null, number: 9n, segments: ["tools"] },
      entryPath: `${directory}/missing.js`,
      entryPresent: false,
    });
    expect(ten).toMatchObject({ identityId: "forge:10", entryPath: `${directory}/ten.js`, entryPresent: true });
    expect(alone).toMatchObject({ identityPath: null, identityId: null, identity: null, entryPath: null });
  });

  it("answers every file it could not take a plugin from, in file name order, with the standard's refusal", () => {
    const directory = laidOutDirectory();

    const failures = standard.discover(directory).value!.failures;

    expect(failures.map((failure) => [failure.file, failure.refusal.code])).toEqual([
      [`${directory}/broken.json`, StandardRefusalCode.MalformedJson],
      [`${directory}/misnamed.json`, StandardRefusalCode.NameMismatch],
    ]);
  });

  it("sets the identity file's id on a copy of the manifest, leaving the discovered manifest as the standard answered it", () => {
    const { core } = createRecordedCore();
    const nine = standard.discover(laidOutDirectory()).value!.plugins[0]!;

    const manifest = identifiedManifest(nine);
    const registered = core.registerManifest(manifest);

    expect(manifest.identity).toBe("forge:9/tools");
    expect(nine.manifest.identity).toBeUndefined();
    expect(core.ledgerEntry(registered.value!).value?.identity).toBe("forge:9/tools");
  });

  it("passes the host's well-known services to every manifest it loads", () => {
    const directory = directoryWith({ "clock.json": manifestText("clock", { services: { provides: ["now"] } }) });

    const discovered = standard.discover(directory, { wellKnownServices: [] });

    expect(discovered.value!.plugins).toEqual([]);
    expect(discovered.value!.failures[0]!.refusal).toMatchObject({
      code: StandardRefusalCode.NotWellKnown,
      path: "services.provides[0]",
    });
  });

  it("refuses a directory that does not exist, as the standard does", () => {
    const missing = join(directoryWith(), "absent");

    const discovered = standard.discover(missing);

    expect(discovered.status).toBe(Status.Refused);
    expect(discovered.value).toBeUndefined();
    expect(discovered.refusal?.code).toBe(StandardRefusalCode.NotFound);
  });
});
