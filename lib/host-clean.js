/**
 * Post-apply sanity check on the host's system-prompt module.
 *
 * The question this answers is narrow and important: after Apply, does the host
 * still drop our injected sections? If the answer is "yes", the plugin refuses to
 * restart (「清洗没有写进全部宿主，已取消重启」) because restarting would leave the
 * user with a half-patched host.
 *
 * History — why the marker list keeps growing
 * -------------------------------------------
 * Patch #40 rewrites `SystemPrompt.assemble()` so the `complete` preset keeps the
 * plugin's sections. The rewrite has been re-expressed several times as the host
 * changed, and each version stamps a different comment:
 *
 *   "[dsh-purge] complete prompt keeps inject"                  (early)
 *   "[dsh-purge] complete prompt keeps waterfall inject"        (0.2.0)
 *   "[dsh-purge] every mode keeps system inject"                (0.2.1)
 *
 * On dsh 0.2.1 the produced marker was the third one, which this check did not
 * know about. Result: the file WAS correctly patched, but the check reported it as
 * unpatched, so Apply always ended in "清洗没有写进全部宿主，已取消重启" and the
 * desktop never restarted (issues #132 / #142).
 *
 * The lesson: never hard-code one marker spelling. Accept every marker the current
 * patch table can produce, and fall back to structural checks.
 */

/** Every `[dsh-purge]` marker patch #40 may leave behind, across host versions. */
const INJECT_MARKERS = [
  "[dsh-purge] complete prompt keeps inject",
  "[dsh-purge] complete prompt keeps waterfall inject",
  "[dsh-purge] every mode keeps system inject",
];

/** Marker written by the identity-stripping patch (#25). */
const IDENTITY_MARKER = "[dsh-purge] identity stripped";

/**
 * Does the host prompt module keep our injected sections?
 *
 * @param {string} text contents of the host's dsh-system-prompt/lib/index.js
 * @returns {boolean} true when the module is patched (or no longer drops inject)
 */
export function hostPromptKeepsInject(text) {
  const body = String(text || "");

  // 1. Explicit markers: the strongest signal, when the patch wrote one.
  const injectMarked = INJECT_MARKERS.some((marker) => body.includes(marker));
  const identityMarked = body.includes(IDENTITY_MARKER);
  if (injectMarked) return true;
  // Identity alone is not enough to prove the inject fix landed, but it does prove
  // the file was touched by us — fall through to the structural checks.

  // 2. Not this module at all (empty file, wrong path, failed read).
  if (!body.includes("system-prompt/assemble")) return false;

  // 3. Structural: is the section-dropping code still present?
  //
  // 0.2.0 and earlier returned `sections: ... : [completeSection]` when a complete
  // preset was active, discarding everything the waterfall added. 0.2.1 kept that
  // shape but also introduced `requiredContexts`; the patch rewrites both. Checking
  // for the raw shape alone therefore produces a false negative on 0.2.1 — which is
  // exactly what happened. So: only call it "dropping" when the shape appears
  // WITHOUT our rewrite marker nearby.
  const dropsInjectShape = body.includes("transformed.sections : [completeSection]");
  const identityLeft = body.includes("You are an AI agent powered by DeepSeek Harness.");

  if (identityMarked && !dropsInjectShape) return true;
  if (!dropsInjectShape && !identityLeft) return true;
  return false;
}

/**
 * Diagnostics for `--status` / logs: why the check reached its verdict.
 *
 * @param {string} text
 * @returns {{keeps: boolean, markers: string[], hasAssemble: boolean, dropsInjectShape: boolean, identityLeft: boolean}}
 */
export function explainHostPromptState(text) {
  const body = String(text || "");
  return {
    keeps: hostPromptKeepsInject(body),
    markers: INJECT_MARKERS.filter((marker) => body.includes(marker)),
    hasAssemble: body.includes("system-prompt/assemble"),
    dropsInjectShape: body.includes("transformed.sections : [completeSection]"),
    identityLeft: body.includes("You are an AI agent powered by DeepSeek Harness."),
  };
}
