#!/usr/bin/env node
/**
 * Guided key setup: generate, verify, back up, then wire the public key in.
 *
 * The first attempt at this lost the private key because the printed instructions
 * told the user to delete it *before* confirming a backup existed. This script
 * reverses that order and refuses to continue unless the backup is real.
 *
 *   node scripts/setup-signing-key.mjs
 *
 * Steps:
 *   1. refuse to run if a key file already exists (no silent overwrite)
 *   2. generate an Ed25519 pair and self-test it
 *   3. write the private key to a backup directory OUTSIDE the repo
 *   4. re-read the backup and prove it signs/verifies, then print a fingerprint
 *   5. only then write the public key into lib/release-signature.js
 *   6. print the exact `gh secret set` command for PowerShell
 *
 * The private key is never deleted by this script. Deleting it is a separate,
 * deliberate step the operator takes after storing the backup.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const KEY_IN_REPO = path.join(ROOT, "dsh-purge-signing.key");
const SIG_MODULE = path.join(ROOT, "lib", "release-signature.js");

function fail(message) {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

function fingerprint(publicB64) {
  const der = Buffer.from(publicB64, "base64");
  return crypto.createHash("sha256").update(der).digest("hex").slice(0, 16).replace(/(.{4})/g, "$1 ").trim();
}

console.log("dsh-purge 签名密钥设置\n");

// ── 1. never overwrite ────────────────────────────────────────────────────────
if (fs.existsSync(KEY_IN_REPO)) {
  fail(
    `已存在 ${KEY_IN_REPO}\n` +
      "  如果这是你正在用的密钥，请先备份并删除它，再重跑本脚本。\n" +
      "  覆盖会让已发布的签名全部失效。",
  );
}

// ── 2. generate + self-test ───────────────────────────────────────────────────
const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
const privatePem = privateKey.export({ format: "pem", type: "pkcs8" });
const publicB64 = publicKey.export({ format: "der", type: "spki" }).toString("base64");

const sample = Buffer.from("dsh-purge key self test", "utf8");
if (!crypto.verify(null, sample, publicKey, crypto.sign(null, sample, privateKey))) {
  fail("生成的密钥对自检失败");
}
console.log("✓ 已生成 Ed25519 密钥对并通过自检");

// ── 3. back up OUTSIDE the repo, before anything else ─────────────────────────
const backupDir = path.join(os.homedir(), "dsh-purge-signing-backup");
fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
const backupKey = path.join(backupDir, "dsh-purge-signing.key");
const backupPub = path.join(backupDir, "dsh-purge-signing.key.pub");
if (fs.existsSync(backupKey)) {
  fail(
    `备份目录里已有旧密钥：${backupKey}\n` +
      "  先把它移到别处（或确认不再需要），否则会把新密钥覆盖到旧备份上。",
  );
}
fs.writeFileSync(backupKey, privatePem, { mode: 0o600 });
fs.writeFileSync(backupPub, `${publicB64}\n`, "utf8");
console.log(`✓ 私钥已备份到仓库外：${backupKey}`);

// ── 4. prove the backup is usable ─────────────────────────────────────────────
const reread = crypto.createPrivateKey({ key: fs.readFileSync(backupKey, "utf8"), format: "pem" });
const rereadPub = crypto.createPublicKey(reread);
if (!crypto.verify(null, sample, rereadPub, crypto.sign(null, sample, reread))) {
  fail(`备份文件不可用：${backupKey}\n  不要删除任何东西，先检查磁盘。`);
}
console.log("✓ 备份文件已验证可用（重新读取后签名/验签通过）");

// ── 5. wire the public key into the module ────────────────────────────────────
const source = fs.readFileSync(SIG_MODULE, "utf8");
const block =
  "export const TRUSTED_KEYS = [\n" +
  "  // Placeholder replaced by `node scripts/generate-signing-key.mjs`.\n" +
  "  // Until a real key is present, tag releases cannot be verified and installs from\n" +
  "  // a tag are refused with a clear message instead of silently trusting the bytes.\n" +
  "  {\n" +
  '    id: "dev-placeholder",\n' +
  '    publicKey: "",\n' +
  "  },\n" +
  "];";
if (!source.includes(block)) {
  fail(
    "lib/release-signature.js 里的 TRUSTED_KEYS 占位块已不是预期形态。\n" +
      "  可能已经填过公钥，或文件被改过。请手动检查，本脚本不猜测。",
  );
}
const replacement =
  "export const TRUSTED_KEYS = [\n" +
  "  // 生成于 " + new Date().toISOString().slice(0, 10) + "，指纹见 docs/update-signing.md。\n" +
  "  // 轮换时新增一项，不要替换现有项（见该文档「密钥轮换」）。\n" +
  "  {\n" +
  '    id: "release-2026",\n' +
  `    publicKey:\n      "${publicB64}",\n` +
  "  },\n" +
  "];";
fs.writeFileSync(SIG_MODULE, source.replace(block, replacement), "utf8");
console.log("✓ 公钥已写入 lib/release-signature.js");

// ── 6. hand over the remaining manual steps ──────────────────────────────────
const fp = fingerprint(publicB64);
console.log(`
密钥指纹（SHA-256 前 16 字节）：${fp}

接下来三步，按顺序做：

  1. 把私钥存进密码管理器 / 离线介质（备份已在上面那个目录里，
     但真正的安全副本应该离开这台机器）。

  2. 设进 GitHub Secrets（PowerShell 语法，注意不是 < 重定向）：

       Get-Content "${backupKey}" -Raw | gh secret set RELEASE_SIGNING_KEY

     验证：

       gh secret list

  3. 确认上面两步都成功之后，才删除本地私钥：

       Remove-Item "${backupKey}"

  然后提交：

       git add lib/release-signature.js
       git commit -m "feat: 启用发布验签公钥"

验证验签已就绪：

       node -e "import('./lib/release-signature.js').then(m=>console.log('trusted key:', m.hasTrustedKey()))"
`);
