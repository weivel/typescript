export type DiagnosticSink = (message: string) => void;

/** The default sink: diagnostics are dropped unless a host asks to hear them. */
export const DISCARD: DiagnosticSink = () => {};
