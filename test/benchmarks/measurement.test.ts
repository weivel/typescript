import { describe, it } from "vitest";
import { benchmarkControlCall, benchmarkLibraryCall, benchmarkSameLanguageCall, pairRatio } from "../../src/benchmarks/index.ts";
import { echoLibraryPath } from "../host/world.ts";
import { coreLibraryPath } from "../real-core.ts";
import { standardLibraryPath } from "../real-standard.ts";

const libraries = { coreLibraryPath, standardLibraryPath };
const runner = `runner=${process.platform}-${process.arch}`;

describe("measurement", () => {
  it("prints every benchmark's medians and ratios", { timeout: 300_000 }, () => {
    for (let repeat = 0; repeat < 5; repeat++) {
      const pair = benchmarkSameLanguageCall(libraries);
      const control = benchmarkControlCall(libraries);
      const library = benchmarkLibraryCall({ ...libraries, echoLibraryPath });
      console.log(
        `weivel-measure ${runner} repeat=${repeat}` +
          ` direct=${pair.direct.median.toFixed(2)} again=${pair.directAgain.median.toFixed(2)} weivel=${pair.throughWeivel.median.toFixed(2)}` +
          ` noise=${pairRatio(pair.directAgain, pair.direct).toFixed(4)} pair=${pairRatio(pair.throughWeivel, pair.direct).toFixed(4)}` +
          ` control_bare=${control.bareCall.median.toFixed(2)} control=${control.weivelCall.median.toFixed(2)} control_ratio=${pairRatio(control.weivelCall, control.bareCall).toFixed(4)}` +
          ` library_bare=${library.bareCall.median.toFixed(2)} library=${library.weivelCall.median.toFixed(2)} library_ratio=${pairRatio(library.weivelCall, library.bareCall).toFixed(4)}`,
      );
    }
  });
});
