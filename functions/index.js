const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { getAuth } = require("firebase-admin/auth");

initializeApp();
const db = getFirestore();
const auth = getAuth();

// 前支任務派遣中心專用：承辦人／管理員幫申請單位重設登入密碼。
// Firebase Auth 的密碼是單向雜湊，就算是後端 Admin SDK 也讀不出既有密碼
// （這是「看密碼」做不到、只能「重設密碼」的根本原因），所以這裡只提供
// 覆蓋成新密碼，不提供查詢舊密碼。
//
// 申請單位帳號用的是合成信箱（xxx@fsr.local），本來就收不到信，沒辦法走
// Firebase 內建的忘記密碼寄信流程，只能靠這支後端函式用 Admin SDK 直接改。
exports.resetApplicantPassword = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "請先登入");
  }
  const callerDoc = await db.collection("users").doc(request.auth.uid).get();
  const callerRole = callerDoc.exists ? callerDoc.data().fsr_role : null;
  if (callerRole !== "dispatcher" && callerRole !== "admin") {
    throw new HttpsError("permission-denied", "只有業務承辦人或管理員能重設申請單位密碼");
  }

  const targetUid = request.data && request.data.targetUid;
  const newPassword = request.data && request.data.newPassword;
  if (!targetUid || typeof targetUid !== "string") {
    throw new HttpsError("invalid-argument", "缺少要重設的帳號");
  }
  if (!newPassword || typeof newPassword !== "string" || newPassword.length < 6) {
    throw new HttpsError("invalid-argument", "新密碼至少需要 6 碼");
  }

  // 限定目標一定要是「申請單位」帳號本人——避免這支函式被拿來重設其他
  // 內部人員／衛生營系統帳號的密碼（那些不是這支函式要處理的範圍）。
  const targetProfile = await db.collection("forward_support_applicant_profiles").doc(targetUid).get();
  if (!targetProfile.exists || targetProfile.data().fsr_role !== "applicant") {
    throw new HttpsError("not-found", "找不到這個申請單位帳號");
  }

  await auth.updateUser(targetUid, { password: newPassword });
  return { ok: true };
});

const SELF_RESET_MAX_ATTEMPTS = 5;
const SELF_RESET_WINDOW_MS = 15 * 60 * 1000;

// 申請單位自己「忘記密碼」時用：不用登入，靠單位代碼＋註冊時登記的承辦人
// 手機號碼兩者對上就能直接設新密碼，驗證強度跟現在打電話給業務承辦人口頭
// 核對是同一個水準。單位代碼本身是公開的（forward_support_units 開放任何
// 人讀取），所以這裡額外做失敗次數鎖定，避免有人拿單位代碼窮舉手機號碼。
exports.selfResetApplicantPassword = onCall(async (request) => {
  const unitCode = ((request.data && request.data.unitCode) || "").trim();
  const phone = ((request.data && request.data.phone) || "").trim();
  const newPassword = request.data && request.data.newPassword;
  if (!unitCode) {
    throw new HttpsError("invalid-argument", "缺少單位代碼");
  }
  if (!phone) {
    throw new HttpsError("invalid-argument", "缺少登記的手機號碼");
  }
  if (!newPassword || typeof newPassword !== "string" || newPassword.length < 6) {
    throw new HttpsError("invalid-argument", "新密碼至少需要 6 碼");
  }

  const attemptRef = db.collection("forward_support_pw_reset_attempts").doc(unitCode);
  const attemptSnap = await attemptRef.get();
  const now = Date.now();
  const attempt = attemptSnap.exists ? attemptSnap.data() : null;
  const withinWindow = attempt && (now - attempt.lastAt) < SELF_RESET_WINDOW_MS;
  if (withinWindow && attempt.count >= SELF_RESET_MAX_ATTEMPTS) {
    throw new HttpsError("resource-exhausted", "嘗試次數過多，請稍後再試，或洽業務承辦人協助重設");
  }

  const snap = await db.collection("forward_support_applicant_profiles")
    .where("unitCode", "==", unitCode)
    .where("contactPhone", "==", phone)
    .limit(1)
    .get();

  if (snap.empty) {
    await attemptRef.set({ count: withinWindow ? attempt.count + 1 : 1, lastAt: now });
    throw new HttpsError("not-found", "單位代碼或登記的手機號碼不正確");
  }

  await attemptRef.delete().catch(() => {});
  const targetUid = snap.docs[0].id;
  await auth.updateUser(targetUid, { password: newPassword });
  return { ok: true };
});

// 管理員刪除申請單位帳號時，把底層 Firebase Auth 帳號也一併刪除。
// 「刪除帳號」原本只刪 Firestore 資料（forward_support_applicant_profiles／
// forward_support_units），Auth 帳號（單位代碼對應的合成 email）一直留著；
// 如果同一個單位代碼之後被別的單位拿去註冊，會撞到「email 已存在」，改成
// 用新輸入的密碼嘗試登入舊帳號，密碼當然對不上，顯示「單位或密碼錯誤」——
// 「單位代碼會被釋出給別人註冊」這件事實際上沒有真的成立。只有 Admin SDK
// 能刪除別人的 Auth 帳號，前端做不到，所以需要這支函式。限管理員呼叫，
// 對齊 forward_support_applicant_profiles 的 allow delete: if isFsrAdmin()。
exports.deleteApplicantAuthAccount = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "請先登入");
  }
  const callerDoc = await db.collection("users").doc(request.auth.uid).get();
  const callerRole = callerDoc.exists ? callerDoc.data().fsr_role : null;
  if (callerRole !== "admin") {
    throw new HttpsError("permission-denied", "只有管理員能刪除申請單位帳號");
  }

  const targetUid = request.data && request.data.targetUid;
  if (!targetUid || typeof targetUid !== "string") {
    throw new HttpsError("invalid-argument", "缺少要刪除的帳號");
  }

  const targetProfile = await db.collection("forward_support_applicant_profiles").doc(targetUid).get();
  if (!targetProfile.exists || targetProfile.data().fsr_role !== "applicant") {
    throw new HttpsError("not-found", "找不到這個申請單位帳號");
  }

  try {
    await auth.deleteUser(targetUid);
  } catch (e) {
    // 已經刪過 Auth 帳號（例如上次呼叫成功但後續 Firestore 刪除失敗，
    // 管理員重試一次）算是達成目的，不當成錯誤擋下來。
    if (e.code !== "auth/user-not-found") throw e;
  }
  return { ok: true };
});
