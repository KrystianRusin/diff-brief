// Upgrades older records to CURRENT_VERSION before validation. Only v1 exists,
// so these are identity for now. When v2 lands, add a `case 1:` that rewrites
// the record to v2 shape and falls through.

export function migrateEvent(raw: unknown): unknown {
  return raw;
}

export function migrateAnnotations(raw: unknown): unknown {
  return raw;
}
