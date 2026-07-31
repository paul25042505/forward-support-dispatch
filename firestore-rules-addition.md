# Firestore 安全規則補充

這份規則要**加進**衛生營系統（medical-battalion-tracker）現有的 `firestore.rules` 裡（Firebase 主控台 → Firestore Database → 規則），不要整份覆蓋掉，找到 `match /databases/{database}/documents { ... }` 區塊，在裡面加入以下 `match` 區段即可，不動到原本衛生營的規則。

```
    // ============ 前支任務申請系統 ============

    function fsrRole() {
      return get(/databases/$(database)/documents/users/$(request.auth.uid)).data.fsr_role;
    }
    function fsrUnitName() {
      return get(/databases/$(database)/documents/users/$(request.auth.uid)).data.fsr_unitName;
    }
    function isDispatcher() { return request.auth != null && fsrRole() in ['dispatcher','admin']; }
    function isApplicant() { return request.auth != null && fsrRole() == 'applicant'; }
    function isUnitRole()  { return request.auth != null && fsrRole() in ['battalion_hq','company1','company2']; }
    function unitLabel() {
      return {'battalion_hq':'營部','company1':'一連','company2':'二連'}[fsrRole()];
    }

    // 外部單位清單：註冊頁需要「未登入前」讀取才能選單位，因此開放公開讀取；
    // 內容僅為單位名稱，不含任何申請或個資，開放讀取風險低。
    match /forward_support_units/{unitId} {
      allow read: if true;
      allow create: if request.auth != null;
      allow update, delete: if isDispatcher();
    }

    match /forward_support_requests/{reqId} {
      allow read: if request.auth != null && (
        isDispatcher() ||
        (isApplicant() && resource.data.createdBy == request.auth.uid) ||
        (isUnitRole() && resource.data.assignedUnit == unitLabel())
      );
      allow create: if isApplicant()
        && request.resource.data.createdBy == request.auth.uid
        && request.resource.data.applicantUnit == fsrUnitName()
        && request.resource.data.status == 'pending';
      // 承辦人：審核／分發／駁回。各連：只能把自己被分發到的任務改成 filled。
      allow update: if isDispatcher()
        || (isUnitRole() && resource.data.assignedUnit == unitLabel()
            && resource.data.status == 'assigned'
            && request.resource.data.status == 'filled');
      allow delete: if false;
    }

    match /forward_support_assignments/{aId} {
      allow read: if isDispatcher() || isUnitRole();
      allow create: if isUnitRole()
        && request.resource.data.unit == unitLabel()
        && request.resource.data.filledBy == request.auth.uid;
      allow update, delete: if false;
    }
```

## 使用者角色設定（`users/{uid}` 文件）

本系統沿用衛生營既有的 `users` collection，但額外用這兩個欄位標記「前支任務申請系統」裡的角色，跟衛生營原本的角色欄位分開，不會互相干擾：

| 欄位 | 說明 |
|---|---|
| `fsr_role` | `applicant`（申請單位）／`dispatcher`（承辦人）／`battalion_hq`（營部）／`company1`（一連）／`company2`（二連）／`admin`（管理者） |
| `fsr_unitName` | 僅申請單位（applicant）需要，登記單位全名 |

**外部單位（applicant）** 會透過 App 內的註冊流程自動建立 `fsr_role: "applicant"`，不需要你手動處理。

**承辦人 / 營部 / 一連 / 二連 / 管理者** 這幾個角色因為你說「衛生營資料庫裡原本就有這些人的帳號」，麻煩你到 Firebase 主控台的 Firestore Database → `users` collection，找到對應的人員文件，手動加上 `fsr_role` 欄位（值參照上表），這樣他們登入本系統時才會被導向正確的介面。

若你想改成自動判斷（例如比對衛生營原有的角色欄位自動對應成 fsr_role），跟我說，我可以把這段邏輯寫進程式碼，就不用手動一個個加了。
