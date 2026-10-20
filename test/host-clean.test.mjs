// Tests for the post-apply host check (issues #132 / #142).
//
// Symptom users hit: on dsh 0.2.1-rc.2, clicking Apply always ended with
// 「失败：清洗没有写进全部宿主，已取消重启」 and the desktop never restarted —
// even though the patches had in fact been written correctly.
//
// Root cause: patch #40 stamps a version-specific comment, and the check only knew
// two of the three spellings. On 0.2.1 the file carried
// "[dsh-purge] every mode keeps system inject", which the check did not recognise,
// so it fell through to a structural test that also matched the *patched* text.
import fs from "node:fs";
import path from "node:path";

const hc = await import("../lib/host-clean.js");
const core = await import("../lib/core.js");

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${ok ? "" : ` (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
}

const ASSEMBLE = "this.ctx.waterfall(scopeTarget(this, scope), \"system-prompt/assemble\", ...)";

console.log("--- every marker spelling is recognised ---");
for (const marker of [
  "[dsh-purge] complete prompt keeps inject",
  "[dsh-purge] complete prompt keeps waterfall inject",
  "[dsh-purge] every mode keeps system inject",
]) {
  check(marker.slice(13), hc.hostPromptKeepsInject(`${ASSEMBLE}\n// ${marker}\n`), true);
}

console.log("--- pristine host: not patched ---");
{
  const pristine = [
    ASSEMBLE,
    "if (completeSection === void 0 && !runtimeContextSuppressed) return transformed;",
    "sections: completeSection === void 0 ? transformed.sections : [completeSection],",
    'text: "You are an AI agent powered by DeepSeek Harness."',
  ].join("\n");
  check("unpatched file reports false", hc.hostPromptKeepsInject(pristine), false);
}

console.log("--- not this module ---");
{
  check("empty", hc.hostPromptKeepsInject(""), false);
  check("unrelated file", hc.hostPromptKeepsInject("export const x = 1;"), false);
}

console.log("--- marker present but shape still dropping: marker wins ---");
{
  // A half-applied file: the comment landed but the old shape survived. The marker
  // is the plugin's own statement that it rewrote this, so trust it.
  const half = `${ASSEMBLE}\n// [dsh-purge] every mode keeps system inject\nsections: completeSection === void 0 ? transformed.sections : [completeSection],`;
  check("marker present", hc.hostPromptKeepsInject(half), true);
}

console.log("--- identity stripped, shape gone ---");
{
  const text = `${ASSEMBLE}\n// [dsh-purge] identity stripped\nconst requiredContexts = new Set([]);`;
  check("no dropping shape, no identity left", hc.hostPromptKeepsInject(text), true);
}

console.log("--- real 0.2.1 tree: before vs after patch 40 ---");
{
  const aiBase = process.env.DSH_AI_BASE || "";
  const file = aiBase ? path.join(aiBase, "dsh-system-prompt", "lib", "index.js") : "";
  if (!aiBase || !fs.existsSync(file)) {
    console.log("SKIP (DSH_AI_BASE unset)");
  } else {
    const src = fs.readFileSync(file, "utf8");
    const patch = core.ALL_PATCHES.find((p) => p.id === 40);
    const applied = core.applyReplacementsToText(src, patch, file);

    check("pristine 0.2.1 reports unpatched", hc.hostPromptKeepsInject(src), false);
    check("patch 40 actually changes the file", applied.changed, true);
    check("after patch reports patched", hc.hostPromptKeepsInject(applied.text), true);

    const why = hc.explainHostPromptState(applied.text);
    check("diagnostics say keeps", why.keeps, true);
    check("diagnostics list a marker", why.markers.length > 0, true);
    console.log(`     markers found: ${JSON.stringify(why.markers)}`);
  }
}

console.log(failures === 0 ? "\nHOST CLEAN OK" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
