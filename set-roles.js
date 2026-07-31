/**
 * set-roles.js
 * 依 roles.json 裡的「email → fsr_role」對照表，批次幫使用者的
 * Firestore users/{uid} 文件加上 fsr_role 欄位。
 *
 * 用法：
 *   1. npm install firebase-admin
 *   2. 把 Firebase 服務帳戶金鑰存成 service-account.json（跟這個腳本放同一層）
 *   3. 編輯 roles.json，填入每個人的 email 對應角色
 *   4. node set-roles.js
 *
 * fsr_role 合法值：dispatcher / battalion_hq / company1 / company2 / admin
 */
const admin = require("firebase-admin");
const fs = require("fs");
const path = require("path");

const serviceAccountPath = path.join(__dirname, "service-account.json");
const rolesPath = path.join(__dirname, "roles.json");

if (!fs.existsSync(serviceAccountPath)) {
  console.error("找不到 service-account.json，請先從 Firebase 主控台 → 專案設定 → 服務帳戶 產生金鑰並存成這個檔名。");
  process.exit(1);
}
if (!fs.existsSync(rolesPath)) {
  console.error("找不到 roles.json，請參考 roles.example.json 建立。");
  process.exit(1);
}

const serviceAccount = require(serviceAccountPath);
const roles = JSON.parse(fs.readFileSync(rolesPath, "utf8"));

const VALID_ROLES = ["dispatcher", "battalion_hq", "company1", "company2", "admin"];

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const auth = admin.auth();
const db = admin.firestore();

async function main() {
  const entries = Object.entries(roles);
  console.log(`共 ${entries.length} 筆待設定...`);
  let ok = 0, fail = 0;

  for (const [email, role] of entries) {
    if (!VALID_ROLES.includes(role)) {
      console.error(`[跳過] ${email} 的角色 "${role}" 不合法，合法值：${VALID_ROLES.join(", ")}`);
      fail++;
      continue;
    }
    try {
      const userRecord = await auth.getUserByEmail(email);
      await db.collection("users").doc(userRecord.uid).set(
        { fsr_role: role, email },
        { merge: true } // merge:true 不會動到衛生營系統原本在這份文件裡的其他欄位
      );
      console.log(`[成功] ${email} → ${role}（uid: ${userRecord.uid}）`);
      ok++;
    } catch (e) {
      console.error(`[失敗] ${email}：${e.message}`);
      fail++;
    }
  }

  console.log(`\n完成。成功 ${ok} 筆，失敗 ${fail} 筆。`);
  process.exit(0);
}

main();
