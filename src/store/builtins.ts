// Node builtins for modules on the capture hook's import path, which runs on
// every agent tool call. A static ESM import costs 10-20 ms at startup for
// several builtins (measured on Node 22: fs ~11 ms for its ESM wrapper;
// child_process, crypto and zlib aren't in the startup snapshot). fs is free
// through getBuiltinModule; the rest load on first use, so a hook that never
// hashes or spawns git never pays for them.

export const fs = process.getBuiltinModule("node:fs");

export const childProcess = () => process.getBuiltinModule("node:child_process");
export const crypto = () => process.getBuiltinModule("node:crypto");
export const zlib = () => process.getBuiltinModule("node:zlib");
