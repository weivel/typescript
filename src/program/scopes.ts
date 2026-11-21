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

/** The detail a refused scope carries: the provider's own, or what went wrong when it gave none. */
function refusalDetail(error: unknown): string {
  return error instanceof DescribedCallError && error.detail !== null ? error.detail : messageOf(error);
}

/** The scopes a run's plugins are given, from whichever loaded library serves `weivel.scope`, or none. */
export class PluginScopes {
  readonly #host: Host;
  readonly #ids: StandardServiceIds;
  #provider: BoundDefinition | undefined;

  constructor(host: Host, ids: StandardServiceIds) {
    this.#host = host;
    this.#ids = ids;
  }

  /** Asks every scope of the first of `libraries` that serves a described `weivel.scope`. */
  askOf(libraries: readonly LoadedLibrary[]): void {
    this.#provider = libraries.map((library) => library.described.get(this.#ids.scope)).find((bound) => bound !== undefined);
  }

  /**
   * Opens the scope of the plugin whose manifest the plan names `manifest` and offers each definition it answers to
   * that plugin alone, under the standard's id for it; with no provider, it offers nothing.
   *
   * @throws Error when an offer cannot be made, the scope then freed again.
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
    return answer === none ? noScope : this.#offer(plugin, answer);
  }

  #offer(plugin: bigint, answer: ScopeAnswer): OpenedScope {
    const withdrawals: (() => void)[] = [];
    const release = (): void => {
      withdrawals.splice(0).forEach((withdraw) => withdraw());
      answer.release?.();
    };
    try {
      for (const member of scopeMembers) {
        const definition = answer[member];
        if (definition !== undefined) {
          withdrawals.push(alive(this.#host.registerPluginService(plugin, { id: this.#ids[member] }, definition)));
        }
      }
    } catch (error) {
      release();
      throw error;
    }
    return { release };
  }
}
