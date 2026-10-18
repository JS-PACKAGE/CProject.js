# CProject.js

Calendar + Project：Tauri 2 桌面應用與 React 手機網頁，搭配可直接執行的 Node.js／SQLite 同步後端，**不需要 Docker**。保留獨立本機模式。

## 開發與執行

需要 Node.js **22.13+**（建議使用受支援的 LTS）與 npm；只有桌面版需要 Rust stable。macOS 桌面開發需要 Xcode Command Line Tools；Windows 需要 Visual Studio C++ Build Tools 與 WebView2。macOS 最低版本為 14.4；網頁需支援 `Promise.withResolvers` 的近期瀏覽器（Safari 17.4+）。

```sh
npm ci
npm run tauri -- dev
```

本機網頁預覽：`npm run dev`，開啟 http://127.0.0.1:1420 。此模式使用獨立 IndexedDB，不會自動同步桌面 SQLite。**手機同步版請啟動下方的後端並開啟後端網址**，不是只將 `dist` 放到任意靜態主機。

```sh
npm run build
npm run check
npm run test:coverage
cargo test --manifest-path src-tauri/Cargo.toml
npm run tauri -- build
```

macOS 僅產生應用程式：`npm run tauri -- build --bundles app`。產物位於 `src-tauri/target/release/bundle/`，不納入 Git。`package-lock.json`、`src-tauri/Cargo.lock` 應保留。

## 自架同步版（不使用 Docker）

### 本機試用

```sh
npm ci
npm run build
export CPROJECT_DATA_DIR="$HOME/.local/share/cproject-sync"
export TZ=Asia/Taipei
npm run server:user -- --username yueyu
npm run server
```

帳號命令會隱藏密碼輸入並要求確認，密碼至少 12 字元；沒有公開註冊入口或預設密碼。開啟 **http://localhost:8787** 登入。桌面版在「設定 → 同步帳號」填相同網址與帳號，即可存取同一份資料。`localhost` 只代表目前裝置，**手機不能用這個網址連到電腦**。

### 手機／外網使用

1. 在常駐主機安裝 Node.js，將專案放到例如 `/opt/cproject`，執行 `npm ci && npm run build`。後端執行不需要 Rust。
2. 使用獨立、非 root 的服務帳號；建立可供該帳號讀寫的資料目錄，例如 `/var/lib/cproject`。同一資料目錄用於建帳號及啟動後端。
3. 設定 `CPROJECT_PUBLIC_URL=https://planner.example.com`、`CPROJECT_DATA_DIR=/var/lib/cproject`、`TZ=Asia/Taipei`，以服務帳號執行 `npm run server:user -- --username yueyu`。將範例網域改成自己的。
4. 在後端前方配置 HTTPS 反向代理。後端預設只監聽 `127.0.0.1:8787`，不要直接公開此 HTTP 埠。網頁與 `/api` 必須走同一網域。
5. 手機開啟 HTTPS 網址登入；桌面版也填該網址。兩邊使用**同一帳號**，不同帳號的資料彼此隔離，不是多人共同編輯同一工作區的權限系統。

Caddy 設定範例（需要自行安裝 Caddy、設定 DNS，並讓網域與憑證驗證所需的網路連線可達）：

```caddyfile
planner.example.com {
    encode zstd gzip
    reverse_proxy 127.0.0.1:8787
}
```

Linux／systemd 常駐服務範例，存成 `/etc/systemd/system/cproject.service`。先建立 `cproject` 使用者並給予 `/opt/cproject` 讀取權限及 `/var/lib/cproject` 寫入權限；`ExecStart` 的 Node 路徑需符合主機安裝位置。

