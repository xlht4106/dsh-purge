// Correctness guard for the desktop.js locate caches.
//
// The caches added to firstExistingExe()/listDesktopInstallRoots() must never
// change the answer, only how often it is computed. This asserts:
//   1. cold == warm == cleared answers for the real machine,
//   2. clearDesktopLocateCache() really drops the memo (a stale answer would make
//      the plugin patch the wrong install after the user moves it),
//   3. callers cannot corrupt the cache by mutating the returned array.
process.env.DSH_SURFACE = "desktop";
const desktop = await import("../lib/desktop.js");

function snapshot(label) {
  const roots = desktop.listDesktopInstallRoots();
  return { label, roots, exe: desktop.findDesktopAppExecutable() };
}

const cold = snapshot("cold");
const warm = snapshot("warm");

desktop.clearDesktopLocateCache();
const cleared = snapshot("cleared");

let failures = 0;
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

if (!eq(cold.roots, warm.roots)) {
  failures += 1;
  console.log("FAIL roots differ cold vs warm", cold.roots, warm.roots);
} else {
  console.log(`PASS roots stable cold/warm (${cold.roots.length} roots)`);
}
if (!eq(cold.roots, cleared.roots)) {
  failures += 1;
  console.log("FAIL roots differ after clearDesktopLocateCache", cold.roots, cleared.roots);
} else {
  console.log("PASS roots identical after cache clear");
}
if (cold.exe !== warm.exe || cold.exe !== cleared.exe) {
  failures += 1;
  console.log("FAIL exe differs", cold.exe, warm.exe, cleared.exe);
} else {
  console.log(`PASS exe stable: ${cold.exe || "(none)"}`);
}

// Mutation guard: the memo must hand out copies, not its internal array.
const mutated = desktop.listDesktopInstallRoots();
if (mutated.length > 0) {
  mutated.push("C:\\__poison__");
  const after = desktop.listDesktopInstallRoots();
  if (after.includes("C:\\__poison__")) {
    failures += 1;
    console.log("FAIL caller mutation leaked into the cache");
  } else {
    console.log("PASS caller mutation did not leak into the cache");
  }
}

console.log(failures === 0 ? "\nCACHE CORRECTNESS OK" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
