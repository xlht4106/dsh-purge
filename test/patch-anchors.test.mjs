// Acceptance gate for the DSH 0.2.1-rc.2 adaptation.
//
// The engine applies ALL_PATCHES in array order, accumulating edits on the same
// file. So a patch's anchor may legitimately only appear AFTER an earlier patch
// ran (#32 turns the identity sentence into "local web GUI", #53 then collapses
// it). Verifying each patch against the pristine text would report false failures.
//
// This script replays the real order per target file and asserts, for every patch
// that declares the file, that either its anchor hit or its marker is present.
import fs from "node:fs";

const aiBase = process.env.DSH_AI_BASE || "";
if (!aiBase || !fs.existsSync(aiBase)) {
  console.log("SKIP: DSH_AI_BASE 未设置或不存在，跳过锚点验证");
  process.exit(0);
}
process.env.DSH_SURFACE = "desktop";

const core = await import("../lib/core.js");
const files = core.targetFiles(aiBase);

const asList = (v) => (Array.isArray(v) ? v : [v]).filter(Boolean);
const asLf = (s) => String(s ?? "").replace(/\r\n/g, "\n");

function hasPattern(text, pattern) {
  if (pattern instanceof RegExp) {
    const re = new RegExp(pattern.source, pattern.flags.replace(/g|y/g, ""));
    return re.test(text);
  }
  return text.includes(asLf(pattern));
}

// Which patches claim which file, in engine order.
const byFile = new Map();
for (const patch of core.ALL_PATCHES) {
  if (!core.patchAppliesHere(patch, "desktop")) continue;
  for (const key of asList(patch.file)) {
    for (const fp of asList(files[key])) {
      if (!byFile.has(fp)) byFile.set(fp, []);
      byFile.get(fp).push({ patch, key });
    }
  }
}

const only = process.argv.slice(2).map(Number);
let failures = 0;

// Engine semantics: a patch counts as applied when at least one of its files
// settled. Track per (patch, file) first, then aggregate.
const perPatch = new Map();

for (const [fp, entries] of byFile) {
  let text = asLf(fs.readFileSync(fp, "utf8"));
  const short = fp.replace(aiBase, "…");
  for (const { patch, key } of entries) {
    const reps = Array.isArray(patch.replacements)
      ? patch.replacements
      : (patch.patterns ?? []).map((p) => ({ pattern: p, replace: patch.replace }));
    const anchorBefore = reps.some((r) => hasPattern(text, r.pattern));
    const result = core.applyReplacementsToText(text, patch, fp);
    const markerAfter = asList(patch.markers).some((m) => hasPattern(result.text, m));
    const settled = result.changed || markerAfter;

    if (!perPatch.has(patch.id)) perPatch.set(patch.id, { patch, rows: [] });
    perPatch.get(patch.id).rows.push({ key, short, anchorBefore, changed: result.changed, markerAfter, settled });
    text = result.text;
  }
}

// Restore-type patches put an upstream file BACK to its official shape. On a
// pristine tree there is nothing to restore, so they are expected to be unsettled
// and must not count as failures.
//
// #90 / #91 came in with the upstream 0.2.0 work: they fold systemPrompt into the
// provider's *native* system slot and only have anchors once the plugin's own older
// edits (or a patched pi-ai) are present. On a clean host tree there is nothing to
// rewrite, so they are restore-style here too.
//
// #88 was renamed by upstream from HUNG_PROMPT_STRICT_NEEDLE to HUNG_PROMPT_REMOVED:
// it no longer tightens a hang needle but removes the post-renderPrompt hang entirely,
// so its anchors no longer exist on a clean 0.2.1 tree by design.
const RESTORE_TYPE = new Map([
  [21, "BASH_TIMEOUT_RESTORE: 还原插件曾延长的 timeoutMs"],
  [80, "MINIMAL_OFFICIAL_TOOLSET: 还原插件曾追加的 fs/web 工具行"],
  [88, "HUNG_PROMPT_REMOVED: 移除挂针，干净树上本就没有可移除的挂针"],
  [90, "OPENAI_NATIVE_SYSTEM_ROLE: 仅当插件旧改动存在时才有锚点"],
  [91, "ANTHROPIC_NATIVE_PARAMS_SYSTEM: 仅当插件旧改动存在时才有锚点"],
]);

const unsettled = [];
for (const [id, { patch, rows }] of [...perPatch].sort((a, b) => a[0] - b[0])) {
  const anySettled = rows.some((r) => r.settled);
  const wanted = only.length === 0 || only.includes(id);
  if (!anySettled) unsettled.push({ id, name: patch.name, rows, optional: patch.optional });
  if (wanted && !anySettled && !RESTORE_TYPE.has(id)) {
    failures += 1;
    console.log(`FAIL #${id} ${patch.name} (optional=${patch.optional})`);
    for (const r of rows) {
      console.log(
        `     ${r.key} @ ${r.short} anchor=${r.anchorBefore} changed=${r.changed} marker=${r.markerAfter}`,
      );
    }
  } else if (wanted) {
    const hits = rows.filter((r) => r.settled).map((r) => r.key).join(",");
    if (RESTORE_TYPE.has(id)) console.log(`skip #${id} ${RESTORE_TYPE.get(id)}（纯净树无事可做）`);
    else console.log(`ok   #${id} ${patch.name} settled via [${hits}]`);
  }
}

const realUnsettled = unsettled.filter((u) => !RESTORE_TYPE.has(u.id));
console.log(`\npatches=${perPatch.size} unsettled=${unsettled.length} restore-type=${unsettled.length - realUnsettled.length} failures=${failures}`);
if (realUnsettled.length > 0) {
  console.log("unexpected unsettled:", realUnsettled.map((u) => `#${u.id} ${u.name}`).join(" | "));
}
process.exit(failures === 0 ? 0 : 1);
