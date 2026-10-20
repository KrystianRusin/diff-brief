// Times `diffbrief hook --noop` from the built CLI. Warns (never fails) when
// p95 is over budget, since hook startup sits on the agent's hot path.
import { execFileSync } from "node:child_process";

const RUNS = 30;
const BUDGET_MS = 100;

const times = [];
for (let i = 0; i < RUNS; i++) {
  const start = process.hrtime.bigint();
  execFileSync(process.execPath, ["dist/cli.js", "hook", "--noop"]);
  times.push(Number(process.hrtime.bigint() - start) / 1e6);
}
times.sort((a, b) => a - b);
const p50 = times[Math.floor(RUNS * 0.5)];
const p95 = times[Math.floor(RUNS * 0.95)];

console.log(`hook --noop: p50 ${p50.toFixed(1)} ms, p95 ${p95.toFixed(1)} ms`);
if (p95 > BUDGET_MS) console.warn(`warning: p95 over ${BUDGET_MS} ms budget`);
