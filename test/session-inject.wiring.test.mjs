// Integration test: does the per-session toggle actually gate injection?
//
// The unit tests in session-inject.test.mjs cover the state file. This one checks
// the wiring that matters to the user: lib/index.js's rewriteLiveAssembly must
// consult the session record before injecting, and a toggle must apply on the next
// assemble without a restart.
//
// The host's assemble pipeline is not available outside the host, so we assert the
// contract at the boundary: resolveForContext() is what rewriteLiveAssembly calls,
// and the inject text/fallback decision is derived from it.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const si = await import("../lib/session-inject.js");

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${ok ? "" : ` (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "dshpurge-si-int-"));
const home = path.join(root, "home");
fs.mkdirSync(home, { recursive: true });
const ctx = (id) => ({ session: { header: { id } } });

console.log("--- the gate rewriteLiveAssembly uses ---");
{
  // Default off: this is what makes "no injection unless enabled" true.
  check("unknown session gates injection OFF", si.resolveForContext({ dshHome: home, context: ctx("s1") }).enabled, false);

  // Enable, then the very next resolve (same process, no restart) must see it.
  si.setSessionState(home, "s1", { enabled: true, text: "INJECT ME" });
  const afterOn = si.resolveForContext({ dshHome: home, context: ctx("s1") });
  check("next resolve sees enabled (no restart)", afterOn.enabled, true);
  check("inject text reaches the caller", afterOn.text, "INJECT ME");

  // Disable: same session switches back on the next resolve.
  si.setSessionState(home, "s1", { enabled: false });
  check("disable applies on next resolve", si.resolveForContext({ dshHome: home, context: ctx("s1") }).enabled, false);
}

console.log("--- source of the inject text ---");
{
  si.setSessionState(home, "withText", { enabled: true, text: "custom body" });
  si.setSessionState(home, "noText", { enabled: true });
  check("session text wins when present", si.resolveForContext({ dshHome: home, context: ctx("withText") }).text, "custom body");
  // Empty text means rewriteLiveAssembly falls back to prompt-inject.md / rules.
  check("empty text signals fallback", si.resolveForContext({ dshHome: home, context: ctx("noText") }).text, "");
}

console.log("--- isolation across sessions ---");
{
  si.setSessionState(home, "a", { enabled: true });
  si.setSessionState(home, "b", { enabled: false });
  check("a stays on", si.resolveForContext({ dshHome: home, context: ctx("a") }).enabled, true);
  check("b stays off", si.resolveForContext({ dshHome: home, context: ctx("b") }).enabled, false);
  // And an unrecorded session is unaffected by either.
  check("c (unrecorded) off", si.resolveForContext({ dshHome: home, context: ctx("c") }).enabled, false);
}

console.log("--- persistence across a 'restart' (fresh module read) ---");
{
  // Simulate the host restarting: re-read from disk with no in-process cache.
  const fresh = si.readState(home);
  check("a persisted on", fresh.sessions.a.enabled, true);
  check("b persisted off", fresh.sessions.b.enabled, false);
  check("text persisted", fresh.sessions.withText.text, "custom body");
}

console.log("--- wiring exists in lib/index.js ---");
{
  const src = fs.readFileSync(path.join("lib", "index.js"), "utf8");
  check("rewriteLiveAssembly resolves per-session state", /resolveSessionInjection\(globalEnabled, context\)/.test(src), true);
  check("global enable is still the master switch", /globalEnabled\s*&&\s*sessionState\.enabled/.test(src), true);
  check("session text can override the global inject", /sessionText\s*\|\|\s*readInjectFallback/.test(src), true);
  check("cache is invalidated on write", src.includes("invalidateSessionInjectCache"), true);
  check("HTTP route registered", src.includes('path: "/dsh-purge/session-inject"'), true);
}

fs.rmSync(root, { recursive: true, force: true });
console.log(failures === 0 ? "\nSESSION INJECT INTEGRATION OK" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
