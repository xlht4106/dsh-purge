/**
 * Per-session injection state.
 *
 * Problem this solves
 * -------------------
 * Injection used to be global: `cordis.patch.yml`'s personaSuffix and
 * prompt-inject.md applied to every session alike, and changing them needed a host
 * restart. Users running several sessions at once wanted each session to decide for
 * itself whether it is injected, to switch mid-session without restarting, and to
 * try a prompt without touching the global config.
 *
 * Model
 * -----
 * State lives in `$DSH_HOME/dsh-purge/session-inject.json`, keyed by session id:
 *
 *   {
 *     "version": 1,
 *     "sessions": {
 *       "<sessionId>": { "enabled": true, "text": "...", "source": "override", "updatedAt": "..." }
 *     }
 *   }
 *
 * Resolution order, per assemble:
 *   1. subagent        -> the parent session's state (children are not configured individually)
 *   2. sessionId hit   -> that record
 *   3. otherwise       -> disabled
 *
 * Default disabled is deliberate: the user chose it, and it is paired with a
 * first-run banner in the UI so nobody mistakes "injection off" for "plugin broken".
 *
 * Failure policy
 * --------------
 * A corrupt state file must never stop the plugin from loading, and must never be
 * silently deleted — it may be the only copy of the user's configuration. It is
 * renamed to `.corrupt` once and we start from empty.
 *
 * When the session id cannot be determined we resolve to disabled rather than
 * falling back to a global default: injecting into the wrong session is worse than
 * not injecting at all.
 */
import fs from "node:fs";
import path from "node:path";

/** Schema version written into the state file. */
export const STATE_VERSION = 1;

/** File name under `$DSH_HOME/dsh-purge/`. */
const STATE_FILE = "session-inject.json";

/** @param {string} dshHome */
export function sessionInjectPath(dshHome) {
  return path.join(String(dshHome || ""), "dsh-purge", STATE_FILE);
}

/**
 * Normalise one session record.
 *
 * @param {unknown} raw
 * @returns {{enabled: boolean, text: string, source: string, updatedAt: string}|null}
 */
function normalizeRecord(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = /** @type {Record<string, unknown>} */ (raw);
  const source = typeof record.source === "string" && record.source.trim() !== ""
    ? record.source.trim()
    : "override";
  return {
    enabled: record.enabled === true,
    text: typeof record.text === "string" ? record.text : "",
    source,
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : "",
  };
}

/**
 * Read the whole state file.
 *
 * @param {string} dshHome
 * @param {{onCorrupt?: (info: {path: string, backup: string, error: string}) => void}} [hooks]
 * @returns {{version: number, sessions: Record<string, object>, corrupt?: boolean}}
 */
export function readState(dshHome, hooks = {}) {
  const empty = { version: STATE_VERSION, sessions: {} };
  const fp = sessionInjectPath(dshHome);
  let text;
  try {
    text = fs.readFileSync(fp, "utf8");
  } catch {
    // Missing file is the normal first run, not an error.
    return empty;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    // Keep the original bytes: this may be the user's only copy.
    const backup = `${fp}.corrupt`;
    try {
      if (!fs.existsSync(backup)) fs.writeFileSync(backup, text, "utf8");
    } catch {
      // If even the backup fails, carry on with defaults — never crash the host.
    }
    try {
      if (typeof hooks.onCorrupt === "function") {
        hooks.onCorrupt({ path: fp, backup, error: String((e && e.message) || e) });
      }
    } catch {
      // Diagnostics must not break recovery.
    }
    return { ...empty, corrupt: true };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ...empty, corrupt: true };
  }
  const sessions = {};
  const rawSessions = parsed.sessions;
  if (rawSessions && typeof rawSessions === "object" && !Array.isArray(rawSessions)) {
    for (const [id, raw] of Object.entries(rawSessions)) {
      if (typeof id !== "string" || id === "") continue;
      const record = normalizeRecord(raw);
      if (record) sessions[id] = record;
    }
  }
  const version = Number.isInteger(parsed.version) ? parsed.version : STATE_VERSION;
  return { version, sessions };
}

/**
 * Write the whole state atomically.
 *
 * @param {string} dshHome
 * @param {{version?: number, sessions: Record<string, object>}} state
 */
