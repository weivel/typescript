import type { LibraryPin } from "../library/index.js";

/** The neutral fixture library, as released by `weivel/bindings`, pinned by digest. */
export const ECHO_PIN: LibraryPin = {
  repository: "weivel/bindings",
  tag: "v0.1.1",
  sha256: {
    "library.json": "60c5c20c4fee91b1a6b220d792f6aecab8c9ddea8582ecabd9acec8172d2a2c7",
    "linux-x64": "98cfd1f23800a3335a71cbf93f720baf8507e6ae1b257ef5654d7296852c41b9",
    "win32-x64": "ced2da158d9b52486ad5112c2f5d8a286f21a807f612309b7dcb2c12b1d273e3",
  },
};
