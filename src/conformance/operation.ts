/** An op may settle asynchronously, because an engine answering through a `Promise` cannot be read any sooner. */
export type Operation = (given: Record<string, unknown>) => Record<string, unknown> | Promise<Record<string, unknown>>;

export type Operations = Readonly<Record<string, Operation>>;

export interface Vector {
  id: string;
  op: string;
  given?: unknown;
}

export interface Outcome {
  id: string;
  witnessed: boolean;
  result?: Record<string, unknown>;
}