export function writeState(dshHome, state) {
  const fp = sessionInjectPath(dshHome);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  const payload = {
    version: STATE_VERSION,
    sessions: state && state.sessions && typeof state.sessions === "object" ? state.sessions : {},
  };
  const tmp = `${fp}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  try {
    fs.renameSync(tmp, fp);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw e;
  }
}

/**
 * Set one session's injection state.
 *
 * @param {string} dshHome
 * @param {string} sessionId
 * @param {{enabled: boolean, text?: string, source?: string}} patch
 * @returns {object} the record written
 */
export function setSessionState(dshHome, sessionId, patch) {
  const id = String(sessionId || "").trim();
  if (id === "") throw new Error("session id is required");
  const state = readState(dshHome);
  const previous = state.sessions[id] || { enabled: false, text: "", source: "override", updatedAt: "" };
  const record = {
    enabled: patch && patch.enabled === true,
    text: patch && typeof patch.text === "string" ? patch.text : previous.text,
    source: patch && typeof patch.source === "string" && patch.source.trim() !== ""
      ? patch.source.trim()
      : previous.source || "override",
    updatedAt: new Date().toISOString(),
  };
  state.sessions[id] = record;
  writeState(dshHome, state);
  return record;
}

/**
 * Remove one session's record, returning it to the default (disabled).
 *
 * @param {string} dshHome
 * @param {string} sessionId
 * @returns {boolean} whether a record was removed
 */
export function clearSessionState(dshHome, sessionId) {
  const id = String(sessionId || "").trim();
  if (id === "") return false;
  const state = readState(dshHome);
  if (!Object.hasOwn(state.sessions, id)) return false;
  delete state.sessions[id];
  writeState(dshHome, state);
  return true;
}

/**
 * Extract the session id from an assemble context.
 *
 * Mirrors lib/identity.js `sessionOfContext()`: agents carry the session, and some
 * call shapes pass the session directly.
 *
 * @param {object|null} context
 * @returns {string} "" when unknown
 */
export function sessionIdOfContext(context) {
  let session = null;
  try {
    session = (context && context.agent && context.agent.session) || (context && context.session) || null;
  } catch {
    session = null;
  }
  if (!session) return "";
  try {
    const header = session.header;
    if (header && typeof header.id === "string" && header.id.trim() !== "") return header.id.trim();
  } catch {
    // Fall through to the id property.
  }
  try {
    if (typeof session.id === "string" && session.id.trim() !== "") return session.id.trim();
  } catch {
    // Unknown shape.
  }
  return "";
}

/**
 * Find the parent session id for a child agent context, if any.
 *
 * @param {object|null} context
 * @returns {string} "" when this is not a child or the parent is unknown
 */
export function parentSessionIdOfContext(context) {
  let header = null;
  try {
    const session = (context && context.agent && context.agent.session) || (context && context.session) || null;
    header = session && session.header;
  } catch {
    header = null;
  }
  if (!header) return "";
  const direct = typeof header.parentSession === "string" ? header.parentSession.trim() : "";
  if (direct !== "") return direct;
  const parent = header.parent;
  if (parent && typeof parent === "object" && typeof parent.id === "string") return parent.id.trim();
  return "";
}

/**
 * Resolve the effective injection setting for one assemble.
 *
 * @param {object} input
 * @param {string} input.dshHome
 * @param {object|null} input.context assemble context
 * @param {boolean} [input.isChild] caller's own child-agent verdict (avoids duplicate logic)
 * @returns {{enabled: boolean, text: string, source: string, sessionId: string, inherited: boolean}}
 */
export function resolveForContext({ dshHome, context, isChild = false }) {
  const disabled = { enabled: false, text: "", source: "default", sessionId: "", inherited: false };
  if (!dshHome) return disabled;

  const ownId = sessionIdOfContext(context);
  const parentId = isChild ? parentSessionIdOfContext(context) : "";
  const lookupId = parentId || ownId;
  if (lookupId === "") return { ...disabled, sessionId: ownId };

  const state = readState(dshHome);
  const record = state.sessions[lookupId];
  if (!record) return { ...disabled, sessionId: ownId || lookupId, inherited: Boolean(parentId) };
  return {
    enabled: record.enabled === true,
    text: record.text || "",
    source: record.source || "override",
    sessionId: ownId || lookupId,
    inherited: Boolean(parentId),
  };
}

/**
 * Summarise state for `--status` and the settings panel.
 *
 * @param {string} dshHome
 * @returns {{total: number, enabled: number, disabled: number, sessions: Array<{id: string, enabled: boolean, updatedAt: string}>}}
 */
export function summarize(dshHome) {
  const state = readState(dshHome);
  const rows = Object.entries(state.sessions).map(([id, record]) => ({
    id,
    enabled: record.enabled === true,
    updatedAt: record.updatedAt || "",
  }));
  rows.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return {
    total: rows.length,
    enabled: rows.filter((r) => r.enabled).length,
    disabled: rows.filter((r) => !r.enabled).length,
    sessions: rows,
  };
}
