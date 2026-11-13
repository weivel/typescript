import { join } from "node:path";
import koffi from "koffi";
import { describe, expect, it } from "vitest";
import { sharedLibraryFileName } from "../src/core/library-file.ts";

const nativeDirectory = join(import.meta.dirname, "..", "native");
const WEIVEL_STATUS_OK = 0;
const coreHandle = koffi.pointer(koffi.opaque("weivel_core"));

function loadNativeLibrary(name: string): koffi.IKoffiLib {
  return koffi.load(join(nativeDirectory, sharedLibraryFileName(name)));
}

describe("the native libraries built from the pinned siblings", () => {
  it("create and destroy a core with default options", () => {
    const core = loadNativeLibrary("weivel_core");
    const create = core.func("weivel_core_create", "int", ["void *", koffi.out(koffi.pointer(coreHandle)), "uint32_t *"]);
    const destroy = core.func("weivel_core_destroy", "int", [coreHandle]);
    const created: unknown[] = [null];

    expect(create(null, created, null)).toBe(WEIVEL_STATUS_OK);
    expect(created[0]).not.toBeNull();
    expect(destroy(created[0])).toBe(WEIVEL_STATUS_OK);
  });

  it("answer the standard's config service id from the standard beside the core", () => {
    const standard = loadNativeLibrary("weivel_standard");
    const configServiceId = standard.func("weivel_standard_service_config", "str", []);

    expect(configServiceId()).toBe("weivel.config");
  });
});
