# Firestore 安全規則補充

## ⚠️ 第 5 版（目前唯一正確版本，取代下面第 1～4 版的假設）

之前第 1～4 版都是假設 `medical-battalion-tracker` 的 Firestore 規則長得很單純（`users` 集合只有一個簡單的 `match` 區塊）。但 2026-07-31 晚上你貼出實際的規則後才發現：**真正在用的規則是一份非常完整、複雜的規則**（屬於「衛生營車輛人員動態管制系統」），角色欄位用的是 `role`/`unit`（不是我們的 `fsr_role`/`fsr_unitName`），而且裡面**完全沒有** `forward_support_*` 的任何內容。

**重要提醒：** Firestore 規則是整份檔案覆蓋，不是合併。你的車輛人員動態管制系統只要重新部署一次自己的規則，就會把下面這段前支任務系統的規則整個蓋掉，導致前支系統又開始出現權限錯誤。**每次車輛人員系統那邊改規則、重新部署後，都要記得把下面這段補回去**，或是請維護那個系統的人（或那邊的 Claude session）以後改規則時保留這段。

### 怎麼貼

1. 前往 Firebase 主控台 → `medical-battalion-tracker` 專案 → Firestore Database → 規則
2. 找到 `match /users/{uid} { ... }` 區塊裡的 `allow update` 那一段（結尾應該是 `onlyChanged(['displayName','rank','phone','emtLevel'...`），在最後一個 `||` 條件後面、右括號 `;` 之前，加上這一行（記得補上 `||`）：

```
                    || (isFsrAdmin() && onlyChanged(['fsr_role','fsr_unitName']));
```

（`allow read` 不用改，現有的 `isActive()` 已經夠寬，任何在職帳號都能讀到別人的 `users` 文件。）

3. 在 `match /databases/{database}/documents { ... }` 區塊的**最後面**（例如 `campRegistrations` 那個 `match` 區塊後面、最後兩個 `}` 之前）整段貼上：

```
    // ============ 前支任務申請系統（forward_support_dispatch）============
    // 共用本專案的 users 集合，但用 fsr_role / fsr_unitName 這兩個獨立欄位，
    // 跟衛生營系統原本的 role / unit 完全分開，不會互相干擾。
    function fsrRole() { return myUserDoc().fsr_role; }
    function fsrUnitName() { return myUserDoc().fsr_unitName; }
    function isFsrAdmin() { return isSignedIn() && fsrRole() == 'admin'; }
    function isFsrDispatcher() { return isSignedIn() && fsrRole() in ['dispatcher', 'admin']; }
    function isFsrApplicant() { return isSignedIn() && fsrRole() == 'applicant'; }
    function isFsrUnitRole() { return isSignedIn() && fsrRole() in ['battalion_hq', 'company1', 'company2']; }
    function fsrUnitLabel() {
      return {'battalion_hq': '營部', 'company1': '一連', 'company2': '二連'}[fsrRole()];
    }

    match /forward_support_units/{unitId} {
      allow read: if true;
      allow create: if isSignedIn();
      allow update, delete: if isFsrDispatcher();
    }

    match /forward_support_requests/{reqId} {
      allow read: if isSignedIn() && (
        isFsrDispatcher() ||
        (isFsrApplicant() && resource.data.createdBy == request.auth.uid) ||
        (isFsrUnitRole() && resource.data.assignedUnit == fsrUnitLabel())
      );
      // 兩種建立來源：承辦人/管理者自己登記（新增任務／複製到其他日期功能）；
      // 或外部申請單位透過申請人站送出。
      allow create: if
        (isFsrDispatcher() && request.resource.data.createdBy == request.auth.uid
          && request.resource.data.createdByDispatcher == true)
        || (isFsrApplicant() && request.resource.data.createdBy == request.auth.uid
          && request.resource.data.applicantUnit == fsrUnitName()
          && request.resource.data.status == 'pending');
      // 承辦人：審核／分發／駁回／編輯。各連：只能把自己被分發到的任務改成 filled。
      allow update: if isFsrDispatcher()
        || (isFsrUnitRole() && resource.data.assignedUnit == fsrUnitLabel()
            && resource.data.status == 'assigned'
            && request.resource.data.status == 'filled');
      // 只有承辦人/管理者能刪除「自己內部建立」的任務，外部單位送來的申請不能刪除。
      allow delete: if isFsrDispatcher() && resource.data.createdByDispatcher == true;
    }

    match /forward_support_assignments/{aId} {
      allow read: if isFsrDispatcher() || isFsrUnitRole();
      allow create: if isFsrUnitRole()
        && request.resource.data.unit == fsrUnitLabel()
        && request.resource.data.filledBy == request.auth.uid;
      allow update, delete: if false;
    }

    match /forward_support_tags/{tagId} {
      allow read: if isFsrDispatcher();
      allow write: if isFsrAdmin();
    }

    match /forward_support_task_presets/{presetId} {
      allow read: if isFsrDispatcher();
      allow write: if isFsrAdmin();
    }
```

