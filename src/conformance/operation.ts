export type Operation = (given: Record<string, unknown>) => Record<string, unknown>;

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
