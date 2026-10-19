#!/usr/bin/env node
/**
 * Wire a release-signing key into the plugin.
 *
 * Two modes:
 *
 *   node scripts/setup-signing-key.mjs
 *       Generate a fresh Ed25519 pair, back it up outside the repo, verify the
 *       backup works, then write the public key into lib/release-signature.js.
 *
 *   node scripts/setup-signing-key.mjs --import <openssh-key-file>
 *       Import an existing OpenSSH Ed25519 private key (e.g. one exported from a
 *       password manager's "generate SSH key" feature). Converts it to PKCS8 for
 *       local signing and writes the matching public key into the module.
 *
 * Why the ordering matters: an earlier version of these instructions told the
 * operator to delete the private key *before* confirming a backup existed. That
 * lost the key outright. This script never deletes anything and refuses to
 * continue unless it has proven the key material is readable and usable.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isOpenSshPrivateKey, openSshEd25519ToPkcs8 } from "../lib/openssh-key.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SIG_MODULE = path.join(ROOT, "lib", "release-signature.js");
const BACKUP_DIR = path.join(os.homedir(), "dsh-purge-signing-backup");
const BACKUP_KEY = path.join(BACKUP_DIR, "dsh-purge-signing.key");

const PLACEHOLDER_BLOCK =
  "export const TRUSTED_KEYS = [\n" +
  "  // Placeholder replaced by `node scripts/generate-signing-key.mjs`.\n" +
  "  // Until a real key is present, tag releases cannot be verified and installs from\n" +
  "  // a tag are refused with a clear message instead of silently trusting the bytes.\n" +
  "  {\n" +
  '    id: "dev-placeholder",\n' +
  '    publicKey: "",\n' +
  "  },\n" +
  "];";

function fail(message) {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

/** Replace the placeholder keyring with a real public key. Refuses to guess. */
function writePublicKey(publicB64) {
  const source = fs.readFileSync(SIG_MODULE, "utf8");
  if (!source.includes(PLACEHOLDER_BLOCK)) {
    fail(
      "lib/release-signature.js 的 TRUSTED_KEYS 已不是占位形态。\n" +
        "  可能已经填过公钥，或文件被改过。请手动检查；本脚本不猜测、不覆盖。",
    );
  }
  const replacement =
    "export const TRUSTED_KEYS = [\n" +
    `  // 生成于 ${new Date().toISOString().slice(0, 10)}，指纹见 docs/update-signing.md。\n` +
    "  // 轮换时新增一项，不要替换现有项（见该文档「密钥轮换」）。\n" +
    "  {\n" +
    '    id: "release-2026",\n' +
    `    publicKey:\n      "${publicB64}",\n` +
    "  },\n" +
    "];";
  fs.writeFileSync(SIG_MODULE, source.replace(PLACEHOLDER_BLOCK, replacement), "utf8");
  console.log("✓ 公钥已写入 lib/release-signature.js");
}

function printHandover(privateKeyPath, publicB64) {
  const der = Buffer.from(publicB64, "base64");
  const fp = crypto.createHash("sha256").update(der).digest("hex");
  console.log(`
公钥（SPKI base64）：${publicB64}
密钥指纹（SPKI SHA-256）：${fp.slice(0, 16).replace(/(.{4})/g, "$1 ").trim()}

接下来三步：

  1. 把私钥存进密码管理器 / 离线介质。

  2. 设进 GitHub Secrets（PowerShell 语法，注意不是 < 重定向）：

       Get-Content "${privateKeyPath}" -Raw | gh secret set RELEASE_SIGNING_KEY

     验证：gh secret list

  3. 确认上面两步都成功之后，才删除本地私钥：

       Remove-Item "${privateKeyPath}"

  提交：

       git add lib/release-signature.js
       git commit -m "feat: 启用发布验签公钥"

验证：

       node -e "import('./lib/release-signature.js').then(m=>console.log('trusted key:', m.hasTrustedKey()))"
`);
}

