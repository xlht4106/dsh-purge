// Tests for per-session injection state.
//
// Injection used to be global: every session got the same prompt, and changing it
// needed a host restart. This adds per-session state so each session can be on or
// off independently, taking effect on the next turn.
//
// The default is OFF (the user's explicit choice), which is why the banner in the
// UI matters — these tests pin the default so it cannot silently flip back to "on"
// and hide the fact that existing sessions lost injection after upgrading.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const mod = await import("../lib/session-inject.js");
const core = await import("../lib/core.js");

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${ok ? "" : ` (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "dshpurge-si-"));
const home = path.join(root, "home");
fs.mkdirSync(home, { recursive: true });

/** Build a minimal assemble context carrying a session id. */
const ctxFor = (id) => ({ session: { header: { id } } });

console.log("--- default is OFF ---");
{
  const state = mod.readState(home);
  check("no file yet -> empty sessions", state.sessions, {});
  check("unknown session resolves disabled", mod.resolveForContext({ dshHome: home, context: ctxFor("nope") }).enabled, false);
  check("unknown session source is default", mod.resolveForContext({ dshHome: home, context: ctxFor("nope") }).source, "default");
}

console.log("--- enable one session, leave another alone ---");
{
  mod.setSessionState(home, "sA", { enabled: true, text: "hello A" });
  check("sA enabled", mod.resolveForContext({ dshHome: home, context: ctxFor("sA") }).enabled, true);
  check("sA carries its text", mod.resolveForContext({ dshHome: home, context: ctxFor("sA") }).text, "hello A");
  check("sB still off (no cross-talk)", mod.resolveForContext({ dshHome: home, context: ctxFor("sB") }).enabled, false);
}

console.log("--- state survives a reload (persisted to disk) ---");
{
  const onDisk = JSON.parse(fs.readFileSync(mod.sessionInjectPath(home), "utf8"));
  check("file has version", onDisk.version, mod.STATE_VERSION);
  check("file has sA", Boolean(onDisk.sessions.sA), true);
  // A fresh read (no cache in this module) must agree.
  check("re-read keeps sA enabled", mod.readState(home).sessions.sA.enabled, true);
}

console.log("--- turning off is immediate and revokes text ---");
{
  mod.setSessionState(home, "sA", { enabled: false });
  const resolved = mod.resolveForContext({ dshHome: home, context: ctxFor("sA") });
  check("sA disabled after toggle", resolved.enabled, false);
  check("text kept for re-enable", resolved.text, "hello A");
}

console.log("--- clearing returns to default ---");
{
  mod.setSessionState(home, "sA", { enabled: true });
  check("cleared returns true", mod.clearSessionState(home, "sA"), true);
  check("record gone", Boolean(mod.readState(home).sessions.sA), false);
  check("resolves disabled again", mod.resolveForContext({ dshHome: home, context: ctxFor("sA") }).enabled, false);
  check("clearing a missing id returns false", mod.clearSessionState(home, "ghost"), false);
}

console.log("--- subagents inherit the parent ---");
{
  mod.setSessionState(home, "parent", { enabled: true, text: "parent text" });
  const child = { session: { header: { id: "child", parentSession: "parent", origin: "subagent" } } };
  const resolved = mod.resolveForContext({ dshHome: home, context: child, isChild: true });
  check("child inherits enabled", resolved.enabled, true);
  check("child inherits text", resolved.text, "parent text");
  check("resolved flags inheritance", resolved.inherited, true);
  check("child reports its own id", resolved.sessionId, "child");
}

console.log("--- unknown session id never inherits ---");
{
  check("missing context disables", mod.resolveForContext({ dshHome: home, context: null }).enabled, false);
  check("no dshHome disables", mod.resolveForContext({ dshHome: "", context: ctxFor("sA") }).enabled, false);
}

console.log("--- corrupt state file is preserved, not deleted ---");
{
  const corruptHome = path.join(root, "corrupt");
  fs.mkdirSync(path.join(corruptHome, "dsh-purge"), { recursive: true });
  const fp = mod.sessionInjectPath(corruptHome);
  fs.writeFileSync(fp, "{ this is not json", "utf8");

  let reported = null;
  const state = mod.readState(corruptHome, { onCorrupt: (info) => { reported = info; } });
  check("falls back to empty", state.sessions, {});
  check("marks corrupt", state.corrupt, true);
  check("original bytes preserved in .corrupt", fs.readFileSync(`${fp}.corrupt`, "utf8"), "{ this is not json");
  check("corruption reported", Boolean(reported && reported.backup), true);
  check("file still on disk (not deleted)", fs.existsSync(fp), true);
}

console.log("--- atomic write leaves no temp files ---");
{
  mod.setSessionState(home, "tmpcheck", { enabled: true });
  const dir = path.join(home, "dsh-purge");
  const leftovers = fs.readdirSync(dir).filter((n) => n.endsWith(".tmp"));
  check("no .tmp leftovers", leftovers, []);
}

console.log("--- write rejects empty session id ---");
{
  let threw = false;
  try { mod.setSessionState(home, "  ", { enabled: true }); } catch { threw = true; }
  check("empty id throws", threw, true);
}

console.log("--- summary counts ---");
{
  mod.setSessionState(home, "on1", { enabled: true });
  mod.setSessionState(home, "on2", { enabled: true });
  mod.setSessionState(home, "off1", { enabled: false });
  const sum = mod.summarize(home);
  check("total counts every record", sum.total >= 3, true);
  check("enabled counted", sum.enabled >= 2, true);
  check("disabled counted", sum.disabled >= 1, true);
  check("rows have ids", sum.sessions.every((r) => typeof r.id === "string"), true);
}

fs.rmSync(root, { recursive: true, force: true });
console.log(failures === 0 ? "\nSESSION INJECT OK" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
