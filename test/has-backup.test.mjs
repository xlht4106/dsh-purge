// hasBackup() must stay semantically identical to a full targetFiles() scan.
//
// The optimisation walks aiBase + $DSH_HOME looking for *.dshpurge.bak before
// falling back to the full scan. A wrong probe silently reports "no backup", which
// makes the UI hide the Revert action and leaves users unable to roll back — so the
// contract is: whenever the full scan says true, the fast path must say true too.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DSH_SURFACE = "desktop";
const core = await import("../lib/core.js");

/** Reference implementation: the original, obviously-correct scan. */
function referenceHasBackup(aiBase) {
  const files = core.targetFiles(aiBase);
  for (const fp of Object.values(files).flat()) {
    if (!fp || !fs.existsSync(fp)) continue;
    if (fs.existsSync(`${fp}.dshpurge.bak`)) return true;
  }
  return false;
}

const aiBase = process.env.DSH_AI_BASE || "";
if (!aiBase || !fs.existsSync(aiBase)) {
  console.log("SKIP: DSH_AI_BASE 未设置或不存在，跳过 hasBackup 一致性验证");
  process.exit(0);
}

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${ok ? "" : ` (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
}

console.log("--- baseline on the real machine ---");
{
  const ref = referenceHasBackup(aiBase);
  const fast = await core.hasBackup(aiBase);
  check(`fast path agrees with full scan (both ${ref})`, fast, ref);
}

console.log("--- synthetic tree with a backup in aiBase ---");
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dshpurge-hb-"));
  fs.cpSync(aiBase, tmp, { recursive: true });
  // Pick any target file inside the copied tree and drop a .bak next to it.
  const files = core.targetFiles(tmp);
  const inside = Object.values(files)
    .flat()
    .find((fp) => fp && fp.startsWith(tmp) && fs.existsSync(fp));
  if (!inside) {
    console.log("SKIP synthetic check (no target inside the copied tree)");
  } else {
    fs.writeFileSync(`${inside}.dshpurge.bak`, "backup\n");
    check("fast path finds a bak in aiBase", await core.hasBackup(tmp), true);
    check("reference also finds it", referenceHasBackup(tmp), true);
    fs.unlinkSync(`${inside}.dshpurge.bak`);
    check("fast path says false once removed", await core.hasBackup(tmp), referenceHasBackup(tmp));
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log("--- bogus aiBase must not throw and must match the reference ---");
{
  // targetFiles still resolves $DSH_HOME-backed keys even when aiBase is bogus,
  // so the reference can legitimately return true here. The contract under test is
  // "fast path == reference", not "false".
  const bogus = path.join(os.tmpdir(), "definitely-not-here");
  const ref = referenceHasBackup(bogus);
  const fast = await core.hasBackup(bogus);
  check(`fast path agrees with reference (both ${ref})`, fast, ref);
}

console.log(failures === 0 ? "\nHASBACKUP OK" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
