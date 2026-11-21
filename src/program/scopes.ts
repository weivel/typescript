import type { Logger } from "../context/index.js";
import { messageOf } from "../host/activation-failure.js";
import { DescribedCallError, none, type BoundDefinition, type Host, type LoadedLibrary } from "../host/index.js";
import type { StandardServiceIds } from "../standard/index.js";
import { alive } from "./alive.js";

/** A plugin's scope once opened: its definitions offered to it alone, until `release` withdraws them and frees it. */
export interface OpenedScope {
  release(): void;
}

/** Why the provider refused a plugin's scope, so the plugin is not activated. */
export interface RefusedScope {
  readonly refused: string;
}

const noScope: OpenedScope = { release() {} };

/** A weivel_standard_scope as the bound `open` answers it: a NULL definition is left out. */
type ScopeAnswer = Partial<Record<ScopeMember, BoundDefinition>> & { release?(): void };

type ScopeMember = "config" | "secrets" | "paths" | "log";

const scopeMembers: readonly ScopeMember[] = ["config", "secrets", "paths", "log"];

/**
 * Runs every withdrawal, then frees the scope, each whatever became of the one before.
 *
 * @throws the first failure, or an AggregateError of every failure when more than one failed.
 */
function releaseFully(withdrawals: (() => void)[], answer: ScopeAnswer): void {
  const failures: unknown[] = [];
  for (const withdraw of withdrawals.splice(0)) {
    try {
      withdraw();
    } catch (error) {
      failures.push(error);
    }
  }
  try {
    answer.release?.();
  } catch (error) {
    failures.push(error);
  }
  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length > 1) {
    throw new AggregateError(failures, "The scope could not be released fully.");
  }
}

/** The detail a refused scope carries: the provider's own, or what went wrong when it gave none. */
function refusalDetail(error: unknown): string {
  return error instanceof DescribedCallError && error.detail !== null ? error.detail : messageOf(error);
}

/** The scopes a run's plugins are given, from whichever loaded library serves `weivel.scope`, or none. */
export class PluginScopes {
  readonly #host: Host;
  readonly #ids: StandardServiceIds;
  readonly #log: Logger;
  #provider: BoundDefinition | undefined;

  constructor(host: Host, ids: StandardServiceIds, log: Logger) {
    this.#host = host;
    this.#ids = ids;
    this.#log = log;
  }

  /** Asks every scope of the first of `libraries` that serves a described `weivel.scope`. */
  askOf(libraries: readonly LoadedLibrary[]): void {
    this.#provider = libraries.map((library) => library.described.get(this.#ids.scope)).find((bound) => bound !== undefined);
  }

  /**
   * Opens the scope of the plugin whose manifest the plan names `manifest` and offers each definition it answers to
   * that plugin alone, under the standard's id for it; with no provider, it offers nothing. A scope refused, or one
   * whose definitions cannot be offered, as when a loaded library declares one of the ids, answers why; one offered in
   * part has every offer withdrawn and is freed again before it answers.
   */
  async open(plugin: bigint, manifest: string): Promise<OpenedScope | RefusedScope> {
    if (this.#provider === undefined) {
      return noScope;
    }
    let answer: ScopeAnswer | typeof none;
    try {
      answer = (await this.#provider.open!({ manifest_path: manifest })) as ScopeAnswer | typeof none;
    } catch (error) {
      return { refused: refusalDetail(error) };
    }
    if (answer === none) {
      return noScope;
    }
    try {
      return this.#offer(plugin, answer);
    } catch (error) {
      return { refused: `its scope could not be offered: ${messageOf(error)}` };
    }
  }

  /** @throws the error that stopped an offer, after the scope was released; a failing release is logged, not thrown. */
  #offer(plugin: bigint, answer: ScopeAnswer): OpenedScope {
    const withdrawals: (() => void)[] = [];
    try {
      for (const member of scopeMembers) {
        const definition = answer[member];
        if (definition !== undefined) {
          withdrawals.push(alive(this.#host.registerPluginService(plugin, { id: this.#ids[member] }, definition)));
        }
      }
    } catch (error) {
      try {
        releaseFully(withdrawals, answer);
      } catch (releaseError) {
        this.#log.error(`A scope that could not be offered could not be released either: ${messageOf(releaseError)}`, releaseError);
      }
      throw error;
    }
    return { release: () => releaseFully(withdrawals, answer) };
  }
}
