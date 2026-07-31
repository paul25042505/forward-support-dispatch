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

## 補充：任務刪除、前支種類標籤（第 4 版新增）

「任務」卡片現在多了「編輯／複製到其他日期／刪除」選單。編輯跟複製都是既有的 `update`／`create` 權限就能做，但**刪除**目前完全被擋住（`allow delete: if false;`），需要放寬成：**只有承辦人／管理者能刪除「自己內部建立」的任務**（`createdByDispatcher == true`），外部單位送來的申請仍然不能刪除、只能駁回，維持原本的稽核設計。

把原本 `forward_support_requests` 區塊裡的這一行：
```
      allow delete: if false;
```
改成：
```
      allow delete: if isDispatcher() && resource.data.createdByDispatcher == true;
```

另外新增了「前支種類標籤」功能（`forward_support_tags` collection，管理者在「更多」頁新增/編輯/刪除標籤，承辦人在建立/編輯任務時挑選），需要在 `match /databases/{database}/documents { ... }` 區塊裡**新增**這個 `match`：
```
    match /forward_support_tags/{tagId} {
      allow read: if isDispatcher();
      allow write: if request.auth != null && fsrRole() == 'admin';
    }
```

## 補充：管理者管理內部人員角色與申請單位帳號（第 3 版新增）

「單位帳號」頁面現在多了「設定內部人員角色」功能，**管理者**（`fsr_role == 'admin'`）需要能：
- 用 email 查詢任何一個 `users` 文件（不限角色，因為對方可能還沒設定過 `fsr_role`）
- 讀取所有 `fsr_role` 屬於前支任務系統角色的 `users` 文件
- 更新任何 `users` 文件的 `fsr_role` 欄位

這個權限只開放給 `admin`，**承辦人（dispatcher）不行**，跟系統角色權限表一致。

把 `fsrRole()` 之後加這行：
```
    function isAdmin() { return request.auth != null && fsrRole() == 'admin'; }
```

**你的 `users/{uid}` 應該原本就已經有一個 `match` 區塊**（衛生營系統既有的），**不要再另外新增一個 `match /users/{uid} {...}`**（Firestore 不允許同一路徑重複定義），而是把下面這兩條加進「原本那個區塊」的 `allow read` 和 `allow update` 條件裡，用 `||` 串接（**這條會取代第 2 版加的那條**，範圍更廣，涵蓋內部人員 + 申請單位）：

```
      allow read: if <你原本的條件...> || isAdmin();
      allow update: if <你原本的條件...> || isAdmin();
```

如果你不確定原本的規則長怎樣，把你 Firestore 規則裡 `match /users/{uid} { ... }` 那一段貼給我，我幫你改好整段直接貼回去。

## 使用者角色設定（`users/{uid}` 文件）

本系統沿用衛生營既有的 `users` collection，但額外用這兩個欄位標記「前支任務申請系統」裡的角色，跟衛生營原本的角色欄位分開，不會互相干擾：

| 欄位 | 說明 |
|---|---|
| `fsr_role` | `applicant`（申請單位）／`dispatcher`（承辦人）／`battalion_hq`（營部）／`company1`（一連）／`company2`（二連）／`admin`（管理者） |
| `fsr_unitName` | 僅申請單位（applicant）需要，登記單位全名 |

**外部單位（applicant）** 會透過 App 內的註冊流程自動建立 `fsr_role: "applicant"`，不需要你手動處理。

**承辦人 / 營部 / 一連 / 二連 / 管理者** 這幾個角色因為你說「衛生營資料庫裡原本就有這些人的帳號」，麻煩你到 Firebase 主控台的 Firestore Database → `users` collection，找到對應的人員文件，手動加上 `fsr_role` 欄位（值參照上表），這樣他們登入本系統時才會被導向正確的介面。

若你想改成自動判斷（例如比對衛生營原有的角色欄位自動對應成 fsr_role），跟我說，我可以把這段邏輯寫進程式碼，就不用手動一個個加了。
