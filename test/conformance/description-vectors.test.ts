import { describe, expect, it } from "vitest";
import { readLayerVector, witnessLayerVector } from "../../src/conformance/index.ts";
import { coreLibraryPath } from "../real-core.ts";
import { standardLibraryPath } from "../real-standard.ts";
import { describedLibraryPath } from "../host/world.ts";
import { layerVectorDirectory } from "./kit.ts";

/** Builds the vector through the layer on the real core and standard and the described library, and compares every field of its `then`. */
async function witnessed(id: string): Promise<void> {
  const vector = readLayerVector(layerVectorDirectory, id);
  const seen = await witnessLayerVector(vector, { coreLibraryPath, describedLibraryPath, standardLibraryPath });

  expect(Object.keys(seen.observed)).toEqual(Object.keys(vector.then));
  expect(seen.observed).toStrictEqual(vector.then);
}

describe("description/a-checked-description-registers-the-providers-own-pointer", () => {
  it("loads both checked descriptions and serves each bound object at the address its definition symbol answered", async () => {
    await witnessed("description/a-checked-description-registers-the-providers-own-pointer");
  });
});

describe("description/a-broken-count-description-fails-the-load", () => {
  it("refuses the load as the caller's mistake once the standard's check refuses the walker, registering neither service", async () => {
    await witnessed("description/a-broken-count-description-fails-the-load");
  });
});

describe("description/a-definition-declared-without-its-description-loads-as-before", () => {
  it("serves a definition declared without a description as the provider's own pointer", async () => {
    await witnessed("description/a-definition-declared-without-its-description-loads-as-before");
  });
});

describe("description/binding/a-broken-offset-description-fails-the-load", () => {
  it("refuses the load as the caller's mistake when an offset disagrees with koffi's layout, though the check passes it", async () => {
    await witnessed("description/binding/a-broken-offset-description-fails-the-load");
  });
});

describe("description/binding/reflect-answers-every-member-kind", () => {
  it("answers a sample of every member kind back member for member, and the empty sample with every zero", async () => {
    await witnessed("description/binding/reflect-answers-every-member-kind");
  });
});

describe("description/binding/tree-answers-a-value-tree", () => {
  it("answers a value tree as a native value", async () => {
    await witnessed("description/binding/tree-answers-a-value-tree");
  });
});

describe("description/binding/find-answers-a-text-the-provider-keeps", () => {
  it("takes a text and answers the text the provider keeps", async () => {
    await witnessed("description/binding/find-answers-a-text-the-provider-keeps");
  });
});

describe("description/binding/measure-takes-bytes-and-their-length", () => {
  it("fills the length beside the bytes and answers their sum", async () => {
    await witnessed("description/binding/measure-takes-bytes-and-their-length");
  });
});

describe("description/binding/negate-takes-and-answers-a-signed-64-bit-integer", () => {
  it("takes and answers an i64 at its highest, and answers malformed for its lowest", async () => {
    await witnessed("description/binding/negate-takes-and-answers-a-signed-64-bit-integer");
  });
});

describe("description/binding/halve-takes-and-answers-a-double", () => {
  it("takes and answers an f64", async () => {
    await witnessed("description/binding/halve-takes-and-answers-a-double");
  });
});

describe("description/binding/invert-takes-and-answers-a-32-bit-flag-word", () => {
  it("takes and answers a u32 reaching its top bit", async () => {
    await witnessed("description/binding/invert-takes-and-answers-a-32-bit-flag-word");
  });
});

describe("description/binding/swap-shade-takes-and-answers-an-enum-value", () => {
  it("takes and answers an enum value as its number, and answers malformed for a number the enum does not hold", async () => {
    await witnessed("description/binding/swap-shade-takes-and-answers-an-enum-value");
  });
});

describe("description/binding/grow-takes-and-answers-a-size", () => {
  it("takes and answers a size beyond 2^53", async () => {
    await witnessed("description/binding/grow-takes-and-answers-a-size");
  });
});

describe("description/binding/weigh-takes-a-value-by-pointer", () => {
  it("hands a value by pointer", async () => {
    await witnessed("description/binding/weigh-takes-a-value-by-pointer");
  });
});

describe("description/binding/open-answers-a-handle-and-use-takes-it", () => {
  it("answers a handle that is handed back as an input and released by its holder", async () => {
    await witnessed("description/binding/open-answers-a-handle-and-use-takes-it");
  });
});

describe("description/binding/visit-takes-a-handle-inside-a-struct", () => {
  it("writes a handle inside a struct beside a u64 and an array of u64", async () => {
    await witnessed("description/binding/visit-takes-a-handle-inside-a-struct");
  });
});

describe("description/binding/a-refusal-arrives-with-its-detail-and-fix", () => {
  it("rejects with the provider's own detail and fix", async () => {
    await witnessed("description/binding/a-refusal-arrives-with-its-detail-and-fix");
  });
});

describe("description/binding/a-none-answer-arrives-as-none", () => {
  it("resolves NONE as none", async () => {
    await witnessed("description/binding/a-none-answer-arrives-as-none");
  });
});

describe("description/binding/a-missing-required-input-answers-malformed", () => {
  it("passes a left-out input as NULL, so the provider's malformed arrives", async () => {
    await witnessed("description/binding/a-missing-required-input-answers-malformed");
  });
});

describe("description/binding/every-answer-is-released-exactly-once", () => {
  it("releases every answer once, through the release its description names, and the handle once", async () => {
    await witnessed("description/binding/every-answer-is-released-exactly-once");
  });
});

describe("description/binding/a-handle-the-plugin-never-released-is-released-at-the-unload", () => {
  it("releases the handle its holder kept at the unload, while the binary is still open", async () => {
    await witnessed("description/binding/a-handle-the-plugin-never-released-is-released-at-the-unload");
  });
});

describe("description/binding/an-input-the-operation-does-not-take-is-the-callers-mistake", () => {
  it("refuses a name the operation does not take, a count it fills itself and a struct member it does not hold, calling nothing", async () => {
    await witnessed("description/binding/an-input-the-operation-does-not-take-is-the-callers-mistake");
  });
});

describe("description/binding/an-operation-its-provider-does-not-offer-is-the-callers-mistake", () => {
  it("keeps an operation its provider holds NULL for on the bound object, and refuses a call of it", async () => {
    await witnessed("description/binding/an-operation-its-provider-does-not-offer-is-the-callers-mistake");
  });
});
