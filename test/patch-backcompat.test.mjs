// Backward-compatibility guard for the 0.2.1 adaptation.
//
// The #32/#53 fixes widened their file list to include "harness-dev-context".
// On 0.2.0 that package does not exist, so firstExisting must yield "" and the
// patches must still settle through the legacy "web-app-lib" anchors. If a future
// edit drops the legacy anchors, 0.2.0 users would silently lose the patch.
//
// Strategy: copy a pristine 0.2.1 tree to a temp dir, delete the new package to
// emulate 0.2.0, restore the *old* upstream sentences into dsh-web-app/lib, and
// assert #32/#53 still settle.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SRC = process.env.DSH_AI_BASE || "";
if (!SRC || !fs.existsSync(SRC)) {
  console.log("SKIP: DSH_AI_BASE 未设置或不存在，跳过 0.2.0 向后兼容验证");
  process.exit(0);
}
process.env.DSH_SURFACE = "desktop";
const core = await import("../lib/core.js");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dshpurge-020-"));

// Shallow-copy only what targetFiles needs.
fs.cpSync(SRC, tmp, { recursive: true, filter: (src) => !src.includes("dsh-harness-dev-context") });
fs.rmSync(path.join(tmp, "dsh-harness-dev-context"), { recursive: true, force: true });

const webAppLib = path.join(tmp, "dsh-web-app", "lib", "index.js");
let text = fs.readFileSync(webAppLib, "utf8");

// Rewrite the 0.2.1 sentences back into their 0.2.0 forms.
const restored = text
  .replace(
    "You are interacting with the user through the DeepSeek Harness Web GUI whose URL the runtime context names.",
    "You are interacting with the user through the DeepSeek Harness Web GUI at ${webUrl}.",
  )
  .replace(
    "Advertised URL of the DeepSeek Harness Web GUI serving this session.",
    "Canonical local URL of the DeepSeek Harness Web GUI serving this session.",
  );
if (restored === text) {
  console.log("SKIP: could not find 0.2.1 sentences in web-app/lib to downgrade");
  process.exit(2);
}
fs.writeFileSync(webAppLib, restored, "utf8");

const files = core.targetFiles(tmp);
const devCtx = files["harness-dev-context"];
const webApp = files["web-app-lib"];
console.log("harness-dev-context resolved to:", JSON.stringify(devCtx), "(expected empty on 0.2.0)");
console.log("web-app-lib resolved to:", webApp ? "ok" : "MISSING");

const asLf = (s) => String(s ?? "").replace(/\r\n/g, "\n");
const asList = (v) => (Array.isArray(v) ? v : [v]).filter(Boolean);
const hasPattern = (t, p) =>
  p instanceof RegExp
    ? new RegExp(p.source, p.flags.replace(/g|y/g, "")).test(t)
    : t.includes(asLf(p));

let textNow = asLf(fs.readFileSync(webApp, "utf8"));
let failures = 0;
for (const id of [32, 53]) {
  const patch = core.ALL_PATCHES.find((p) => p.id === id);
  const result = core.applyReplacementsToText(textNow, patch, webApp);
  const marker = asList(patch.markers).some((m) => hasPattern(result.text, m));
  // #53 only collapses what #32 already rewrote, so on the second pass it may be a
  // no-op with the marker already present. Settled == changed OR marker.
  const ok = result.changed || marker;
  if (!ok) failures += 1;
  console.log(
    `${ok ? "PASS" : "FAIL"} #${id} ${patch.name} changed=${result.changed} marker=${marker}`,
  );
  textNow = result.text;
}

// firstExisting() returns "" when nothing matches; targetFiles may also leave the
// key out entirely. Either way the key must not point at a real file.
if (devCtx) {
  failures += 1;
  console.log("FAIL harness-dev-context should not resolve on a 0.2.0 tree");
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures === 0 ? "\nBACKWARD COMPAT OK" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
