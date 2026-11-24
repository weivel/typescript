# The `timer` module

How this package reads the core's `docs/contract/timer.md`: the scheduler a host arms by default, and why a scheduler is
handed a time rather than a delay.

- A host given no `scheduler` arms `setTimeout`, through `createSystemScheduler`.
- A `Scheduler` is handed the time a wait ends at, on the clock's scale, not a delay, so the timer reads the clock
  only when its callback runs and when it schedules on a scheduler that declares a `maximumWaitMilliseconds`. The
  default scheduler, `createSystemScheduler(clock)`, can wait any time: it chains `setTimeout`s past its longest delay,
  and reads the clock as it schedules, to turn the time into a delay. A scheduler whose `schedule` or `cancel` throws
  is reported to the error sink, and the timer counts itself disarmed.
