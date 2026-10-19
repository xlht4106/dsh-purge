// Tests for the "stale" patch state (docs/code-review.md C-1).
//
// The bug: for `skipIfMarked` patches, applyReplacementsToText() returns early as
// soon as the marker is present. If upstream later changes the code so the anchor
// reappears, the patch can never be re-applied — yet patchApplied() sees the marker
// and reports "applied". The UI shows green while the host still runs stock code.
//
// The fix marks that combination as "stale" so the user is told the truth.
//
// These tests build the exact situation on a temp tree and assert:
//   - marker + live anchor  => stale
//   - marker only           => applied (not stale)
//   - anchor only           => pending
//   - self-matching patches are NOT reported stale (their anchor is expected to remain)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DSH_SURFACE = "desktop";
const core = await import("../lib/core.js");

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${ok ? "" : ` (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
}

// Build a throwaway aiBase holding exactly one target file we control.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "dshpurge-stale-"));
const pkgDir = path.join(root, "dsh-tool-todo", "lib");
fs.mkdirSync(pkgDir, { recursive: true });

const target = path.join(pkgDir, "index.js");
const patch = core.ALL_PATCHES.find((p) => p.id === 75); // skipIfMarked, REWIND_RESET_TODOS
if (!patch) throw new Error("patch 75 not found");
const marker = patch.markers[0];

/** Write the fixture file and read back what patchStatus reports for patch 75. */
async function statusFor(text) {
  fs.writeFileSync(target, text, "utf8");
  const st = await core.patchStatus(root, [patch]);
  return st[75] ?? st["75"];
}

// Find the real anchor text for this patch so the fixture is faithful.
const reps = Array.isArray(patch.replacements)
  ? patch.replacements
  : (patch.patterns ?? []).map((p) => ({ pattern: p, replace: patch.replace }));
const anchor = typeof reps[0].pattern === "string" ? reps[0].pattern : "";

console.log("--- fixture sanity ---");
check("patch is skipIfMarked", patch.skipIfMarked === true, true);
check("patch has a string anchor", anchor.length > 0, true);
check("patch has a marker", typeof marker === "string" && marker.length > 0, true);

console.log("--- marker only: correctly applied ---");
{
  const st = await statusFor(`// ${marker}\nconst x = 1;\n`);
  check("reports applied", st, "applied");
}

console.log("--- anchor only: still pending ---");
{
  const st = await statusFor(`${anchor}\n`);
  check("reports pending", st, "pending");
}

console.log("--- marker AND anchor: the bug ---");
{
  const st = await statusFor(`// ${marker}\n${anchor}\n`);
  check("reports stale, not applied", st, "stale");
}

console.log("--- empty file: neither ---");
{
  const st = await statusFor("// nothing here\n");
  check("not applied and not stale", st !== "applied" && st !== "stale", true);
}

console.log("--- self-matching patch must not be flagged stale ---");
{
  // Patch 21 replaces a plugin-raised timeout and its replacement contains the
  // anchor text. If the anchor remaining were treated as stale, every correctly
  // applied run would be reported as broken.
  const p21 = core.ALL_PATCHES.find((p) => p.id === 21);
  const rep21 = (p21.replacements || [])[0];
  const selfMatching = rep21 && typeof rep21.pattern === "string"
    ? rep21.replace.includes(rep21.pattern)
    : null;
  if (selfMatching === null) {
    console.log("SKIP (patch 21 uses a regex pattern; static self-match check not applicable)");
  } else {
    check("patch 21 replacement contains its anchor", selfMatching, true);
  }
  // Regardless of patch 21's shape, the engine must not report any patch as stale
  // on a tree where it was just correctly applied.
  const aiBase = process.env.DSH_AI_BASE || "";
  if (aiBase && fs.existsSync(aiBase)) {
    const st = await core.patchStatus(aiBase);
    const staleIds = Object.entries(st).filter(([, v]) => v === "stale").map(([k]) => k);
    check("no stale on a clean upstream tree", staleIds, []);
  } else {
    console.log("SKIP clean-tree check (DSH_AI_BASE unset)");
  }
}

fs.rmSync(root, { recursive: true, force: true });
console.log(failures === 0 ? "\nSTALE DETECTION OK" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
