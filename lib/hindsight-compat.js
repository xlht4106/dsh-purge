/**
 * Coexistence with @vectorize-io/hindsight-coding-agents.
 *
 * Why this is a *probe*, not a patch
 * ----------------------------------
 * hindsight mounts on the host plane and does exactly one thing per step: it
 * appends a message to `decision.messages` from its `agent/pre-step` hook.
 *
 *   ctx.on("agent/pre-step", hooks.preStep, { prepend: true });
 *   ...
 *   return { kind: "enter", messages: [...decision.messages, injectionMessage(injection)] };
 *
 * where the injected message carries `source: { kind: "plugin:hindsight", form: "recall" }`.
 *
 * Two consequences, both verified against the installed 0.8.1 build:
 *
 *   1. It never touches `systemPrompt`. So dsh-purge's prompt-layer patches
 *      (#25 identity strip, #32/#53 web surface, #43 preset identity, #55 head
 *      replacement) cannot collide with it — different mechanism, different data.
 *
 *   2. Its message carries `source.kind`, so it does not trip dsh-purge #68
 *      ("guard missing message content"), which exists precisely because
 *      agent-loop reads `message.source.kind` at step start.
 *
 * Therefore there is nothing in hindsight's own files that dsh-purge should
 * rewrite. What dsh-purge *should* do is report whether the plugin is present and
 * healthy, so a user can tell "memory is not working" apart from "purge broke it".
 *
 * What could actually break the pairing (and what this file checks)
 * ----------------------------------------------------------------
 *   - The profile's bundle list loses the hindsight row during an update/reapply.
 *   - The plugin is present in node_modules but not mounted (row removed, or
 *     `disabled: true` in the user's profile patch layer).
 *   - A newer hindsight changes its injection shape and stops setting source.kind.
 *     We cannot detect that ahead of time, so the report names the exact version
 *     we validated against.
 */
import fs from "node:fs";
import path from "node:path";

/** The package name, as published. */
export const HINDSIGHT_PACKAGE = "@vectorize-io/hindsight-coding-agents";

/** Versions whose integration shape has been verified against dsh-purge's patches. */
export const VERIFIED_VERSIONS = ["0.8.1", "0.8.2"];

/** Profile bundle row id used by the package's own cordis.patch.yml. */
export const HINDSIGHT_ROW_ID = "hindsight";

function readJsonFile(fp) {
  try {
    return JSON.parse(fs.readFileSync(fp, "utf8"));
  } catch {
    return null;
  }
}

/** Read a package.json version, or "" when absent. */
function packageVersion(dir) {
  const pkg = readJsonFile(path.join(dir, "package.json"));
  return pkg && typeof pkg.version === "string" ? pkg.version : "";
}

/** Candidate node_modules roots for a profile, mirroring the host's resolution. */
function profileModuleDirs(profileDir) {
  return [
    path.join(profileDir, "node_modules"),
    path.join(profileDir, ".dsh-module-fallback", "node_modules"),
  ];
}

/**
 * Locate the installed hindsight package for one profile.
 *
 * @param {string} profileDir absolute path to $DSH_HOME/profiles/<name>
 * @returns {{installed: boolean, dir: string, version: string}}
 */
export function locateHindsight(profileDir) {
  if (!profileDir) return { installed: false, dir: "", version: "" };
  for (const modules of profileModuleDirs(profileDir)) {
    const dir = path.join(modules, ...HINDSIGHT_PACKAGE.split("/"));
    if (!fs.existsSync(path.join(dir, "package.json"))) continue;
    return { installed: true, dir, version: packageVersion(dir) };
  }
  return { installed: false, dir: "", version: "" };
}

/**
 * Read the profile's bundle list and dependency entry.
 *
 * @param {string} profileDir
 * @returns {{bundles: string[], hasDependency: boolean, disabled: boolean, pkg: object|null}}
 */
export function readProfileState(profileDir) {
  const pkg = readJsonFile(path.join(profileDir, "package.json"));
  if (!pkg) return { bundles: [], hasDependency: false, disabled: false, pkg: null };
  const deps = pkg.dependencies && typeof pkg.dependencies === "object" ? pkg.dependencies : {};
  const profile = pkg.dsh && pkg.dsh.profile && typeof pkg.dsh.profile === "object" ? pkg.dsh.profile : {};
  const bundles = Array.isArray(profile.bundles) ? profile.bundles.filter((b) => typeof b === "string") : [];
  return {
    bundles,
    hasDependency: Object.hasOwn(deps, HINDSIGHT_PACKAGE),
    disabled: isRowDisabled(profileDir),
    pkg,
  };
}

