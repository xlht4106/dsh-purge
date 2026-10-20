// Tests for the `{{cwd}}` prompt-variable registration (issues #114 / #136).
//
// On dsh 0.2.1 the agent loop stopped registering `cwd`, but our personaSuffix and
// CWD_ONLY_SUFFIX still reference it. renderPrompt() throws on an unregistered
// variable, so every turn died before any model request — while the clean panel
// stayed green, because the patches themselves applied fine.
//
// These tests pin the behaviour that keeps that from happening again:
//   - on a host without `cwd`, we register one;
//   - on a host that already has it (0.2.0), we leave it alone;
//   - the value follows the workingDirectory service, per session;
//   - failures never throw out of install (that would take the plugin down).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const mod = await import("../lib/prompt-variables.js");

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${ok ? "" : ` (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
}

/** Fake systemPrompt service recording variable registrations. */
function fakeSystemPrompt({ existing = null } = {}) {
  const registry = new Map();
  if (existing) registry.set(existing.name, existing.provider);
  return {
    registry,
    layers: { variables: registry },
    variable(name, provider) {
      if (registry.has(name)) throw new Error(`duplicate variable ${name}`);
      registry.set(name, provider);
    },
  };
}

console.log("--- 0.2.1 host: no cwd registered ---");
{
  const sp = fakeSystemPrompt();
  const outcome = mod.installCwdVariable({ systemPrompt: sp });
  check("reports registered", outcome, "registered");
  check("cwd is present", sp.registry.has("cwd"), true);
  check("provider is a function", typeof sp.registry.get("cwd"), "function");
}

console.log("--- 0.2.0 host: cwd already registered by the host ---");
{
  const hostProvider = () => "/from-host";
  const sp = fakeSystemPrompt({ existing: { name: "cwd", provider: hostProvider } });
  const outcome = mod.installCwdVariable({ systemPrompt: sp });
  check("reports already", outcome, "already");
  check("host provider untouched", sp.registry.get("cwd"), hostProvider);
}

console.log("--- value follows workingDirectory per session ---");
{
  const sp = fakeSystemPrompt();
  const sessions = new Map([
    ["s1", "/work/one"],
    ["s2", "/work/two"],
  ]);
  const workingDirectory = {
    get(session) {
      return sessions.get(session);
    },
  };
  mod.installCwdVariable({ systemPrompt: sp }, { workingDirectory });
  const provider = sp.registry.get("cwd");

  check("session 1 resolves", provider({ session: "s1" }), "/work/one");
  check("session 2 resolves", provider({ session: "s2" }), "/work/two");
  // agent-shaped context (what the host actually passes)
  check("agent context resolves", provider({ agent: { session: "s2" } }), "/work/two");
}

console.log("--- workingDirectory throws: falls back, does not propagate ---");
{
  const sp = fakeSystemPrompt();
  const workingDirectory = {
    get() {
      throw new Error("session shape rejected");
    },
  };
  mod.installCwdVariable({ systemPrompt: sp }, { workingDirectory });
  const provider = sp.registry.get("cwd");
  let value;
  try {
    value = provider({ session: "x" });
  } catch (e) {
    value = `THREW: ${e.message}`;
  }
  check("returns a string instead of throwing", typeof value, "string");
  check("falls back to process.cwd()", value, process.cwd());
}

console.log("--- no systemPrompt service: reports unavailable, does not throw ---");
{
  check("empty ctx", mod.installCwdVariable({}), "unavailable");
  check("null ctx", mod.installCwdVariable(null), "unavailable");
  check("service without variable()", mod.installCwdVariable({ systemPrompt: {} }), "unavailable");
}

console.log("--- duplicate registration race is swallowed ---");
{
  // registry claims no `cwd`, but the service still rejects the insert.
  const sp = {
    layers: { variables: new Map() },
    variable() {
      throw new Error("layers conflict");
    },
  };
  let outcome;
  try {
    outcome = mod.installCwdVariable({ systemPrompt: sp });
  } catch (e) {
    outcome = `THREW: ${e.message}`;
  }
  check("returns unavailable instead of throwing", outcome, "unavailable");
}

console.log("--- integration: the real 0.2.1 tree still lacks cwd ---");
{
  const aiBase = process.env.DSH_AI_BASE || "";
  const loopPath = aiBase
    ? path.join(aiBase, "dsh-agent-loop", "lib", "index.js")
    : "";
  if (!aiBase || !fs.existsSync(loopPath)) {
    console.log("SKIP (DSH_AI_BASE unset)");
  } else {
    const src = fs.readFileSync(loopPath, "utf8");
    const registersCwd = /systemPrompt\.variable\(\s*["']cwd["']/.test(src);
    // If the host ever starts registering cwd again, our registration becomes a
    // no-op via the "already" branch — but this assertion documents why we exist.
    console.log(`     host registers cwd itself: ${registersCwd}`);
    check("0.2.1 host does not register cwd (our fix is still needed)", registersCwd, false);
  }
}

console.log(failures === 0 ? "\nPROMPT VARIABLES OK" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
