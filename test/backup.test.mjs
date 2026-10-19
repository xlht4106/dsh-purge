// Reproduce and verify the backup / restore contract.
//
// History: this test originally guarded a Windows bug where backupAll used
// openSync(bak, "wx") + atomicCopyFile (copy to tmp, rename onto the placeholder),
// which Windows refuses — 61/62 backups failed with EPERM.
//
// Upstream has since replaced that path with writeOfficialSnapshot (a vault under
// $DSH_HOME plus a sidecar). The EPERM bug is gone by construction, so this test now
// guards the behaviour that still matters:
//   1. backupAll succeeds for targets it can snapshot, and only tolerates the
//      "already patched" refusal (real $DSH_HOME files this machine already edited);
//   2. a second backupAll is a no-op (idempotent, no double write);
//   3. revertAll reproduces the original bytes exactly, even after the file is
//      clobbered — that is the whole point of keeping a snapshot.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SRC = process.env.DSH_AI_BASE || "";
if (!SRC || !fs.existsSync(SRC)) {
  console.log("SKIP: DSH_AI_BASE 未设置或不存在，跳过备份验证");
  process.exit(0);
}
process.env.DSH_SURFACE = "desktop";
const core = await import("../lib/core.js");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dshpurge-bak-"));
fs.cpSync(SRC, tmp, { recursive: true });

const files = core.targetFiles(tmp);
const targets = [];
for (const fp of Object.values(files)) {
  for (const one of Array.isArray(fp) ? fp : [fp]) {
    if (one && fs.existsSync(one) && !targets.includes(one)) targets.push(one);
  }
}
console.log("target files:", targets.length);

const ALREADY = /already patched, no official backup/;
let failures = 0;
const fail = (msg) => {
  failures += 1;
  console.log("FAIL " + msg);
};

// ── 1. first backup ──────────────────────────────────────────────────────────
const report = await core.backupAll(tmp);
const tolerated = report.errors.filter(([, e]) => ALREADY.test(String(e)));
const unexpected = report.errors.filter(([, e]) => !ALREADY.test(String(e)));
console.log(`made: ${report.made.length}  errors: ${report.errors.length} (already-patched: ${tolerated.length})`);
if (unexpected.length > 0) {
  fail("unexpected backup errors:");
  for (const [fp, e] of unexpected.slice(0, 5)) console.log("   ", fp.replace(tmp, "…"), "->", e);
}
if (report.made.length === 0) fail("no backups were made at all");

// ── 2. idempotency (must run before revert, which consumes snapshots) ────────
const second = await core.backupAll(tmp);
const secondUnexpected = second.errors.filter(([, e]) => !ALREADY.test(String(e)));
if (secondUnexpected.length > 0) {
  fail(`second backupAll errored unexpectedly (${secondUnexpected.length})`);
} else if (second.made.length !== 0) {
  fail(`second backupAll should create nothing, made ${second.made.length}`);
} else {
  console.log("PASS second backupAll is a no-op");
}

// ── 3. restore fidelity ─────────────────────────────────────────────────────
const originals = report.made.filter((p) => fs.existsSync(p));
const before = new Map(originals.map((p) => [p, fs.readFileSync(p)]));

if (originals.length > 0) {
  const probe = originals[0];
  fs.writeFileSync(probe, "CLOBBERED BY TEST\n", "utf8");
  await core.revertAll(tmp);

  let verified = 0;
  for (const p of originals) {
    if (!fs.existsSync(p)) {
      fail(`original vanished after revert: ${p.replace(tmp, "…")}`);
      continue;
    }
    if (!fs.readFileSync(p).equals(before.get(p))) {
      fail(`restore did not reproduce original: ${p.replace(tmp, "…")}`);
      break;
    }
    verified += 1;
  }
  console.log(`verified restorable backups: ${verified}/${originals.length}`);
  if (verified !== originals.length) fail("not every backup restored");
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures === 0 ? "\nBACKUP OK" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
