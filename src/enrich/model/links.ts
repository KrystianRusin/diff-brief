import { posix } from "node:path";
import { z } from "zod";
import { names, specifiers, withoutExt } from "../deterministic/test-gaps.js";

// Pass 2 (DB-13): the model links intents into a tree rooted at the ticket.
// Pass 1 saw one episode at a time, so it could only point at a plan step or
// the ticket; this pass can also say one intent exists to enable another.
// checkLinks() keeps any valid proposal but rates it against the code.

export const LinksReply = z.object({
  links: z.array(z.object({ intent_id: z.string(), serves: z.string() })),
});
export type LinksReply = z.infer<typeof LinksReply>;

export type LinkNode = { id: string; serves: string; files: string[] };
export type Link = { serves: string; confidence: "high" | "low" };

// serves: what pass 1 said, used when the proposal is missing or invalid
// (unknown id, a self link, a cycle). A link is "high" when parent and child
// share a file or one's file imports the other's; the ticket always is.
export function checkLinks(
  nodes: LinkNode[],
  proposed: LinksReply["links"],
  planFiles: Map<string, string[]>,
  related: (a: string, b: string) => boolean,
): Map<string, Link> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const want = new Map(proposed.map((l) => [l.intent_id, l.serves]));
  const serves = new Map(nodes.map((n) => [n.id, n.serves]));

  const reaches = (from: string, to: string) => {
    for (let at: string | undefined = from; at; at = serves.get(at)) if (at === to) return true;
    return false;
  };
  for (const n of nodes) {
    const p = want.get(n.id);
    if (p === undefined || p === n.id) continue;
    if (p === "ticket" || planFiles.has(p) || (byId.has(p) && !reaches(p, n.id)))
      serves.set(n.id, p);
  }

  const out = new Map<string, Link>();
  for (const n of nodes) {
    const p = serves.get(n.id)!;
    const parentFiles = planFiles.get(p) ?? byId.get(p)?.files;
    const ok = p === "ticket" || !!parentFiles?.some((pf) => n.files.some((f) => related(f, pf)));
    out.set(n.id, { serves: p, confidence: ok ? "high" : "low" });
  }
  return out;
}

// Same file, or one imports the other, among the diff's files. Only direct
// imports: a regex over each file's final content, like the test-gap check.
export function importRelation(
  paths: string[],
  read: (path: string) => string | null,
): (a: string, b: string) => boolean {
  const edges = new Set<string>();
  const targets = paths.map((p) => ({ path: p, bare: withoutExt(p) }));
  for (const from of paths) {
    const content = read(from);
    if (!content) continue;
    const dir = posix.dirname(from);
    for (const spec of specifiers(content)) {
      for (const t of targets)
        if (t.path !== from && names(spec, dir, t.bare)) edges.add(`${from}\0${t.path}`);
    }
  }
  return (a, b) => a === b || edges.has(`${a}\0${b}`) || edges.has(`${b}\0${a}`);
}
