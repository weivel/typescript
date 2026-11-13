/** A step queued among events, run when the handling of the queue reaches it. */
export class DeferredStep {
  constructor(readonly step: () => void) {}
}