貼完兩處後按「發布」。這樣就涵蓋：登入角色判斷、任務讀寫、承辦人自建任務、複製到其他日期、編輯、刪除、標籤系統、常用任務名稱快速選單、單位帳號與內部人員角色設定（透過 `users/{uid}` 那行 `fsr_role`/`fsr_unitName` 的放行）。

### 2026-08-01 新增：常用任務名稱（forward_support_task_presets）

如果你是**先前已經貼過**第 5 版規則的情況，只需要額外找到 `match /forward_support_tags/{tagId} { ... }` 那個區塊，在它後面（`}` 之後）加上：

```
    match /forward_support_task_presets/{presetId} {
      allow read: if isFsrDispatcher();
      allow write: if isFsrAdmin();
    }
```

貼上後按「發布」即可，不用動到其他部分。

### ⚠️ 2026-08-01 新增：申請單位站（外部單位自行註冊／登入）

前支任務系統現在有了外部申請單位自己的登入頁：**第一次用「單位代碼＋單位全銜＋承辦人資訊＋密碼」註冊**，之後**選單位＋輸入密碼登入**。技術上是用 Firebase Auth 的 Email/Password 登入方式，把「單位代碼」轉成一個內部合成的 email（例如 `a123@fsr.local`），不是申請單位真正的信箱。

**這個功能需要兩件事，缺一都不能用：**

**1. 先在 Firebase 主控台開通 Email/Password 登入方式**（這步不是規則，是另一個設定）：
   - Firebase 主控台 → `medical-battalion-tracker` 專案 → Authentication → Sign-in method
   - 找到 **Email/Password**，點進去開啟（Enable），儲存
   - 如果沒開這個，申請單位註冊/登入時會看到「系統尚未開通申請單位登入方式」的錯誤

**2. 規則要新增一個獨立的集合給申請單位專用**

（⚠️ 2026-08-01 更正第二版：一開始是讓申請單位跟衛生營人員共用同一個 `users` 集合，只用 `fsr_role` 欄位區分，結果混進了內部人員用的查詢/下拉選單裡，要一直額外過濾。改成申請單位資料完全搬到自己專屬的 `forward_support_applicant_profiles` 集合，不再跟 `users` 有任何關係，也更安全——不用再擔心新規則不小心影響到衛生營系統自己的帳號權限。**如果你之前已經貼過舊版（`isFsrSelfSignup` 那段、加在 `match /users/{uid}` 的 `allow create` 裡），可以直接刪掉那兩處，不會再用到，留著也不會壞掉、只是多餘。**）

在 `match /databases/{database}/documents { ... }` 區塊的**最後面**（例如 `forward_support_task_presets` 那個 `match` 區塊後面、最後兩個 `}` 之前）加上：

```
    match /forward_support_applicant_profiles/{uid} {
      allow read: if isFsrDispatcher() || (isSignedIn() && request.auth.uid == uid);
      allow create: if isSignedIn() && request.auth.uid == uid
        && request.resource.data.fsr_role == 'applicant';
      allow update: if isFsrAdmin();
      allow delete: if false;
    }
```

貼上後按「發布」。`forward_support_units`（單位代碼目錄）跟 `forward_support_requests`（申請單位送出任務）用的規則，第 5 版都已經涵蓋了，不用再改。

