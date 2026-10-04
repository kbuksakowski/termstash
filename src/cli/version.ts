declare const __VERSION__: string | undefined;

/** Injected at build time by tsup; falls back when run from source. */
export const VERSION: string = typeof __VERSION__ === "string" ? __VERSION__ : "0.0.0-dev";
