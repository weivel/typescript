/**
 * A text its caller handed with an embedded NUL, which a C text cannot hold whole: refused before the core is called,
 * as the caller's mistake, and reported to no sink.
 */
export class EmbeddedNulError extends Error {
  readonly text: string;

  constructor(text: string) {
    super(`${JSON.stringify(text)} holds a NUL, so it cannot cross into C whole.`);
    this.name = "EmbeddedNulError";
    this.text = text;
  }
}

/** `text`, unless it holds a NUL. @throws EmbeddedNulError when it does. */
export function textForC(text: string): string {
  if (text.includes("\u0000")) {
    throw new EmbeddedNulError(text);
  }
  return text;
}

/** `text`, or null when there is none. @throws EmbeddedNulError when it holds a NUL. */
export function optionalTextForC(text: string | null | undefined): string | null {
  return text === undefined || text === null ? null : textForC(text);
}
