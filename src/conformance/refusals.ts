import { RefusalCode, type Refusal } from "../core/index.js";

/** A refusal as a kit vector states it: the code by its kit name, such as `timed_out`. */
export interface KitRefusal {
  readonly code: string;
  readonly subject: string | null;
  readonly hasFix: boolean;
}

function kitNameOf(key: string): string {
  return key.replace(/[A-Z]/g, (letter, offset: number) => (offset === 0 ? "" : "_") + letter.toLowerCase());
}

const kitNames = new Map<number, string>(Object.entries(RefusalCode).map(([key, code]) => [code, kitNameOf(key)]));

/** The kit's name for a core refusal code; a code this layer has no name for is written as its number. */
export function kitCodeName(code: RefusalCode): string {
  return kitNames.get(code) ?? String(code);
}

export function kitRefusal(refusal: Pick<Refusal, "code" | "subject" | "hasFix">): KitRefusal {
  return { code: kitCodeName(refusal.code), subject: refusal.subject, hasFix: refusal.hasFix };
}
