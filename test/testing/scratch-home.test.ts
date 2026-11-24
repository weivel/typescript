import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { freePort, scratchHome, type ScratchFile, type ScratchLayout } from "../../src/testing/index.ts";

const SET_VARIABLE = "WEIVEL_SCRATCH_TEST_SET";
const UNSET_VARIABLE = "WEIVEL_SCRATCH_TEST_UNSET";

const sources: string[] = [];

function librarySource(files: Record<string, string>): string {
  const directory = mkdtempSync(join(tmpdir(), "scratch-source-"));
  sources.push(directory);
  for (const [name, content] of Object.entries(files)) writeFileSync(join(directory, name), content);
  return directory;
}

function layoutOf(overrides: Partial<ScratchLayout> = {}): ScratchLayout {
  return {
    prefix: "scratch-test-",
    libraries: {},
    environment: (base) => ({ [SET_VARIABLE]: join(base, "set"), [UNSET_VARIABLE]: join(base, "unset") }),
    files: () => [],
    ...overrides,
  };
}

afterEach(() => {
  delete process.env[SET_VARIABLE];
  delete process.env[UNSET_VARIABLE];
  for (const directory of sources.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("scratchHome", () => {
  it("answers a base that is a real path", () => {
    const home = scratchHome(layoutOf());
    try {
      expect(realpathSync(home.base)).toBe(home.base);
      expect(home.base).toContain("scratch-test-");
    } finally {
      home.remove();
    }
  });

  it("places a library under libraries/<name> and finds its binary beside library.json", () => {
    const source = librarySource({ "library.json": "{}", "thing.bin": "binary" });
    const home = scratchHome(layoutOf({ libraries: { thing: source } }));
    try {
      const placed = home.libraries["thing"]!;
      expect(placed.directory).toBe(join(home.base, "libraries", "thing"));
      expect(placed.binary).toBe(join(placed.directory, "thing.bin"));
      expect(readFileSync(placed.binary, "utf8")).toBe("binary");
      expect(existsSync(join(placed.directory, "library.json"))).toBe(true);
    } finally {
      home.remove();
    }
  });

  it("names the source directory when a library has no binary, and leaves nothing behind", () => {
    const source = librarySource({ "library.json": "{}" });
    process.env[SET_VARIABLE] = "before";
    expect(() => scratchHome(layoutOf({ libraries: { thing: source } }))).toThrow(source);
    expect(process.env[SET_VARIABLE]).toBe("before");
  });

  it("writes a string as it is, any other content as JSON, and a copied file byte for byte", () => {
    const source = librarySource({ "original.txt": "copied" });
    const home = scratchHome(
      layoutOf({
        files: (base): readonly ScratchFile[] => [
          { path: join(base, "deep", "text.txt"), content: "plain" },
          { path: join(base, "deep", "value.json"), content: { a: [1, 2] } },
          { path: join(base, "other", "copy.txt"), copyFrom: join(source, "original.txt") },
        ],
      }),
    );
    try {
      expect(readFileSync(join(home.base, "deep", "text.txt"), "utf8")).toBe("plain");
      expect(JSON.parse(readFileSync(join(home.base, "deep", "value.json"), "utf8"))).toEqual({ a: [1, 2] });
      expect(readFileSync(join(home.base, "other", "copy.txt"), "utf8")).toBe("copied");
    } finally {
      home.remove();
    }
  });

  it("points the environment into the home, then restores a set and an unset variable and deletes the folder", () => {
    process.env[SET_VARIABLE] = "before";
    delete process.env[UNSET_VARIABLE];
    const home = scratchHome(layoutOf());
    expect(process.env[SET_VARIABLE]).toBe(join(home.base, "set"));
    expect(process.env[UNSET_VARIABLE]).toBe(join(home.base, "unset"));
    home.remove();
    expect(process.env[SET_VARIABLE]).toBe("before");
    expect(UNSET_VARIABLE in process.env).toBe(false);
    expect(existsSync(home.base)).toBe(false);
  });

  it("leaves the environment as it was and no folder when files throws", () => {
    process.env[SET_VARIABLE] = "before";
    delete process.env[UNSET_VARIABLE];
    let seenBase = "";
    const layout = layoutOf({
      files: (base) => {
        seenBase = base;
        mkdirSync(join(base, "partial"));
        throw new Error("layout failed");
      },
    });
    expect(() => scratchHome(layout)).toThrow("layout failed");
    expect(process.env[SET_VARIABLE]).toBe("before");
    expect(UNSET_VARIABLE in process.env).toBe(false);
    expect(seenBase).not.toBe("");
    expect(existsSync(seenBase)).toBe(false);
  });
});

describe("freePort", () => {
  it("answers a port a server can then listen on", async () => {
    const port = await freePort();
    await new Promise<void>((resolveListening, reject) => {
      const server = createServer();
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => server.close(() => resolveListening()));
    });
    expect(port).toBeGreaterThan(0);
  });
});
