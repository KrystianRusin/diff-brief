import { readFileSync } from "node:fs";
import { z } from "zod";
import type { Hunk } from "../../diff/index.js";
import { configPath } from "../../store/layout.js";

// Risk tags from path globs and changed-line regexes (DB-11). Defaults below;
// .diffbrief/config.json can add rules or turn default tags off:
//
//   { "risk": { "rules": [{ "tag": "billing", "paths": ["src/billing/**"] }],
//               "disable": ["concurrency"] } }
//
// A rule with both paths and lines needs both to match; give two rules the
// same tag to match either. Line regexes are tested against added and
// removed lines, never context. "/re/flags" sets flags; a bare string has
// none.

export type RiskRule = { tag: string; paths?: string[]; lines?: string[]; weight?: number };

export const DEFAULT_RISK_RULES: RiskRule[] = [
  // "session" and "token" are left out of paths: session stores and
  // tokenizers are far more common than auth code under those names.
  {
    tag: "auth",
    weight: 3,
    paths: [
      "**/*{auth,login,oauth,jwt,permission,password}*",
      "**/*{auth,login,oauth,jwt,permission,password}*/**",
    ],
  },
  {
    tag: "auth",
    lines: [
      "/\\b(auth(?:n|z|enticat\\w*|oriz\\w*|_?token)?|passwords?|passwd|jwt|oauth2?|access_?tokens?|refresh_?tokens?|api_?keys?|bearer|csrf|permissions?)\\b/i",
    ],
  },
  {
    tag: "migration",
    weight: 3,
    paths: [
      "**/migrations/**",
      "**/migration/**",
      "**/*.sql",
      "**/*.prisma",
      "**/schema.*",
      "**/schema/**",
      "**/schemas/**",
    ],
  },
  {
    tag: "config",
    weight: 1,
    paths: [
      ".env*",
      "*.env",
      "**/config/**",
      ".github/workflows/**",
      ".gitlab-ci.yml",
      ".circleci/**",
      "Jenkinsfile",
      "Dockerfile*",
      "docker-compose*.{yml,yaml}",
      "{package-lock.json,pnpm-lock.yaml,yarn.lock,go.mod,go.sum,Cargo.lock,Gemfile.lock,poetry.lock}",
      "requirements*.txt",
    ],
  },
  // Dependency lines in a manifest: "name": "^1.2.3", name = "1.2", etc.
  {
    tag: "config",
    paths: ["{package.json,Cargo.toml,pyproject.toml}"],
    lines: ['/^\\s*"?[@\\w./-]+"?\\s*[:=]\\s*"(?:[~^<>=*]|\\d|workspace:|npm:|file:|git)/'],
  },
  // Not async/await: in JS and Python nearly every change has them.
  {
    tag: "concurrency",
    weight: 2,
    lines: [
      "/\\b(mutex|semaphore|rwlock|spinlock|atomic\\w*|deadlock|goroutine|threads?|threading|worker_threads|lock(?:s|ed|file)?|unlock)\\b/i",
      "/\\bPromise\\.(?:all|allSettled|race|any)\\b|\\bsync\\.(?:Mutex|RWMutex|WaitGroup|Once)\\b|\\bgo func\\b/",
    ],
  },
  {
    tag: "money",
    weight: 3,
    lines: [
      "/\\b(prices?|pricing|amounts?|discounts?|currenc(?:y|ies)|payments?|invoices?|refunds?|billing)\\b/i",
    ],
  },
  // An exported declaration added or removed: TS/JS, Python, Go, Rust, Java/C#.
  {
    tag: "public_api",
    weight: 2,
    lines: [
      "/^\\s*export\\s+(?:default\\s+)?(?:declare\\s+)?(?:abstract\\s+)?(?:async\\s+)?(?:function|class|const|let|var|interface|type|enum)\\b/",
      "/^\\s*export\\s*(?:type\\s*)?\\{/",
      "/^(?:async\\s+)?def\\s+[A-Za-z]\\w*\\s*\\(|^class\\s+[A-Za-z]/",
      "/^func\\s+(?:\\([^)]*\\)\\s*)?[A-Z]/",
      "/^\\s*pub\\s+(?:async\\s+)?(?:fn|struct|enum|trait|type|const|mod)\\b/",
      "/^\\s*public\\s+/",
    ],
  },
];

// Built in, not a regex: a hunk that is mostly removals.
export const DELETED_CODE = { tag: "deleted_code", weight: 1, minLines: 20, minShare: 0.7 };