**⚠️ 舊測試帳號要重新註冊：** 如果你之前已經用單位代碼（例如 38724）測試註冊過，那筆資料是寫在舊的 `users` 集合裡，這次搬到新集合後系統找不到、視同沒註冊過。貼完這次的規則後，直接用同一組代碼＋密碼再走一次「註冊」流程就會建到新集合裡（Firebase Auth 帳號本來就存在，會自動接手，不用改用別的代碼）。

**已知限制：** 「更多」頁申請單位卡片上的「寄送重設密碼信」按鈕，是很早之前假設申請單位有真實信箱時做的，現在申請單位用的是假的 `@fsr.local` 信箱，那封信會寄到一個不存在的地方、對方永遠收不到。如果之後需要「幫申請單位重設密碼」，需要另外做（例如 Cloud Functions + Firebase Admin SDK 才能改別人的密碼，用目前的環境做不到），先讓管理者知道這個按鈕對申請單位帳號目前是無效的。

### 2026-08-01 新增：調度員可以編輯已填寫的車長／駕駛

「已完成」的任務現在多了「編輯車長／駕駛」按鈕，讓營部/一連/二連可以修正自己單位已經填過的車長駕駛資料，不用只能填一次、填錯了沒辦法改。這個動作是更新既有的 `forward_support_assignments` 文件，原本這個集合完全不開放 `update`，要放寬一點。

找到 `match /forward_support_assignments/{aId} { ... }` 這個區塊，把這一行：
```
      allow update, delete: if false;
```
改成：
```
      allow update: if isFsrUnitRole() && resource.data.unit == fsrUnitLabel();
      allow delete: if false;
```
（只放寬 update，delete 維持不開放。限定「自己單位」的資料才能改，不能改到別的單位填寫的內容。）

貼上後按「發布」。

### 2026-08-01 新增：管理員可以在「角色預覽」代替任何單位填寫車長／駕駛

「更多」頁的「角色預覽」現在可以直接以管理員身分點「填寫車長／駕駛」，代替營部/一連/二連把資料真的送出去（不只是看畫面），方便你不用另外用調度員帳號登入測試。這個動作一樣是寫入 `forward_support_assignments`，原本這個集合只允許「自己單位」的調度員新增/修改，管理員要另外放行。

找到 `match /forward_support_assignments/{aId} { ... }` 這個區塊，把 `allow create` 跟 `allow update` 這兩行：
```
      allow create: if isFsrUnitRole()
        && request.resource.data.unit == fsrUnitLabel()
        && request.resource.data.filledBy == request.auth.uid;
      allow update: if isFsrUnitRole() && resource.data.unit == fsrUnitLabel();
```
改成：
```
      allow create: if (isFsrUnitRole() && request.resource.data.unit == fsrUnitLabel()
                        && request.resource.data.filledBy == request.auth.uid)
                    || (isFsrAdmin() && request.resource.data.filledBy == request.auth.uid);
      allow update: if (isFsrUnitRole() && resource.data.unit == fsrUnitLabel()) || isFsrAdmin();
```
（`allow read`／`allow delete` 不用動。）

貼上後按「發布」。

### 2026-08-01 新增：申請單位自己可以編輯級職／姓名／手機號碼

「更多」頁新增了「單位資料」分頁（申請單位登入後看得到），讓申請單位自己能改承辦人級職／姓名／手機號碼，不用每次都麻煩管理者代改。原本 `forward_support_applicant_profiles` 的 `allow update` 只放行 `isFsrAdmin()`，申請單位自己完全不能寫，需要放寬。

找到 `match /forward_support_applicant_profiles/{uid} { ... }` 這個區塊，把這一行：
```
      allow update: if isFsrAdmin();
```
改成：
```
      allow update: if isFsrAdmin()
        || (isSignedIn() && request.auth.uid == uid
            && onlyChanged(['contactRank', 'contactName', 'contactPhone']));
```
（只放行這三個欄位，申請單位自己不能改 `fsr_role`／`fsr_unitName`／`email`／`unitCode` 這些權限或身分相關欄位，改單位全銜還是要透過管理者的「更多」頁編輯。）

貼上後按「發布」。

### 2026-08-01 新增：LINE ID 欄位、忘記密碼聯絡窗口