```ini
[Unit]
Description=CProject sync server
After=network.target

[Service]
Type=simple
User=cproject
WorkingDirectory=/opt/cproject
Environment=NODE_ENV=production
Environment=CPROJECT_HOST=127.0.0.1
Environment=CPROJECT_PORT=8787
Environment=CPROJECT_PUBLIC_URL=https://planner.example.com
Environment=CPROJECT_DATA_DIR=/var/lib/cproject
Environment=TZ=Asia/Taipei
ExecStart=/usr/bin/node --import tsx server/index.ts
Restart=on-failure
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/var/lib/cproject

[Install]
WantedBy=multi-user.target
```

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now cproject
journalctl -u cproject
```

其他作業系統可使用自己的服務管理器啟動 `npm run server`，並設定相同環境變數。這些是部署操作範例；專案不會替你建立外部主機、設定 DNS 或申請憑證。

### 同步行為與資料搬移

- 前景每 10 秒更新，也會於重新連線、回到畫面及手動重新整理時更新。修改必須連到後端；斷線後目前畫面與開啟的編輯草稿保留，但不能送出。**不是離線編輯佇列**，重載網頁後需要重新連線。
- 每次提交使用工作區版本及資料 before-image 檢查，排程連動與刪除同一交易寫入。遇到衝突會拒絕整筆交易；重新整理後重新開啟編輯器，再套用仍需要的修改。逾時時可能已提交，先刷新確認，不要直接重送。
- 現有本機資料不自動覆蓋後端。先從本機模式匯出備份，再登入**全新且尚未修改的帳號**，使用「上傳本機資料」。原本 SQLite／IndexedDB 保留。此入口只接受後端版本 0，已修改的帳號會被拒絕；需要刻意取代既有帳號資料時，使用有確認提示的 JSON 匯入。
- 上傳來源是目前裝置的本機資料。手機無法直接讀取電腦的 SQLite；請從原桌面裝置上傳，或將 JSON 備份搬到手機匯入。
- 語言及預設提醒提前量同步；自啟、關窗常駐、音效屬於裝置設定，不會由另一裝置覆蓋。網頁不顯示原生設定。
- 工作時間使用帳號建立時保存的 IANA 時區。建立帳號時設定正確 `TZ`；裝置需使用相同時區才能修改，以免跨時區重新排程偏移。不同時區仍可讀取，但會提示並拒絕修改；顯示日期依裝置當地時間呈現。
- 手機網頁關閉／被系統暫停後**不保證提醒，也沒有 Web Push**。桌面登入同步帳號後，Rust 每 60 秒讀取後端提醒，隱藏視窗仍能派送並回寫；完全退出後不會通知。多台桌面同時派送或派送後斷線可能重複通知，不提供 exactly-once 保證。
- 瀏覽器使用 HttpOnly、SameSite=Strict cookie，HTTPS 啟用 Secure；工作階段 30 天到期。桌面 bearer token 僅留記憶體，**重啟需重新登入**，登入前只執行本機排程。登出／切換模式不刪除原本本機資料。離線登出不能保證立即撤銷伺服器工作階段，畫面會告知，且不自動恢復該工作階段。

### 維運與安全

- `CPROJECT_HOST` 預設 `127.0.0.1`；`CPROJECT_PORT` 預設 `8787`；`CPROJECT_PUBLIC_URL` 預設 `http://localhost:8787`；`CPROJECT_DATA_DIR` 預設專案下的 `server-data`。除了 loopback 測試，伺服器網址必須使用 HTTPS，不能包含子路徑或帳密。
- 正式部署不需 `CPROJECT_ALLOWED_ORIGINS`。開發 Tauri 時可明確設定 `CPROJECT_ALLOWED_ORIGINS=http://localhost:1420,http://127.0.0.1:1420`，允許開發 WebView 跨來源登入；這些來源被視為可信任，**不要填入不受自己控制的網址或萬用字元**。
- 重設密碼：使用相同資料目錄執行 `npm run server:user -- --username yueyu --reset-password`，會撤銷該帳號所有工作階段。自動化可用 `--password-stdin` 或 `CPROJECT_ADMIN_PASSWORD`，不要把密碼寫進命令參數、版本庫或部署紀錄。
- 密碼以隨機 salt＋scrypt 儲存，工作階段 token 只保存 SHA-256 雜湊；SQLite 本身**未加密**。保護主機、資料目錄與備份。登入限制為每來源 IP 30 次、每帳號名稱 10 次／15 分鐘，最多 8 個同時密碼驗證；限制包含成功登入且重啟後重置。反向代理後 IP 計數會共用代理 IP，未信任轉送 IP 標頭。
- 備份 `CPROJECT_DATA_DIR/sync.sqlite` 前先停止服務，或使用 SQLite 一致性備份工具；**不要在服務運作時只複製主檔而漏掉 WAL**。完整資料庫備份含帳號及工作階段，須視為敏感資料。JSON 匯出只包含當前工作區與異動紀錄，不包含登入帳密。
- 限制：單次請求 10 MiB、單一工作區 5 MiB、每次交易 20,000 筆異動、帳號歷史 40 MiB 或 100,000 筆。達上限會明確拒絕，不會刪除舊資料。歷史滿時可先匯出 JSON，再由管理者建立新帳號匯入工作區；新帳號會重建當前資料異動，不搬入舊帳號全部歷史。
- `server-data/`、`.env*`、`dist/` 與原生編譯產物已排除 Git。若改用其他資料路徑，也應放在版本庫外。


## 使用流程