const DEFAULT_WEIGHT = 1;

const ConfigRule = z.object({
  tag: z.string().min(1),
  paths: z.array(z.string()).optional(),
  lines: z.array(z.string()).optional(),
  weight: z.number().nonnegative().optional(),
});
const RiskConfig = z
  .object({
    risk: z
      .object({ rules: z.array(ConfigRule).optional(), disable: z.array(z.string()).optional() })
      .optional(),
  })
  .loose();

export class RiskConfigError extends Error {}

// Defaults plus .diffbrief/config.json, validated.
export function loadRiskRules(root: string): RiskRule[] {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(configPath(root), "utf8"));
  } catch {
    return DEFAULT_RISK_RULES; // no config
  }
  const parsed = RiskConfig.safeParse(raw);
  if (!parsed.success)
    throw new RiskConfigError(`config.json: invalid "risk": ${parsed.error.message}`);
  const { rules = [], disable = [] } = parsed.data.risk ?? {};
  const off = new Set(disable);
  const all = [...DEFAULT_RISK_RULES.filter((r) => !off.has(r.tag)), ...rules];
  for (const r of all) compileRule(r); // fail now, with the rule named
  return all;
}

// full: the glob has a "/" and matches the whole path; otherwise the file
// name at any depth, like .gitignore.
type PathGlob = { re: RegExp; full: boolean };
export type CompiledRule = { tag: string; weight: number; paths?: PathGlob[]; lines?: RegExp[] };

export function compileRule(r: RiskRule): CompiledRule {
  try {
    return {
      tag: r.tag,
      weight: r.weight ?? DEFAULT_WEIGHT,
      ...(r.paths
        ? { paths: r.paths.map((g) => ({ re: globToRegExp(g), full: g.includes("/") })) }
        : {}),
      ...(r.lines ? { lines: r.lines.map(toRegExp) } : {}),
    };
  } catch (err) {
    throw new RiskConfigError(`risk rule "${r.tag}": ${err instanceof Error ? err.message : err}`);
  }
}

// Tags for one hunk, in rule order, without duplicates.
export function riskTags(h: Hunk, rules: CompiledRule[]): string[] {
  const changed = h.lines.filter((l) => l.kind !== " ").map((l) => l.text);
  const tags = new Set<string>();
  for (const r of rules) {
    if (!r.paths && !r.lines) continue;
    const pathOk = !r.paths || [h.path, h.oldPath].some((p) => p && matchesAny(r.paths!, p));
    const linesOk = !r.lines || changed.some((t) => r.lines!.some((re) => re.test(t)));
    if (pathOk && linesOk) tags.add(r.tag);
  }
  const removed = h.lines.filter((l) => l.kind === "-").length;
  if (changed.length > DELETED_CODE.minLines && removed / changed.length > DELETED_CODE.minShare) {
    tags.add(DELETED_CODE.tag);
  }
  return [...tags];
}

// Weight per tag: the highest any rule gives it.
export function tagWeights(rules: CompiledRule[]): Map<string, number> {
  const w = new Map<string, number>([[DELETED_CODE.tag, DELETED_CODE.weight]]);
  for (const r of rules) {
    // A rule without a weight doesn't lower the one its tag already has.
    w.set(r.tag, Math.max(w.get(r.tag) ?? 0, r.weight));
  }
  return w;
}

function matchesAny(globs: PathGlob[], path: string): boolean {
  const base = path.slice(path.lastIndexOf("/") + 1);
  return globs.some((g) => g.re.test(g.full ? path : base));
}

function toRegExp(s: string): RegExp {
  const m = /^\/(.*)\/([a-z]*)$/s.exec(s);
  return m ? new RegExp(m[1]!, m[2]) : new RegExp(s);
}

// *, ?, ** (any depth, "**/" may match nothing), {a,b} (alternatives may hold
// wildcards).
export function globToRegExp(glob: string): RegExp {
  return new RegExp(`^${globBody(glob)}$`);
}

function globBody(glob: string): string {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") {
          i++;
          re += "(?:.*/)?";
        } else re += ".*";
      } else re += "[^/]*";
    } else if (c === "?") {
      re += "[^/]";
    } else if (c === "{" && glob.indexOf("}", i) > i) {
      const end = glob.indexOf("}", i);
      re += `(?:${glob
        .slice(i + 1, end)
        .split(",")
        .map(globBody)
        .join("|")})`;
      i = end;
    } else {
      re += c.replace(/[.+^$()|[\]\\/{}]/g, "\\$&");
    }
  }
  return re;
}