申請單位註冊／單位資料頁多了「LINE ID」欄位（選填），另外登入頁新增「忘記密碼？」連結，點下去會顯示管理員在「更多」頁設定好的業務承辦人聯絡資訊（級職／姓名／電話），不是寄信（申請單位用的是假信箱，寄信沒有用，見上面已知限制）。

**1. 放寬申請單位可以自己改的欄位**，把上一節加的這行：
```
      allow update: if isFsrAdmin()
        || (isSignedIn() && request.auth.uid == uid
            && onlyChanged(['contactRank', 'contactName', 'contactPhone']));
```
改成：
```
      allow update: if isFsrAdmin()
        || (isSignedIn() && request.auth.uid == uid
            && onlyChanged(['contactRank', 'contactName', 'contactPhone', 'contactLineId']));
```

**2. 新增聯絡窗口集合**，在 `match /databases/{database}/documents { ... }` 區塊最後面加上：
```
    match /forward_support_contact/{id} {
      allow read: if true;
      allow write: if isFsrAdmin();
    }
```
（`allow read: if true` 是故意的：申請單位就是登入不了才需要看這份資料，只公開這一份精簡的聯絡卡片，不會公開衛生營系統的完整人員名冊。）

貼上後按「發布」。

### 2026-08-01 新增：任務卡片直接顯示車長／駕駛的證照與電話

車長／駕駛的證照等級跟手機號碼，現在會額外複製一份存在 `forward_support_requests` 這筆任務文件本身（不是只存在 `forward_support_assignments`），這樣任何看得到這筆任務卡片的人（承辦人、調度員、甚至申請單位自己查「我的申請」）都能直接在卡片上看到聯絡方式。

因為調度員「編輯車長／駕駛」時，任務狀態原本就已經是 `filled`、改完還是 `filled`（不像第一次填寫是從 `assigned` 變成 `filled`），原本的規則只放行「狀態從 assigned 變成 filled」這一種情況，編輯已經 filled 的任務會被擋下來，需要放寬。

找到 `match /forward_support_requests/{reqId} { ... }` 這個區塊，把這段：
```
      allow update: if isFsrDispatcher()
        || (isFsrUnitRole() && resource.data.assignedUnit == fsrUnitLabel()
            && resource.data.status == 'assigned'
            && request.resource.data.status == 'filled');
```
改成：
```
      allow update: if isFsrDispatcher()
        || (isFsrUnitRole() && resource.data.assignedUnit == fsrUnitLabel()
            && resource.data.status == 'assigned'
            && request.resource.data.status == 'filled')
        || (isFsrUnitRole() && resource.data.assignedUnit == fsrUnitLabel()
            && resource.data.status == 'filled'
            && request.resource.data.status == 'filled');
```

貼上後按「發布」。

### 2026-08-01 新增：管理員可以刪除申請單位帳號

「更多→帳號管理」的申請單位帳號卡片新增「刪除帳號」按鈕。原本 `forward_support_applicant_profiles` 完全不開放刪除（`allow delete: if false;`），需要放寬給管理員。

找到 `match /forward_support_applicant_profiles/{uid} { ... }` 這個區塊，把這一行：
```
      allow delete: if false;
```
改成：
```
      allow delete: if isFsrAdmin();
```

貼上後按「發布」。（`forward_support_units` 單位代碼目錄的刪除權限第 5 版就已經開放給 `isFsrDispatcher()`，這次刪除帳號時會一併刪掉對應的單位代碼目錄項目，不用再改。）

**已知限制：** 刪除只會清掉 Firestore 裡的申請單位資料（`forward_support_applicant_profiles` 跟 `forward_support_units` 目錄項目），底層的 Firebase Auth 帳號本身不會被刪除（用目前的環境做不到，需要 Cloud Functions + Admin SDK）。實際效果等同於帳號失效：對方原本的登入密碼還在，但登入後系統找不到 profile 資料，會被導去「請重新註冊」，等於要重新走一次註冊流程才能再使用。

---

## 第 1～4 版（歷史記錄，已被第 5 版取代，僅供參考）

以下內容是根據錯誤假設（以為 `medical-battalion-tracker` 的規則很單純）寫的，**不要照著貼**，已經不適用實際的規則結構。保留在這裡只是留個紀錄。

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
