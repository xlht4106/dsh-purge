// Newline-fidelity tests for applyReplacementsToText().
//
// Rewriting a host file must not normalise its line endings: a whole-file EOL flip
// turns the .dshpurge.bak diff into "everything changed", which makes
// refreshStaleBaksForUpgrade() believe the upstream file was replaced.
//
// Three cases matter:
//   lf     -> stays lf
//   crlf   -> stays crlf
//   mixed  -> each line keeps its own ending (the hard one)
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

// A tiny patch whose anchor we control.
const patch = {
  id: 999,
  name: "EOL_TEST",
  file: ["fixture"],
  replacements: [{ pattern: "ORIGINAL_TEXT", replace: "REPLACED_TEXT" }],
  markers: ["REPLACED_TEXT"],
};

console.log("--- pure LF ---");
{
  const src = "line one\nORIGINAL_TEXT\nline three\n";
  const r = core.applyReplacementsToText(src, patch, "fixture.js");
  check("changed", r.changed, true);
  check("no CR introduced", r.text.includes("\r"), false);
  check("replacement applied", r.text.includes("REPLACED_TEXT"), true);
}

console.log("--- pure CRLF ---");
{
  const src = "line one\r\nORIGINAL_TEXT\r\nline three\r\n";
  const r = core.applyReplacementsToText(src, patch, "fixture.js");
  check("changed", r.changed, true);
  check("all endings stay CRLF", (r.text.match(/(?<!\r)\n/g) || []).length, 0);
  check("CRLF count preserved", (r.text.match(/\r\n/g) || []).length, 3);
  check("replacement applied", r.text.includes("REPLACED_TEXT"), true);
}

console.log("--- mixed CRLF/LF: each line keeps its own ending ---");
{
  // Line 1 CRLF, line 2 LF, line 3 CRLF, line 4 LF.
  const src = "alpha\r\nORIGINAL_TEXT\nomega\r\ntail\n";
  const r = core.applyReplacementsToText(src, patch, "fixture.js");
  check("changed", r.changed, true);
  check("replacement applied", r.text.includes("REPLACED_TEXT"), true);
  // Reconstruct the per-line ending shape and compare to the input's shape.
  const ends = (t) => t.split("\n").slice(0, -1).map((line) => (line.endsWith("\r") ? "crlf" : "lf"));
  check("per-line endings preserved", ends(r.text), ends(src));
  check("CRLF count unchanged", (r.text.match(/\r\n/g) || []).length, (src.match(/\r\n/g) || []).length);
}

console.log("--- mixed, replacement spans the LF line ---");
{
  const src = "alpha\r\nORIGINAL_TEXT\r\nomega\n";
  const r = core.applyReplacementsToText(src, patch, "fixture.js");
  const ends = (t) => t.split("\n").slice(0, -1).map((line) => (line.endsWith("\r") ? "crlf" : "lf"));
  check("per-line endings preserved", ends(r.text), ends(src));
}

console.log("--- no match: text untouched ---");
{
  const src = "nothing to see\r\nhere\n";
  const r = core.applyReplacementsToText(src, patch, "fixture.js");
  check("not changed", r.changed, false);
  check("bytes identical", r.text, src);
}

console.log("--- idempotent: applying twice equals applying once ---");
{
  const src = "alpha\r\nORIGINAL_TEXT\nomega\r\n";
  const once = core.applyReplacementsToText(src, patch, "fixture.js");
  const twice = core.applyReplacementsToText(once.text, patch, "fixture.js");
  check("second pass is a no-op", twice.changed, false);
  check("text stable", twice.text, once.text);
}

console.log("--- real host file: endings survive a real patch ---");
{
  const aiBase = process.env.DSH_AI_BASE || "";
  if (!aiBase || !fs.existsSync(aiBase)) {
    console.log("SKIP real-file check (DSH_AI_BASE unset)");
  } else {
    const files = core.targetFiles(aiBase);
    const raw = files["tool-todo"];
    // targetFiles may hand back a list for keys with several candidates.
    const fp = Array.isArray(raw) ? raw.find((p) => p && fs.existsSync(p)) : raw;
    if (!fp) {
      console.log("SKIP real-file check (tool-todo not found)");
    } else {
      const src = fs.readFileSync(fp, "utf8");
      const p = core.ALL_PATCHES.find((x) => x.id === 75);
      const r = core.applyReplacementsToText(src, p, fp);
      const countCrlf = (t) => (t.match(/\r\n/g) || []).length;
      const countLf = (t) => (t.match(/(?<!\r)\n/g) || []).length;
      // A patch legitimately adds or removes lines, so raw counts are not the
      // invariant. What must hold is that the file's EOL *style* is untouched:
      // an LF-only file stays LF-only (no CR introduced), a CRLF-only file stays
      // CRLF-only (no bare LF introduced).
      if (countCrlf(src) === 0) {
        check("real file: LF-only stays LF-only", countCrlf(r.text), 0);
      } else if (countLf(src) === 0) {
        check("real file: CRLF-only stays CRLF-only", countLf(r.text), 0);
      } else {
        check("real file: mixed file keeps both styles", countCrlf(r.text) > 0 && countLf(r.text) > 0, true);
      }
    }
  }
}

console.log(failures === 0 ? "\nEOL OK" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
