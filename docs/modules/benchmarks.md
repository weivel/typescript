# The `benchmarks` module

How this package samples the rows of the core's `docs/contract/benchmarks.md` that reach C libraries; the gates and
their budgets are the conformance kit's `docs/benchmarks.md`, read from its `benchmarks/typescript.txt`. The code is in
[src/benchmarks/](../source/src/benchmarks/README.md).

- The definition row of the `library-call` benchmark samples in shorter rounds than the same-language pair: 100000
  warm-up calls, then 201 rounds of 200 calls per path, against the pair's 2000000 warm-up calls and 301 rounds of
  10000. Each path is handed the struct's address itself and reads its operations out of it once, before the timed
  loop.
- The `described-call` benchmark times the standard's `described` mirror's `reflect`, a sample holding a text and a
  counted array of three texts, through the bound object a consumer resolved, over the same operation through a bare
  koffi binding of the fixture's structs declared by hand in the benchmark, the one file that declares them. Both
  release the answer and the refusal after every call; the hand path keeps one answer and one refusal block across
  calls. It samples as the `library-call` rows do, with the echo library's bytes call in the same rounds for its time
  beside theirs, and the bound method's promise is not awaited in the timed loop.
- The `blocking-call` benchmark times the described walker's `wait`, a blocking operation, through the bound object,
  each call awaited before the next, over the same `wait` through a bare koffi binding on the calling thread: 2000
  warm-up calls, then 201 rounds of 50 calls per path, judged by the kit's `blocking-call` row.