/**
 * Detect an explicit `disabled: true` for the hindsight row in the user's profile
 * patch layer. This is the documented way to switch hindsight off without
 * uninstalling, so dsh-purge must report it as "present but off", not as broken.
 *
 * Deliberately a narrow textual scan: the profile patch file is user-editable YAML
 * and loading it as YAML here would add a dependency for one boolean.
 */
function isRowDisabled(profileDir) {
  const fp = path.join(profileDir, "cordis.patch.yml");
  let text;
  try {
    text = fs.readFileSync(fp, "utf8");
  } catch {
    return false;
  }
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    // Match the row's id, then look a few lines down for `disabled: true`.
    if (!new RegExp(`^\\s*-?\\s*id:\\s*['"]?${HINDSIGHT_ROW_ID}['"]?\\s*$`).test(line.trimEnd())) continue;
    const indent = line.length - line.trimStart().length;
    for (let j = i + 1; j < lines.length && j <= i + 12; j += 1) {
      const next = lines[j];
      if (next.trim() === "") continue;
      const nextIndent = next.length - next.trimStart().length;
      if (nextIndent < indent) break;
      if (/^\s*disabled:\s*true\b/.test(next)) return true;
    }
  }
  return false;
}

/**
 * Build the coexistence report for one profile.
 *
 * @param {string} profileDir
 * @returns {object} report suitable for `--status` and the settings panel
 */
export function hindsightReport(profileDir) {
  const profile = readProfileState(profileDir);
  const found = locateHindsight(profileDir);
  const inBundles = profile.bundles.includes(HINDSIGHT_PACKAGE);
  const verified = found.installed && VERIFIED_VERSIONS.includes(found.version);

  /** @type {'absent'|'not-installed'|'disabled'|'not-mounted'|'ok'} */
  let state = "absent";
  let note = "";

  if (!profile.pkg) {
    state = "absent";
    note = "profile package.json not found";
  } else if (!found.installed) {
    state = "not-installed";
    note = profile.hasDependency
      ? "dependency declared but node_modules is missing (run pnpm install in the profile)"
      : "not installed in this profile";
  } else if (profile.disabled) {
    state = "disabled";
    note = "present but disabled in the profile patch layer";
  } else if (!inBundles) {
    // Installed and not explicitly disabled, but the row is gone: the plugin will
    // not load. This is the failure mode an update or a hand-edited profile causes.
    state = "not-mounted";
    note = "installed but missing from dsh.profile.bundles — hindsight will not load";
  } else {
    state = "ok";
    note = verified
      ? "coexists with dsh-purge patches"
      : `installed at ${found.version}, outside the verified range (${VERIFIED_VERSIONS.join(", ")})`;
  }

  return {
    state,
    note,
    installed: found.installed,
    version: found.version,
    dir: found.dir,
    inBundles,
    disabled: profile.disabled,
    verified,
    package: HINDSIGHT_PACKAGE,
  };
}

/**
 * Assert that applying dsh-purge leaves the hindsight mount intact.
 *
 * dsh-purge rewrites @deepseek-ai files and shims; it must never touch the
 * profile's bundle list (that is the #43 lesson: writing the user patch layer
 * lets a later version upgrade clobber the user's own inserts). This helper is
 * used by tests and by the apply report to prove that invariant held.
 *
 * @param {string} profileDir
 * @param {object} before report captured before apply
 * @returns {{ok: boolean, changed: string[]}}
 */
export function checkHindsightPreserved(profileDir, before) {
  const after = hindsightReport(profileDir);
  const changed = [];
  if (before && before.installed !== after.installed) changed.push("installed");
  if (before && before.inBundles !== after.inBundles) changed.push("bundles");
  if (before && before.disabled !== after.disabled) changed.push("disabled");
  if (before && before.version !== after.version) changed.push("version");
  return { ok: changed.length === 0, changed, before, after };
}
