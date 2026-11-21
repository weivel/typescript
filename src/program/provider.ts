import { DescribedCallError, none, type BoundDefinition, type LoadedLibrary } from "../host/index.js";
import { messageOf } from "../host/activation-failure.js";
import type { ActionEnding, HostOutcome, HostPlan } from "./model.js";

/**
 * A text a plugin or the program wrote, with each NUL written out, so a C text carries it whole.
 *
 * @implNote An action's or an activation's failure quotes what JavaScript threw, which may hold a NUL.
 */
export function textForC(text: string): string {
  return text.replaceAll("\u0000", "\\0");
}

interface AnsweredNext {
  readonly has_next: number;
  readonly next: number | bigint;
}

/**
 * The host library's `weivel.host`, bound by its description: each method calls the operation of that name, and
 * rejects with the DescribedCallError of an answer other than OK.
 */
export class HostProvider {
  readonly #bound: BoundDefinition;

  private constructor(bound: BoundDefinition) {
    this.#bound = bound;
  }

  /** @throws Error when the library serves no described definition under `id`. */
  static of(library: LoadedLibrary, id: string): HostProvider {
    const bound = library.described.get(id);
    if (bound === undefined) {
      throw new Error(`The host library ${library.declaration.importName} serves no described ${id}.`);
    }
    return new HostProvider(bound);
  }

  async start(programArguments: readonly string[]): Promise<HostPlan> {
    return (await this.#call("start", { arguments: programArguments })) as HostPlan;
  }

  async started(outcomes: readonly HostOutcome[]): Promise<void> {
    await this.#call("started", { outcomes });
  }

  /** When to tick next, milliseconds since the Unix epoch, or undefined for never. */
  async tick(now: number): Promise<number | undefined> {
    const answered = (await this.#call("tick", { now })) as AnsweredNext;
    return answered.has_next === 1 ? Number(answered.next) : undefined;
  }

  /**
   * Tells how the action ended; a result no value tree holds is told as a failure saying so.
   *
   * @implNote The binding refuses such a result with a TypeError before anything reaches C, so `finished` is still
   * called exactly once.
   */
  async finished(ending: ActionEnding): Promise<void> {
    if ("failure" in ending) {
      await this.#call("finished", { failure: textForC(ending.failure) });
      return;
    }
    try {
      await this.#call("finished", { result: ending.result === undefined ? none : ending.result });
    } catch (error) {
      if (error instanceof DescribedCallError) {
        throw error;
      }
      await this.#call("finished", { failure: textForC(`the action answered what no value tree holds: ${messageOf(error)}`) });
    }
  }

  /** The code the program exits with. */
  async stop(): Promise<number> {
    return Number(await this.#call("stop", {}));
  }

  #call(operation: string, input: Readonly<Record<string, unknown>>): Promise<unknown> {
    return this.#bound[operation]!(input);
  }
}
