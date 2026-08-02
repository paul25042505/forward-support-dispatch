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