1. **行事曆**：設定每週工作時段（預設週一至週五 09:00–12:00、13:30–18:00），加入假日、補班或自訂例外。例外日優先於星期規則；時段不可重疊。月／週檢視可瀏覽事件與專案截止日。
2. **專案**：選工作日曆與時段制／整日制，建立任務及一層子任務。時段制工期以分鐘輸入；整日制以整數工作天輸入。留空工期由起訖時間推導。進度自子層等權平均；手動進度留空即恢復自動。
3. **依賴**：新增 FS（完成→開始）、延遲分鐘與自動連動開關。拒絕成環與跨專案依賴；關閉連動後保留日期並顯示衝突。整日制的延遲須為 1440 分鐘的倍數。其他依賴型別保留於 schema／核心，UI 不開放。
4. **事件**：支援單次、每日、每週、每月 RRULE，可指定 `INTERVAL`、`COUNT`、`UNTIL`、每週 `BYDAY`。不支援的規則會回報錯誤。覆蓋目標必須使用同一工作日曆：`exclude` 讓出工作時間並保持工期；`rewrite` 直接改寫目標起訖。整日制只要某日與 exclude 重疊，該日就不計工作日。重複 rewrite 使用系列起點／明確改寫日期，不會隨每日刷新移動目標。
5. **展延**：時間軸拖曳專案右端，或專案頁輸入新結束時間；確認是否同步移動任務。選擇不移動時保留任務日期。
6. **提醒**：專案／任務到期與事件開始依設定提前提醒（預設 1440、120 分鐘），亦可新增自訂提醒。稍後提醒建立獨立排程，原筆留下紀錄。自動提醒由來源與預設提前量管理；自訂提醒可編輯／刪除。
7. **設定**：切換繁體中文、English、日本語，調整自啟、關閉視窗常駐、音效、提前量。頂欄（及登入頁）的 ☾／☀ 可快速切換亮色／暗色；「設定 → 外觀」可改回跟隨系統。外觀只存在目前裝置，不會同步。JSON 匯出可備份；匯入將取代目前有效資料，保留刪除紀錄。請先備份。復原恢復最近一筆本機操作及連動變更；不是完整的多步 undo/redo 編輯器，若有其他更新會拒絕覆蓋。

## 常駐與資料

- 桌面 SQLite：Tauri `app_config_dir()/cproject.db`，與 SQL plugin 使用同一路徑。macOS 為 `~/Library/Application Support/dev.cproject.desktop/cproject.db`；Windows 依使用者 AppData 位置解析。
- UI 只呼叫 Repository／application service；所有實體使用 UUID v7、UTC epoch ms、版本及軟刪除。每次變更與 `change_log` 同交易寫入；版本衝突不會部分提交。
- Rust ticker 啟動即檢查，之後每 60 秒派送到期提醒；視窗隱藏時繼續執行。系統匣可開啟視窗、暫停／恢復提醒或結束；關閉常駐設定後關窗即退出。重複啟動會聚焦既有實例。
- `fired_at` 表示通知 plugin 接受派送，**不保證作業系統已顯示**；權限、勿擾模式與平台政策仍可能阻擋。崩潰恰好發生在派送與寫入之間可能重送（at-least-once）。完全退出或電腦關機期間不會通知，重新啟動會處理既有到期提醒。
- 提醒預先計算 366 天；網頁執行環境每日換日及視窗取得焦點時刷新。隱藏／休眠造成 WebView 計時器延遲時，Rust 仍執行已儲存排程；重新開啟視窗補齊後續排程。
- 本機模式與同步帳號分開儲存；伺服器多帳號彼此隔離。未提供工作區共享權限、資料庫加密或手機背景推播。

## 打包與簽章

`.github/workflows/desktop.yml` 提供 macOS／Windows 建置。預設 unsigned；需正式發佈時手動啟用 signed，並提供 workflow 所列 Apple Developer 與 Windows PFX 憑證 secrets。缺少憑證會直接失敗，不會將未簽章產物標為簽章版。macOS 的本機 ad-hoc 簽章不等於 Developer ID 或 notarization。

正式簽章、Apple notarization 與 Windows 執行驗證需對應憑證／平台；本機 macOS 建置不能替代 Windows 驗收。

## 架構

- `src/core/`：純函式工作日曆、RRULE、依賴圖、進度、排程與提醒。
- `src/data/`：型別驗證、Repository、SQLite IPC／IndexedDB adapter、交易 change log、備份與復原。
- `src/sync/`：登入工作階段、HTTP Repository、自動刷新與本機資料搬移。
- `server/`：Node.js HTTP／靜態網頁、SQLite 帳號與原子交易、管理者建帳號命令。
- `src/features/`、`src/components/`：專案、月週行事曆、拖曳時間軸、提醒、設定。
- `src/i18n/{zh-TW,en,ja}.ts`：完整三語字典；缺 key 以英文回退。
- `src-tauri/`：SQLite migrations、native commands、tray、自啟、單實例、通知 ticker。

核心覆蓋率門檻為 statements／branches／functions／lines 各 90%；測試使用 America/New_York 時區，涵蓋 DST、假日、反向計算、成環拒絕、依賴扇入、階層、覆蓋、展延與提醒去重。
