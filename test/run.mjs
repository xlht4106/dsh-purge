#!/usr/bin/env node
/**
 * Test runner for the dsh-purge regression suite.
 *
 * Every test is a standalone .mjs that exits 0 on success and non-zero on failure.
 * They are deliberately dependency-free (no vitest/node:test) because this package
 * ships to users and must stay install-light.
 *
 * Tests that need the DSH implementation tree read it from $DSH_AI_BASE. When the
 * variable is unset the anchor/backcompat tests skip instead of failing, so a plain
 * `npm test` works on a machine without a local DSH install.
 *
 * Usage:
 *   node test/run.mjs              # run everything that can run here
 *   DSH_AI_BASE=<path> node test/run.mjs
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

// Every test may bail out early by printing a SKIP line and exiting 0. The runner
// must report that as "skip", not "pass" — otherwise a machine without a DSH tree
// would look like it ran the anchor checks successfully.
const tests = fs
  .readdirSync(here)
  .filter((name) => name.endsWith(".test.mjs"))
  .sort();

const results = [];

for (const name of tests) {
  const started = Date.now();
  const run = spawnSync(process.execPath, [path.join(here, name)], {
    cwd: path.join(here, ".."),
    encoding: "utf8",
    env: process.env,
  });
  const ms = Date.now() - started;
  const stdout = `${run.stdout || ""}${run.stderr || ""}`.trim();
  const skipped = /^SKIP:/m.test(stdout);
  const ok = run.status === 0;

  results.push({
    name,
    status: skipped ? "skip" : ok ? "pass" : "fail",
    ms,
    detail: skipped
      ? stdout.split("\n").find((l) => l.startsWith("SKIP:")) || ""
      : ok
        ? ""
        : stdout.split("\n").slice(-12).join("\n"),
  });
}

const pass = results.filter((r) => r.status === "pass").length;
const fail = results.filter((r) => r.status === "fail").length;
const skip = results.filter((r) => r.status === "skip").length;

for (const r of results) {
  const tag = r.status === "pass" ? "PASS" : r.status === "skip" ? "SKIP" : "FAIL";
  const timing = r.ms === undefined ? "" : ` (${r.ms} ms)`;
  console.log(`${tag} ${r.name}${timing}${r.detail ? " — " + r.detail.split("\n")[0] : ""}`);
  if (r.status === "fail" && r.detail) {
    for (const line of r.detail.split("\n")) console.log("     " + line);
  }
}

console.log(`\n${pass} passed, ${fail} failed, ${skip} skipped`);
process.exit(fail === 0 ? 0 : 1);
