import koffi from "koffi";
import { EmbeddedNulError } from "../../core/text.js";

const encoder = new TextEncoder();

/** Native memory one call writes its inputs and empty answers into, every block freed together once the call is done. */
export class CallArena {
  readonly #blocks: object[] = [];

  /** `byteSize` zeroed bytes, never fewer than one so every block is a real address. */
  allocate(byteSize: number): object {
    const length = Math.max(byteSize, 1);
    const block = koffi.alloc("uint8_t", length) as object;
    this.#blocks.push(block);
    koffi.encode(block, 0, "uint8_t", new Uint8Array(length), length);
    return block;
  }

  /** `text` as NUL-terminated UTF-8, or NULL for null. @throws EmbeddedNulError for a text holding a NUL. */
  text(text: string | null): object | null {
    if (text === null) {
      return null;
    }
    if (text.includes("\u0000")) {
      throw new EmbeddedNulError(text);
    }
    return this.bytes(encoder.encode(`${text}\u0000`));
  }

  /** A copy of `bytes`, or NULL when there are none. */
  bytes(bytes: Uint8Array): object | null {
    if (bytes.length === 0) {
      return null;
    }
    const block = this.allocate(bytes.length);
    koffi.encode(block, 0, "uint8_t", bytes, bytes.length);
    return block;
  }

  free(): void {
    for (const block of this.#blocks.splice(0)) {
      koffi.free(block);
    }
  }
}
