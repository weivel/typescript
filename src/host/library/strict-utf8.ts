/**
 * Decodes UTF-8, refusing a malformed sequence and keeping a leading byte order mark in the text.
 *
 * @implNote The default `ignoreBOM: false` strips a byte order mark silently, which Java's
 * `StrictJson` does not, so the same library answer or `library.json` would load in one host and
 * be refused in the other. Kept, the mark reaches `JSON.parse` and is refused as not JSON in both.
 */
export const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
