export const CURRENT_VERSION = 1;

export class UnsupportedVersionError extends Error {
  constructor(
    readonly found: unknown,
    readonly what: string,
  ) {
    super(
      `${what} has schema version ${String(found)}, but this diffbrief only reads up to ` +
        `v${CURRENT_VERSION}. Upgrade diffbrief to read it.`,
    );
    this.name = "UnsupportedVersionError";
  }
}

// Throws for records written by a newer diffbrief. Missing or malformed `v` is
// left for the schema to reject with a normal validation error.
export function assertReadableVersion(raw: unknown, what: string): void {
  if (typeof raw !== "object" || raw === null) return;
  const v = (raw as { v?: unknown }).v;
  if (typeof v === "number" && v > CURRENT_VERSION) throw new UnsupportedVersionError(v, what);
}
