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
 *   node scripts/setup-signing-key.mjs --clipboard
 *       Same, but read the key from the Windows clipboard. Use this when the
 *       password manager only allows copying the key, not downloading it.
 *
 *   node scripts/setup-signing-key.mjs --stdin
 *       Same, but read from standard input (pipe, or paste then Ctrl+Z + Enter).
 *
 * Why the ordering matters: an earlier version of these instructions told the
 * operator to delete the private key *before* confirming a backup existed. That
 * lost the key outright. This script never deletes anything and refuses to
 * continue unless it has proven the key material is readable and usable.
 */
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
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

/**
 * Decide, WITHOUT writing anything, whether the keyring can be updated.
 *
 * This check must run before any private key is persisted. An earlier version
 * wrote the private key first and only then discovered the keyring was not in
 * placeholder form — leaving a half-applied state (new private key on disk, old
 * public key in code) that silently fails to sign verifiable releases.
 *
 * @param {string} publicB64
 * @returns {string} the file content to write
 */
function planPublicKeyWrite(publicB64) {
  const source = fs.readFileSync(SIG_MODULE, "utf8");
  if (source.includes(PLACEHOLDER_BLOCK)) {
    return source.replace(
      PLACEHOLDER_BLOCK,
      "export const TRUSTED_KEYS = [\n" +
        `  // 生成于 ${new Date().toISOString().slice(0, 10)}，指纹见 docs/update-signing.md。\n` +
        "  // 轮换时新增一项，不要替换现有项（见该文档「密钥轮换」）。\n" +
        "  {\n" +
        '    id: "release-2026",\n' +
        `    publicKey:\n      "${publicB64}",\n` +
        "  },\n" +
        "];",
    );
  }

  // Already configured: allow replacing an entry that carries the same id, but
  // only when it is the sole entry — i.e. this repo has not shipped a release yet.
  // Once more than one key exists we are in a rotation window and must not guess.
  const keys = [...source.matchAll(/id:\s*"([^"]+)",\s*\n\s*publicKey:\s*\n?\s*"([^"]*)"/g)];
  if (keys.length === 0) {
    fail(
      "lib/release-signature.js 里找不到可识别的 TRUSTED_KEYS 条目。\n" +
        "  文件可能被改过。请手动检查；本脚本不猜测、不覆盖。",
    );
  }
  if (keys.length > 1) {
    fail(
      `TRUSTED_KEYS 里已有 ${keys.length} 个密钥，处于轮换窗口。\n` +
        "  此时替换会让只信任旧公钥的客户端拒绝新版本。请手动按文档「密钥轮换」流程处理。",
    );
  }
  const [, id, current] = keys[0];
  if (current === publicB64) {
    return source; // already correct, nothing to do
  }
  const updated = source.replace(
    /(id:\s*"[^"]+",\s*\n\s*publicKey:\s*\n?\s*)"[^"]*"/,
    `$1"${publicB64}"`,
  );
  if (updated === source) {
    fail("无法定位 TRUSTED_KEYS 里的 publicKey 字段，请手动更新。");
  }
  console.log(`✓ 将替换 TRUSTED_KEYS 中 id=${id} 的公钥（当前仓库尚未发布过 Release，可安全替换）`);
  return updated;
}

/** Replace the keyring with a real public key. Refuses to guess. */
function writePublicKey(publicB64) {
  const next = planPublicKeyWrite(publicB64);
  fs.writeFileSync(SIG_MODULE, next, "utf8");
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
// Three ways in, because password managers often offer only "copy" (no download):
//   --import <file>   read the key from a file
//   --stdin           read the key from standard input (pipe, or paste + Ctrl+Z/Enter)
//   --clipboard       read the key from the Windows clipboard (Get-Clipboard)
// Only the file form is written to disk by the caller; the other two never touch
// a temp file, which is the point when the key cannot be downloaded.
const importIndex = process.argv.indexOf("--import");
const useStdin = process.argv.includes("--stdin");
const useClipboard = process.argv.includes("--clipboard");

if (importIndex !== -1 || useStdin || useClipboard) {
  let text = "";
  let sourceLabel = "";

  if (importIndex !== -1) {
    const src = process.argv[importIndex + 1];
    if (!src) fail("--import 需要一个私钥文件路径");
    const file = path.resolve(src);
    if (!fs.existsSync(file)) fail(`文件不存在：${file}`);
    text = fs.readFileSync(file, "utf8");
    sourceLabel = file;
  } else if (useClipboard) {
    try {
      text = execFileSync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", "Get-Clipboard -Raw"],
        { encoding: "utf8", windowsHide: true, timeout: 15000 },
      );
    } catch (e) {
      fail(`读取剪贴板失败：${e.message}\n  改用 --stdin，把私钥粘贴进去再按 Ctrl+Z 回车。`);
    }
    sourceLabel = "剪贴板";
  } else {
    text = fs.readFileSync(0, "utf8");
    sourceLabel = "标准输入";
  }

  if (text.trim() === "") fail(`${sourceLabel} 里没有内容。`);

  if (!isOpenSshPrivateKey(text)) {
    fail(
      `${sourceLabel} 的内容不是 OpenSSH 私钥（缺 -----BEGIN OPENSSH PRIVATE KEY-----）。\n` +
        "  常见原因：复制时漏了 BEGIN/END 行，或被编辑器插入了多余字符。\n" +
        "  如果它已经是 PKCS8 PEM，直接用 RELEASE_SIGNING_KEY 指向它即可，无需导入。",
    );
  }
  console.log(`✓ 已从${sourceLabel}读取私钥`);

  let imported;
  try {
    imported = openSshEd25519ToPkcs8(text);
  } catch (e) {
    fail(`导入失败：${e.message}`);
  }
  console.log("✓ OpenSSH 私钥解析成功，签名/验签自检通过");
  console.log(`✓ OpenSSH 指纹：SHA256:${imported.sshFingerprint}`);

  // Order matters: validate every precondition BEFORE touching the filesystem.
  // A previous version wrote the private key first, then failed on the keyring,
  // leaving a new private key next to an old public key — signing then produces
  // releases that no client can verify.
  const target = path.join(BACKUP_DIR, "dsh-purge-signing.key");
  if (fs.existsSync(target)) {
    fail(
      `备份目录里已有私钥：${target}\n` +
        "  先确认它是否还需要，移走后再导入，避免覆盖。",
    );
  }
  const plannedSource = planPublicKeyWrite(imported.publicB64);

  // All checks passed; now persist.
  fs.mkdirSync(BACKUP_DIR, { recursive: true, mode: 0o700 });
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

  // Use the content validated before the write, so no second validation pass can
  // disagree with what was checked.
  fs.writeFileSync(SIG_MODULE, plannedSource, "utf8");
  console.log("✓ 公钥已写入 lib/release-signature.js");
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
