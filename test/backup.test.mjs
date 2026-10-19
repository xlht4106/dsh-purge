// Reproduce and verify the Windows backup (EPERM) defect.
//
// backupAll() used to: openSync(bak, "wx")  -> create empty placeholder
//                     atomicCopyFile(fp, bak) -> copy to tmp, rename(tmp -> bak)
// On Windows, renaming onto an *existing* file is refused, so every backup failed
// with EPERM. This script builds a fake aiBase tree, calls backupAll(), and asserts
// the .dshpurge.bak files are created with the original bytes.
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

const report = await core.backupAll(tmp);
console.log("made:", report.made.length, "errors:", report.errors.length);

let failures = 0;
if (report.errors.length > 0) {
  failures += 1;
  console.log("FAIL backup errors present:");
  for (const [fp, err] of report.errors.slice(0, 5)) console.log("   ", fp.replace(tmp, "…"), "->", err);
}

// Every successful backup must be byte-identical to its original.
let verified = 0;
for (const bak of report.made) {
  const original = bak.slice(0, -".dshpurge.bak".length);
  const a = fs.readFileSync(original);
  const b = fs.readFileSync(bak);
  if (!a.equals(b)) {
    failures += 1;
    console.log("FAIL bak content differs:", bak.replace(tmp, "…"));
    break;
  }
  verified += 1;
}
console.log(`verified byte-identical backups: ${verified}`);

// Idempotency: a second run must not duplicate or error.
const second = await core.backupAll(tmp);
if (second.made.length !== 0) {
  failures += 1;
  console.log("FAIL second backupAll should create nothing, made:", second.made.length);
} else {
  console.log("PASS second backupAll is a no-op");
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures === 0 ? "\nBACKUP OK" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
