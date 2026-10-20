// Tests for the right-sidebar pane integration.
//
// The plugin used to render its panel as a `shell.overlay` floating window with
// hand-rolled drag/resize/geometry. It now registers into the official right
// sidebar (`sidebar.right.pane.tab` + `.title`), the same way the host's own
// terminal / files / browser / document-preview panels do — which gives width
// control, split-pane, fullscreen and narrow-screen handling for free.
//
// These tests are static assertions over the built client bundle: the pane wiring
// is DOM/React code that cannot be exercised without the host shell, so we pin the
// structural invariants that a refactor could silently break.
import fs from "node:fs";

const built = fs.readFileSync("client.js", "utf8");
const src = fs.readFileSync("lib/redteam/client.js", "utf8");

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${ok ? "" : ` (got ${JSON.stringify(actual)})`}`);
}

console.log("--- pane slot registration ---");
{
  check("registers the pane body slot", built.includes('slots.inject("sidebar.right.pane.tab"'), true);
  check("registers the pane title slot", built.includes('slots.inject("sidebar.right.pane.tab.title"'), true);
  check("body slot has a stable key", /name:\s*"sidebar\.right\.pane\.tab",\s*\n\s*key:\s*KEY/.test(built), true);
  check("installer is called from apply()", built.includes("installRightPaneTab(ctx, t)"), true);
}

console.log("--- both panels are reachable from the pane ---");
{
  check("pane renders the clean settings root", /RightPaneBody[\s\S]{0,2000}SettingsRoot/.test(built), true);
  check("pane renders the embedded drill panel", /RightPaneBody[\s\S]{0,2500}embedded:\s*true/.test(built), true);
  check("unauthorized drill shows the notice", /RightPaneBody[\s\S]{0,2500}dock\.unauthorized/.test(built), true);
}

console.log("--- no double render: pane and window are mutually exclusive ---");
{
  check("dock mode is persisted under its own key", built.includes("dsh-purge-dock-mode"), true);
  check("useDockWindow consults rightPaneAvailable", /function useDockWindow[\s\S]{0,300}rightPaneAvailable/.test(built), true);
  check("PurgeDock bails out when the pane owns the panel", /if \(!showWindow\)[\s\S]{0,400}return/.test(built), true);
  // Hooks must run unconditionally: a `return` before the first hook would break
  // React's ordering rules. Assert the guard lives after the hook block.
  const fnStart = built.indexOf("function PurgeDock()");
  const firstHook = built.indexOf("useState", fnStart);
  const guard = built.indexOf("if (!showWindow)", fnStart);
  check("guard sits after the first hook", guard > firstHook && firstHook > fnStart, true);
}

console.log("--- CSS is scoped to the pane, not the floating window ---");
{
  check("pane root styles exist", built.includes(".dshp-pane{"), true);
  check("pane does not pin itself with position:fixed", /\.dshp-pane\{[^}]*position:\s*fixed/.test(built), false);
  check("pane title styles exist", built.includes(".dshp-pane-title{"), true);
}

console.log("--- i18n keys for the pane ---");
{
  for (const key of ["pane.title", "dock.tab.clean", "dock.tab.drill"]) {
    // Each key must appear at least twice: once in the zh dictionary, once in en.
    const occurrences = (built.match(new RegExp(`"${key.replace(/\./g, "\\.")}":`, "g")) || []).length;
    check(`${key} defined in both dictionaries`, occurrences >= 2, true);
  }
}

console.log("--- floating window code is retained as fallback ---");
{
  // Older hosts lack the right-sidebar slots; the overlay path must survive.
  check("shell.overlay registration kept", built.includes('slots.inject("shell.overlay"'), true);
  check("drag/resize handlers kept", built.includes("startResizeBottom"), true);
  check("embedded drill mode still supported", src.includes("const embedded = !!(props && props.embedded)"), true);
}

console.log(failures === 0 ? "\nRIGHT PANE OK" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