// ── import mode ───────────────────────────────────────────────────────────────
const importIndex = process.argv.indexOf("--import");
if (importIndex !== -1) {
  const src = process.argv[importIndex + 1];
  if (!src) fail("--import 需要一个私钥文件路径");
  const file = path.resolve(src);
  if (!fs.existsSync(file)) fail(`文件不存在：${file}`);

  const text = fs.readFileSync(file, "utf8");
  if (!isOpenSshPrivateKey(text)) {
    fail(
      "这不是 OpenSSH 私钥（缺 -----BEGIN OPENSSH PRIVATE KEY-----）。\n" +
        "  如果它已经是 PKCS8 PEM，直接用 RELEASE_SIGNING_KEY 指向它即可，无需导入。",
    );
  }

  let imported;
  try {
    imported = openSshEd25519ToPkcs8(text);
  } catch (e) {
    fail(`导入失败：${e.message}`);
  }
  console.log("✓ OpenSSH 私钥解析成功，签名/验签自检通过");
  console.log(`✓ OpenSSH 指纹：SHA256:${imported.sshFingerprint}`);

  // Persist the PKCS8 form outside the repo so local signing works.
  fs.mkdirSync(BACKUP_DIR, { recursive: true, mode: 0o700 });
  const target = path.join(BACKUP_DIR, "dsh-purge-signing.key");
  if (fs.existsSync(target)) {
    fail(
      `备份目录里已有私钥：${target}\n` +
        "  先确认它是否还需要，移走后再导入，避免覆盖。",
    );
  }
  fs.writeFileSync(target, imported.pkcs8Pem, { mode: 0o600 });
  fs.writeFileSync(`${target}.pub`, `${imported.publicB64}\n`, "utf8");

  // Prove the written file is usable before wiring anything.
  const reread = crypto.createPrivateKey({ key: fs.readFileSync(target, "utf8"), format: "pem" });
  const sample = Buffer.from("post-write check", "utf8");
  const pub = crypto.createPublicKey(reread);
  if (!crypto.verify(null, sample, pub, crypto.sign(null, sample, reread))) {
    fail(`写出的私钥不可用：${target} —— 不要删除任何东西，先检查磁盘。`);
  }
  console.log(`✓ PKCS8 私钥已写入仓库外：${target}`);

  writePublicKey(imported.publicB64);
  printHandover(target, imported.publicB64);
  process.exit(0);
}

// ── generate mode ─────────────────────────────────────────────────────────────
console.log("dsh-purge 签名密钥设置\n");
if (fs.existsSync(BACKUP_KEY)) {
  fail(
    `已存在 ${BACKUP_KEY}\n` +
      "  如果这是正在用的密钥，先备份并移走，再重跑。覆盖会让已发布的签名全部失效。",
  );
}

const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
const privatePem = privateKey.export({ format: "pem", type: "pkcs8" });
const publicB64 = publicKey.export({ format: "der", type: "spki" }).toString("base64");

const sample = Buffer.from("dsh-purge key self test", "utf8");
if (!crypto.verify(null, sample, publicKey, crypto.sign(null, sample, privateKey))) {
  fail("生成的密钥对自检失败");
}
console.log("✓ 已生成 Ed25519 密钥对并通过自检");

fs.mkdirSync(BACKUP_DIR, { recursive: true, mode: 0o700 });
fs.writeFileSync(BACKUP_KEY, privatePem, { mode: 0o600 });
fs.writeFileSync(`${BACKUP_KEY}.pub`, `${publicB64}\n`, "utf8");
console.log(`✓ 私钥已备份到仓库外：${BACKUP_KEY}`);

const reread = crypto.createPrivateKey({ key: fs.readFileSync(BACKUP_KEY, "utf8"), format: "pem" });
if (!crypto.verify(null, sample, crypto.createPublicKey(reread), crypto.sign(null, sample, reread))) {
  fail(`备份文件不可用：${BACKUP_KEY}\n  不要删除任何东西，先检查磁盘。`);
}
console.log("✓ 备份文件已验证可用（重新读取后签名/验签通过）");

writePublicKey(publicB64);
printHandover(BACKUP_KEY, publicB64);
