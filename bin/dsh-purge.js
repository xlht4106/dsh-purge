#!/usr/bin/env node

import path from "node:path";
import * as core from "../lib/core.js";
import * as rules from "../lib/rules.js";
import { hindsightReport } from "../lib/hindsight-compat.js";
import { hasTrustedKey } from "../lib/release-signature.js";
import { repoSlug } from "../lib/update.js";
import * as sessionInject from "../lib/session-inject.js";

const args = process.argv.slice(2);

/** 第三方插件的共存状态。探测失败不影响主状态输出。 */
function thirdPartyLines(state) {
  const out = [];
  const profileDir = path.join(state.dsh_home || "", "profiles", state.surface || "web");
  try {
    const hs = hindsightReport(profileDir);
    if (hs.state === "absent") return out;
    const label = {
      ok: "正常 / ok",
      disabled: "已禁用 / disabled",
      "not-mounted": "已安装但未挂载 / not mounted",
      "not-installed": "未安装 / not installed",
    }[hs.state] || hs.state;
    out.push(`  hindsight     ${label}${hs.version ? "  v" + hs.version : ""}`);
    if (hs.note) out.push(`                ${hs.note}`);
  } catch {
    // 探测是附加信息，坏掉不挡 --status。
  }
  return out;
}

function printStatus(state) {
  const out = [];
  out.push("dsh-purge 状态 / Status");
  out.push("  宿主 / surface " + (state.surface || "web"));
  out.push("  DSH_HOME      " + state.dsh_home);
  if (state.desktop_install) out.push("  桌面安装       " + state.desktop_install);
  if (state.ai_base) {
    out.push("  插件根 / root  " + state.ai_base);
    for (const [key, fp] of Object.entries(state.files)) {
      out.push(`    ${key.padEnd(22)} ${fp}`);
    }
  } else {
    out.push("  插件根 / root  " + core.missingAiBaseMessage());
  }
  out.push(`  shim 目录      ${state.shim_dir || "未定位 / not found"}`);
  out.push(`  备份 / backup  ${state.has_backup ? "有 / yes" : "无 / no"}`);
  out.push(`  注入文件       ${state.override_path}`);
  out.push(`  注入状态       ${state.override_status}`);
  // 更新验签：没有内置公钥时，tag 发布版一律装不上，用户需要知道原因。
  out.push(`  发布源         ${repoSlug()}（DSH_PURGE_REPO 可覆盖）`);
  out.push(
    `  更新验签       ${hasTrustedKey() ? "已配置公钥 / trusted key present" : "未配置公钥 / no trusted key（发布版更新会被拒绝）"}`,
  );
  out.push("");
  out.push(`  补丁 ${state.patches_applied}/${core.ALL_PATCHES.length} 已清洗, ${state.patches_pending} 待清洗`);
  for (const p of core.ALL_PATCHES) {
    const s = state.patch_status[p.id];
    // ⚠ 表示「标记在但锚点还在」：这条补丁其实没生效，需要重新应用。
    const mark = s === "applied" ? "✓" : s === "stale" ? "⚠" : s === "pending" ? "✗" : "·";
    out.push(`    ${mark} [#${String(p.id).padEnd(2)}] ${p.name.padEnd(30)} ${p.layer}/${p.layer_en} — ${s}`);
  }
  out.push("");
  out.push(`  shim: dsh.cmd=${state.shim_cmd}  dsh.ps1=${state.shim_ps1}  dsh=${state.shim_bin}`);
  // 会话注入：默认全关，所以要让人一眼看到「现在有哪些会话开着注入」。
  try {
    const sum = sessionInject.summarize(state.dsh_home);
    out.push("");
    out.push(`  会话注入       默认关闭；已记录 ${sum.total} 个会话，开启 ${sum.enabled} 个`);
    for (const row of sum.sessions.slice(0, 8)) {
      out.push(`    ${row.enabled ? "✓" : "·"} ${row.id}${row.updatedAt ? "  " + row.updatedAt : ""}`);
    }
    if (sum.sessions.length > 8) out.push(`    …还有 ${sum.sessions.length - 8} 个`);
  } catch {
    // 状态文件读不了不影响其它输出。
  }
  const third = thirdPartyLines(state);
  if (third.length) {
    out.push("");
    out.push("  第三方插件 / third-party");
    out.push(...third);
  }
  return out.join("\n");
}

