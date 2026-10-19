// Tests for hindsight coexistence detection.
//
// Builds throwaway profile directories to exercise every state the probe can
// report, so the settings panel and `--status` never have to guess. Uses only the
// filesystem — no network, no real DSH install.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const mod = await import("../lib/hindsight-compat.js");
const PKG = "@vectorize-io/hindsight-coding-agents";

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(
    `${ok ? "PASS" : "FAIL"} ${label}${ok ? "" : ` (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`,
  );
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "dshpurge-hs-"));

/** Create a profile with the given hindsight installation shape. */
function makeProfile(name, { version, inBundles = true, dependency = true, disabled = false, patchText = "" } = {}) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });

  const pkg = {
    name: `dsh-profile-${name}`,
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: ["@deepseek-ai/dsh-base"] } },
  };
  if (dependency) pkg.dependencies[PKG] = "^0.8.1";
  if (inBundles) pkg.dsh.profile.bundles.push(PKG);
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(pkg, null, 2));

  if (version) {
    const modDir = path.join(dir, "node_modules", ...PKG.split("/"));
    fs.mkdirSync(modDir, { recursive: true });
    fs.writeFileSync(
      path.join(modDir, "package.json"),
      JSON.stringify({ name: PKG, version }, null, 2),
    );
  }
  if (patchText) fs.writeFileSync(path.join(dir, "cordis.patch.yml"), patchText);
  return dir;
}

console.log("--- healthy install ---");
{
  const dir = makeProfile("ok", { version: "0.8.1" });
  const r = mod.hindsightReport(dir);
  check("state", r.state, "ok");
  check("installed", r.installed, true);
  check("inBundles", r.inBundles, true);
  check("verified", r.verified, true);
  check("version", r.version, "0.8.1");
}

console.log("--- newer but still verified ---");
{
  const dir = makeProfile("ok2", { version: "0.8.2" });
  const r = mod.hindsightReport(dir);
  check("0.8.2 verified", r.verified, true);
  check("0.8.2 state", r.state, "ok");
}

console.log("--- unverified version is reported, not hidden ---");
{
  const dir = makeProfile("newer", { version: "0.9.0" });
  const r = mod.hindsightReport(dir);
  check("still loads (state ok)", r.state, "ok");
  check("but not marked verified", r.verified, false);
  check("note mentions the range", /outside the verified range/.test(r.note), true);
}

console.log("--- declared but node_modules missing ---");
{
  const dir = makeProfile("missing", { version: "" });
  const r = mod.hindsightReport(dir);
  check("state", r.state, "not-installed");
  check("note mentions pnpm install", /pnpm install/.test(r.note), true);
}

console.log("--- installed but the bundle row was dropped ---");
{
  const dir = makeProfile("unmounted", { version: "0.8.1", inBundles: false });
  const r = mod.hindsightReport(dir);
  check("state", r.state, "not-mounted");
  check("inBundles", r.inBundles, false);
  check("note explains it will not load", /will not load/.test(r.note), true);
}

console.log("--- explicitly disabled in the profile patch layer ---");
{
  const patch = [
    "# user override",
    "- id: hindsight",
    "  disabled: true",
  ].join("\n");
  const dir = makeProfile("disabled", { version: "0.8.1", patchText: patch });
  const r = mod.hindsightReport(dir);
  check("state", r.state, "disabled");
  check("disabled flag", r.disabled, true);
}

console.log("--- disabled:false must not be mistaken for disabled ---");
{
  const patch = ["- id: hindsight", "  disabled: false"].join("\n");
  const dir = makeProfile("not-disabled", { version: "0.8.1", patchText: patch });
  const r = mod.hindsightReport(dir);
  check("state", r.state, "ok");
  check("disabled flag", r.disabled, false);
}

console.log("--- a different row's disabled:true must not leak ---");
{
  const patch = ["- id: some-other-plugin", "  disabled: true"].join("\n");
  const dir = makeProfile("other-disabled", { version: "0.8.1", patchText: patch });
  const r = mod.hindsightReport(dir);
  check("state", r.state, "ok");
  check("disabled flag", r.disabled, false);
}

console.log("--- no profile at all ---");
{
  const r = mod.hindsightReport(path.join(root, "does-not-exist"));
  check("state", r.state, "absent");
  check("installed", r.installed, false);
}

console.log("--- preservation check (the #43 invariant) ---");
{
  const dir = makeProfile("preserve", { version: "0.8.1" });
  const before = mod.hindsightReport(dir);
  // Simulate an apply that (correctly) leaves the profile untouched.
  const same = mod.checkHindsightPreserved(dir, before);
  check("unchanged profile passes", same.ok, true);
  check("no fields flagged", same.changed, []);

  // Simulate the regression this guards against: the bundle row disappears.
  const pkgPath = path.join(dir, "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  pkg.dsh.profile.bundles = pkg.dsh.profile.bundles.filter((b) => b !== PKG);
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
  const after = mod.checkHindsightPreserved(dir, before);
  check("dropped bundle row detected", after.ok, false);
  check("bundles flagged", after.changed.includes("bundles"), true);
}

fs.rmSync(root, { recursive: true, force: true });
console.log(failures === 0 ? "\nHINDSIGHT COMPAT OK" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
