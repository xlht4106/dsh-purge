// Verify that prompt content is picked up WITHOUT a host restart.
//
// The user asked why "Apply" needs a restart. The answer differs by what changed:
//   - host patches (86 of them) rewrite files the process already imported -> restart
//   - prompt / rules / session toggle are read from disk per turn -> no restart
//
// This test pins the second half: change the prompt file, re-read, and confirm the
// new text is visible without any restart.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const core = await import("../lib/core.js");

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${ok ? "" : ` (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "dshpurge-hot-"));
const home = path.join(root, "home");
fs.mkdirSync(home, { recursive: true });

const injectPath = core.findOverrideFile(home);
console.log("prompt file:", injectPath);

console.log("--- write prompt, read it back (same process) ---");
{
  fs.mkdirSync(path.dirname(injectPath), { recursive: true });
  fs.writeFileSync(injectPath, "PROMPT VERSION ONE", "utf8");
  check("first read sees v1", core.readPromptInjectFileSync(home), "PROMPT VERSION ONE");
}

console.log("--- change it, read again with NO restart ---");
{
  // Bump mtime forward so any mtime-based throttle sees a genuine change.
  fs.writeFileSync(injectPath, "PROMPT VERSION TWO", "utf8");
  const later = new Date(Date.now() + 1000);
  fs.utimesSync(injectPath, later, later);
  check("second read sees v2 (no restart)", core.readPromptInjectFileSync(home), "PROMPT VERSION TWO");
}

console.log("--- mtime throttle is short (200ms), not a restart ---");
{
  const src = fs.readFileSync(path.join("lib", "index.js"), "utf8");
  check("throttle window is 200ms", /HUNG_CACHE_MS\s*=\s*200/.test(src), true);
  // The cache key includes mtime, so a changed file invalidates it immediately.
  check("cache keyed on mtime", /hungCache\.mtime\s*===\s*mtimeBefore/.test(src), true);
  check("cache keyed on home", /hungCache\.home\s*===\s*home/.test(src), true);
}

console.log("--- which changes DO need a restart ---");
{
  const policy = await import("../lib/settle-policy.js");
  // Host patches touch files already imported by the running process.
  check("apply restarts when patches were written", policy.applyShouldRestart({ appliedCount: 1 }), true);
  check("sealed asar always restarts (cannot swap in-process)", policy.applyShouldRestart({ sealed: true }), true);
  check("no patch, no prompt -> no restart", policy.applyShouldRestart({ appliedCount: 0, promptReady: false }), false);
}

console.log("--- prompt-only change no longer forces a restart ---");
{
  const policy = await import("../lib/settle-policy.js");
  // The prompt is read per turn (200ms mtime throttle), so rewriting it does not
  // need a restart. This is the behaviour the user asked about.
  check(
    "prompt-only, hot -> no restart",
    policy.applyShouldRestart({ appliedCount: 0, promptIsHot: true }),
    false,
  );
  check("...reason says so", policy.restartReason({ appliedCount: 0, promptIsHot: true }), "none-prompt-hot");

  // Patches still win over the hot prompt: they changed imported module code.
  check(
    "patches + hot prompt -> still restarts",
    policy.applyShouldRestart({ appliedCount: 3, promptIsHot: true }),
    true,
  );
  check("...reason is patches-written", policy.restartReason({ appliedCount: 3, promptIsHot: true }), "patches-written");

  // A sealed asar always restarts regardless.
  check(
    "sealed + hot prompt -> restarts",
    policy.applyShouldRestart({ sealed: true, promptIsHot: true }),
    true,
  );
  check("...reason is sealed-asar", policy.restartReason({ sealed: true, promptIsHot: true }), "sealed-asar");

  // Old callers that do not pass promptIsHot keep the previous semantics.
  check(
    "legacy promptReady still restarts",
    policy.applyShouldRestart({ appliedCount: 0, promptReady: true }),
    true,
  );
}

console.log("--- lib/index.js passes promptIsHot ---");
{
  const src = fs.readFileSync(path.join("lib", "index.js"), "utf8");
  check("computes promptIsHot from applied count", /promptIsHot\s*=\s*summary\.applied\s*===\s*0/.test(src), true);
  check("passes promptIsHot to the policy", /promptIsHot,/.test(src), true);
  check("logs the restart reason", /restartReason\(/.test(src), true);
}

console.log("--- session injection is also hot ---");
{
  const si = await import("../lib/session-inject.js");
  si.setSessionState(home, "s1", { enabled: true, text: "A" });
  check("toggle visible immediately", si.resolveForContext({ dshHome: home, context: { session: { header: { id: "s1" } } } }).enabled, true);
  si.setSessionState(home, "s1", { enabled: false });
  check("revoke visible immediately", si.resolveForContext({ dshHome: home, context: { session: { header: { id: "s1" } } } }).enabled, false);
}

fs.rmSync(root, { recursive: true, force: true });
console.log(failures === 0 ? "\nHOT RELOAD OK" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
