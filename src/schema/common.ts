import { z } from "zod";

export const Version = z.literal(1);

export const Timestamp = z.iso.datetime({ offset: true });

// sha256 hex of file content; also the blob store key.
export const ContentHash = z.string().regex(/^[0-9a-f]{64}$/);

export const GitSha = z.string().regex(/^[0-9a-f]{4,64}$/);
