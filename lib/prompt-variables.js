/**
 * Register the `{{cwd}}` prompt variable on hosts that no longer provide it.
 *
 * The problem
 * -----------
 * `cordis.patch.yml` sets `personaSuffix: Your working directory is {{cwd}}.`, and
 * the runtime rebuilds that suffix from `CWD_ONLY_SUFFIX`. On dsh 0.2.0 the agent
 * loop registered `cwd` itself:
 *
 *   ctx.systemPrompt.variable("cwd", (context) => ...);
 *
 * On dsh 0.2.1 that registration is gone — only `provider` and `model` remain:
 *
 *   ctx.systemPrompt.variable("provider", ...);
 *   ctx.systemPrompt.variable("model", ...);
 *
 * and `renderPrompt()` throws on any unregistered variable:
 *
 *   unknown prompt variable "{{cwd}}" in section "deployment:persona-suffix";
 *   registered variables: provider, model
 *
 * That kills the whole turn before a model request is ever made. The clean panel
 * still shows green, because the patches themselves applied fine — the failure is
 * in prompt assembly.
 *
 * The fix
 * -------
 * Register `cwd` ourselves through the public `systemPrompt.variable()` API, backed
 * by the `workingDirectory` service so the value follows per-session directory
 * changes. Registration is a Cordis effect, so it is cleaned up on unload.
 *
 * Compatibility rules, all deliberate:
 *   - Only register when the host does NOT already provide `cwd`. On 0.2.0 the
 *     host's own registration wins and we do nothing.
 *   - If the service is unavailable, fall back to a plain process.cwd() value
 *     rather than skipping: a wrong-ish directory beats a dead session.
 *   - Never throw out of apply(): a failure to register must not stop the plugin
 *     from loading. The consequence (a broken turn) is already what happens
 *     without us, and a hard failure here would be worse.
 */

/** Name of the prompt variable we provide. */
export const CWD_VARIABLE = "cwd";

/** Services required before we can register a meaningful `cwd`. */
export const CWD_INJECT = ["systemPrompt"];

/**
 * Resolve the working directory for an assembly context.
 *
 * @param {object|null} workingDirectory the host's workingDirectory service, if any
 * @param {object|undefined} context assembly context (`{ agent, session }`)
 * @returns {string} absolute-ish directory string
 */
function resolveCwd(workingDirectory, context) {
  const agent = context && context.agent;
  const session = (context && context.session) || (agent && agent.session);
  if (workingDirectory && typeof workingDirectory.get === "function") {
    try {
      const fromSession = session ? workingDirectory.get(session) : undefined;
      if (typeof fromSession === "string" && fromSession.trim() !== "") return fromSession;
    } catch {
      // Service rejected the session shape; fall through to the default below.
    }
  }
  try {
    return process.cwd();
  } catch {
    return ".";
  }
}

/**
 * Install the `cwd` variable when the host does not provide one.
 *
 * @param {object} ctx cordis plugin context (must have `systemPrompt`)
 * @param {object} [options]
 * @param {object} [options.workingDirectory] the host's workingDirectory service
 * @param {(msg: string) => void} [options.log] optional logger
 * @returns {'registered'|'already'|'unavailable'} what happened
 */
export function installCwdVariable(ctx, options = {}) {
  const log = typeof options.log === "function" ? options.log : () => {};
  const systemPrompt = ctx && ctx.systemPrompt;
  if (!systemPrompt || typeof systemPrompt.variable !== "function") return "unavailable";

  // The host may already own this name (0.2.0). Registering over it would be a
  // conflict inside the layers registry, so probe first and bail out quietly.
  if (alreadyRegistered(systemPrompt)) return "already";

  const workingDirectory = options.workingDirectory || (ctx && ctx.workingDirectory) || null;
  try {
    systemPrompt.variable(CWD_VARIABLE, (context) => resolveCwd(workingDirectory, context));
    log(`registered prompt variable "${CWD_VARIABLE}" (host did not provide one)`);
    return "registered";
  } catch (e) {
    // Duplicate registration races, or a host that rejects late variables. Not
    // fatal: the previous behaviour (no variable) is what we were trying to fix,
    // and throwing here would take the whole plugin down.
    log(`could not register prompt variable "${CWD_VARIABLE}": ${(e && e.message) || e}`);
    return "unavailable";
  }
}

/**
 * Best-effort check for an existing registration.
 *
 * The service does not expose a public "has" method, so look at the internal
 * variable registry when it is reachable. Unknown shapes return false: we then
 * attempt registration and let the host reject a duplicate.
 */
function alreadyRegistered(systemPrompt) {
  try {
    const layers = systemPrompt.layers;
    const vars = layers && layers.variables;
    if (vars && typeof vars.has === "function") return vars.has(CWD_VARIABLE);
    if (vars && typeof vars.get === "function") return vars.get(CWD_VARIABLE) !== undefined;
    if (vars && Array.isArray(vars)) {
      return vars.some((entry) => entry && entry.name === CWD_VARIABLE);
    }
  } catch {
    // Internal shape changed; fall through and let registration decide.
  }
  return false;
}
