// Regression gate for the frontend fixes.
//
// Two classes of fixes must survive a rebuild of client.js from its source:
//   A. the hand edits that only existed in the built artifact (countdown cleanup),
//   B. the new hardening added this session (apiJson on long-running routes).
// Also asserts that the routes which MUST keep raw fetch (intentional polling) do so.
import fs from "node:fs";

const built = fs.readFileSync("client.js", "utf8");

const mustHave = [
  ["countdown cleanup: ref", "countdownRef"],
  ["countdown cleanup: clearCountdown", "clearCountdown"],
  ["countdown cleanup: closeModal", "closeModal"],
  ["apiJson on apply/revert/uninstall", 'apiJson("/dsh-purge/" + action'],
  ["apiJson on override save", 'apiJson("/dsh-purge/override"'],
  ["apiJson on own-servers", 'apiJson("/dsh-purge/own-servers"'],
  ["apiJson on restart", 'apiJson("/dsh-purge/restart"'],
  ["drill: request timeout", "API_TIMEOUT_MS"],
  ["drill: long-list css", "content-visibility"],
  ["drill: non-json guard", "non-json"],
];

const mustNotHave = [
  ["raw fetch on apply/revert/uninstall", 'fetch("/dsh-purge/" + action'],
  ["raw fetch on override save", 'fetch("/dsh-purge/override"'],
  ["raw fetch on own-servers", 'fetch("/dsh-purge/own-servers"'],
];

let failures = 0;
console.log("--- must have ---");
for (const [label, needle] of mustHave) {
  const ok = built.includes(needle);
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}`);
}

console.log("--- must not have (bare fetch on long routes) ---");
for (const [label, needle] of mustNotHave) {
  const present = built.includes(needle);
  if (present) failures += 1;
  console.log(`${present ? "FAIL" : "PASS"} ${label}`);
}

// Intentional polling must stay on raw fetch: these run in tight retry loops where
// apiJson's per-path timeout would abort a probe that is *expected* to fail.
console.log("--- intentional raw fetch retained ---");
const polling = [
  ["restart readiness poll", 'fetch("/dsh-purge/status", { cache: "no-store"'],
  ["uninstall host ping", 'fetch("/", { cache: "no-store"'],
];
for (const [label, needle] of polling) {
  const ok = built.includes(needle);
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}`);
}

console.log(failures === 0 ? "\nFRONTEND REGRESSION OK" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
