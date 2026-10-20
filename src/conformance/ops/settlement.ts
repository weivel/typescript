export type SettlementState = "pending" | "settled" | "rejected";

export interface Settlement {
  state: SettlementState;
}

export function settlementOf(asked: Promise<unknown>, onSettled: () => void = () => {}): Settlement {
  const settlement: Settlement = { state: "pending" };
  asked.then(
    () => {
      settlement.state = "settled";
      onSettled();
    },
    () => {
      settlement.state = "rejected";
      onSettled();
    },
  );
  return settlement;
}

/** One macrotask, by which every promise reaction queued so far has run. */
export function settledTurn(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