async function main() {
  const mode = args.find((a) => ["--apply", "--revert", "--uninstall", "--status", "--edit", "--session-inject", "--help"].includes(a));

  if (mode === "--help" || args.includes("-h")) {
    console.log(`dsh-purge 用法:
  dsh-purge --status     显示状态
  dsh-purge --apply      应用全部清洗（提示词+代码+shim+override）
  dsh-purge --revert     回滚还原
  dsh-purge --uninstall  卸载插件（已应用则先还原）
  dsh-purge --edit       编辑注入文件 prompt-inject.md
  dsh-purge --session-inject <on|off|status> <sessionId> [text]
                         单会话注入开关（下一轮生效，不影响其它会话）
  dsh-purge --help       帮助`);
    return;
  }

  // 会话注入子命令：不改宿主，只动状态文件，所以放在 gatherState 之前。
  if (mode === "--session-inject") {
    const idx = args.indexOf("--session-inject");
    const action = String(args[idx + 1] || "status").trim().toLowerCase();
    const sessionId = String(args[idx + 2] || "").trim();
    const dshHome = core.findDshHome();
    if (!dshHome) {
      console.log("[ERROR] 找不到 DSH_HOME");
      process.exit(1);
    }
    if (action === "status") {
      const sum = sessionInject.summarize(dshHome);
      console.log(`会话注入 默认关闭；已记录 ${sum.total} 个，开启 ${sum.enabled} 个`);
      for (const row of sum.sessions) {
        console.log(`  ${row.enabled ? "✓" : "·"} ${row.id}${row.updatedAt ? "  " + row.updatedAt : ""}`);
      }
      if (sessionId) {
        const rec = sessionInject.readState(dshHome).sessions[sessionId];
        console.log("");
        console.log(`  ${sessionId}: ${rec && rec.enabled ? "开启" : "关闭"}`);
      }
      return;
    }
    if (sessionId === "") {
      console.log("[ERROR] 需要 sessionId");
      process.exit(1);
    }
    if (action === "on" || action === "off") {
      const text = args[idx + 3];
      const rec = sessionInject.setSessionState(dshHome, sessionId, {
        enabled: action === "on",
        text: typeof text === "string" ? text : undefined,
      });
      console.log(`✓ ${sessionId} 注入已${rec.enabled ? "开启" : "关闭"}（下一轮生效）`);
      return;
    }
    console.log(`[ERROR] 未知动作: ${action}（可用 on / off / status）`);
    process.exit(1);
  }

  const state = await core.gatherState();
  console.log(printStatus(state));
  console.log("");

  if (mode === "--apply") {
    if (!state.ai_base) {
      console.log("[ERROR] " + core.missingAiBaseMessage());
      console.log("  fix: 把 DSH_BASE 指到含 dsh-agent-instructions/lib 的 @deepseek-ai 目录");
      process.exit(1);
    }
    const inject = rules.resolveInjectText(state.dsh_home);
    if (!inject.text) {
      console.log("[ERROR] 提示词和规则集都是空的，必须先添加提示词");
      process.exit(1);
    }
    const { hosts, report } = await core.applyPatchesAllHosts(core.ALL_PATCHES, {
      preserveClientBundles: false,
      forApply: true,
    });
    for (const h of hosts) console.log(`  宿主 / host → ${h.aiBase}`);
    for (const r of report) {
      const m = r.status === "applied" ? "✓ 已清洗" : r.status === "already" ? "- 已是最新" : r.status === "missing_file" ? "⚠ 文件缺失" : `✗ ${r.status}`;
      console.log(`  ${m} patch #${String(r.patch_id).padEnd(2)} ${r.name}`);
    }
    const flashHost = hosts[0]?.aiBase || state.ai_base;
    const flash = core.silenceCmdFlash(flashHost);
    console.log(`  cmd-flash=${flash.entry} phase-1=${flash.phase1} ok=${flash.ok}`);
    if (hosts.length > 1) {
      console.log(`  多宿主 / multi-host: ${hosts.length} 份 @deepseek-ai 已清洗`);
    }
    console.log(inject.source === "rule"
      ? "  - 使用当前规则集，不改写提示词文件"
      : "  - 使用已有提示词文件");
    if (state.shim_dir) {
      const r = await core.patchShim(state.shim_dir);
      for (const [fname, st] of Object.entries(r)) {
        if (st === "patched") console.log(`  ✓ shim ${fname} 注入 / injected`);
        else if (st === "already_patched") console.log(`  - shim ${fname} 已注入 / already injected`);
        else if (st === "missing") console.log(`  - shim ${fname} 不存在 / missing`);
        else console.log(`  ⚠ shim ${fname}: ${st}`);
      }
    } else {
      console.log("  ⚠ 未定位 shim 目录，跳过注入");
    }
    console.log("");
    console.log("全部完成 / All done。重启 dsh 生效 / Restart dsh to take effect.");
  } else if (mode === "--revert") {
    if (state.ai_base || core.enumeratePatchAiBases().length) {
      const { reverted, errors } = await core.revertAllHosts();
      for (const p of reverted) console.log(`  ✓ 已还原 / Reverted ${p}`);
      for (const [p, e] of errors) console.log(`  ⚠ 还原失败 ${p}: ${e}`);
      if (reverted.length === 0) console.log("  - 没有补丁备份可还原 / no patch backup");
    }
    if (state.shim_dir) {
      const r = await core.revertShim(state.shim_dir);
      for (const [fname, st] of Object.entries(r)) {
        if (st === "reverted" || st === "stripped_inject") console.log(`  ✓ shim ${fname}: ${st}`);
        else console.log(`  - shim ${fname}: ${st}`);
      }
    }
    console.log("");
    console.log("回滚完成 / Revert done。重启 dsh 后恢复 / restart to restore.");
    console.log("注: prompt-inject.md 保留（用户文件）/ prompt-inject.md kept (user file)");
  } else if (mode === "--uninstall") {
    const { uninstallPurge } = await import("../lib/uninstall.js");
    const result = await uninstallPurge();
    if (result.applied) console.log("  已检测到补丁，已还原回原版。");
    else console.log("  未检测到已应用补丁，仍会清除插件文件。");
    if (result.override?.removed) console.log(`  已删除 ${result.override.path}`);
    if (result.stripped?.length) console.log(`  已从 profile 移除: ${result.stripped.join(", ")}`);
    for (const e of result.errors || []) console.log(`  ⚠ ${e}`);
    if (!result.ok) {
      console.log("  卸载中止：还原失败，插件文件未删除。");
      process.exit(1);
    }
    console.log("");
    console.log("卸载完成。请重启 dsh。");
  } else if (mode === "--edit") {
    const r = core.editOverride(state.dsh_home);
    if (!r.ok && r.needCreate) {
      await core.installOverride(state.dsh_home, true);
      console.log(`  ✓ 已创建默认注入文件：${state.override_path}`);
      core.editOverride(state.dsh_home);
    } else {
      console.log(`  → 已打开 ${r.editor} 编辑注入文件：${r.path}`);
    }
    console.log("  编辑完成后重启 dsh 生效。");
  } else {
    console.log("默认不清洗，使用 --apply 应用清洗。");
  }
}

main().catch((e) => {
  console.error("[dsh-purge] error:", e);
  process.exit(1);
});
