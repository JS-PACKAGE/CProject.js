# CProject.js

Calendar + Project：**純網頁應用**，使用 React + TypeScript，搭配可直接執行的 Node.js／SQLite 同步後端。電腦與手機都透過瀏覽器使用，**不需要 Docker、Rust、桌面安裝包或程式簽章**。也可不啟動後端，使用瀏覽器本機模式。

## 開發與執行

需要 Node.js **22.13+**（建議使用受支援的 LTS）與 npm。網頁需支援 IndexedDB、`Promise.withResolvers` 的近期瀏覽器（Safari 17.4+）。通知功能另受瀏覽器支援與授權限制。

```sh
npm ci
npm run dev
```

開啟 **http://127.0.0.1:1420**，使用瀏覽器本機模式。資料存放在目前來源的 IndexedDB，不會自動同步到後端或其他裝置。保留原本開發埠，避免既有本機瀏覽器工作空間因換網址而看似消失。

```sh
npm run check
npm run test:coverage
npm run build
npm run preview
```

`dist/` 可部署至靜態主機作為本機模式；請使用 HTTPS（loopback 開發網址除外）。本機模式不需要帳號，資料依瀏覽器、使用者設定檔及網址分開，清除網站資料會移除工作空間，請定期匯出 JSON。未實作離線網頁快取：即使資料保存在本機，首次載入或重新載入仍需要網站可達。

**需要跨裝置同步時，請啟動下方後端，並直接開啟後端網址**。前端與 `/api` 必須同源；開發伺服器及任意靜態主機不會自動連到另一個後端。

## 自架同步版（不使用 Docker）

後端使用**單一共享工作區，不設帳號、密碼或登入驗證**。任何可連到網站的人都能讀取、修改、匯出及取代這份資料。公開部署前，請在反向代理加上存取控制，或限制在 VPN／可信任網路內；HTTPS 與 Origin 檢查不等於使用者驗證。

### 本機試用

```sh
npm ci
npm run build
export CPROJECT_DATA_DIR="$HOME/.local/share/cproject-sync"
export TZ=Asia/Taipei
npm start
```

開啟 **http://localhost:8787** 就會直接載入共享工作區，不需建立帳號。`npm run server` 也可啟動相同服務。

請使用與 `CPROJECT_PUBLIC_URL` 相同的網址；例如預設值為 `http://localhost:8787`，不要改用 `127.0.0.1` 操作，否則來源檢查會拒絕寫入。`localhost` 只代表目前裝置，**手機不能用這個網址連到電腦**。

### 手機／外網使用

1. 在常駐主機安裝 Node.js，將專案放到例如 `/opt/cproject`，執行 `npm ci && npm run build`。
2. 使用獨立、非 root 的作業系統服務帳號；建立可供該帳號讀寫的資料目錄，例如 `/var/lib/cproject`。
3. 設定 `CPROJECT_PUBLIC_URL=https://planner.example.com`、`CPROJECT_DATA_DIR=/var/lib/cproject`、`TZ=Asia/Taipei`，以服務帳號啟動後端。將範例網域改成自己的。
4. 在後端前方配置 HTTPS 反向代理及適合的存取限制。後端預設只監聽 `127.0.0.1:8787`，不要直接公開此 HTTP 埠。網頁與 `/api` 必須走同一網域，存取限制也必須同時保護兩者。
5. 電腦與手機都開啟相同 HTTPS 網址，直接使用**同一共享工作區**。應用程式不提供個別使用者權限或私人工作區。

Caddy HTTPS 轉送範例（**本段未包含存取驗證**，僅適用已另行限制存取的環境；需要自行安裝 Caddy、設定 DNS，並讓網域與憑證驗證所需的網路連線可達）：

```caddyfile
planner.example.com {
    encode zstd gzip
    reverse_proxy 127.0.0.1:8787
}
```

Linux／systemd 常駐服務範例，存成 `/etc/systemd/system/cproject.service`。先建立 `cproject` 使用者並給予 `/opt/cproject` 讀取權限及 `/var/lib/cproject` 寫入權限；`ExecStart` 的 Node 路徑需符合主機安裝位置。

```ini
[Unit]
Description=CProject web server
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

其他作業系統可使用自己的服務管理器啟動 `npm start`，並設定相同環境變數。這些是部署操作範例；專案不會替你建立外部主機、設定 DNS 或申請 HTTPS 憑證。

### 同步行為與資料搬移

- 前景每 10 秒更新，也會於重新連線、回到畫面及手動重新整理時更新。修改必須連到後端；斷線後目前畫面與開啟的編輯草稿保留，但不能送出。**不是離線編輯佇列**，重載網頁後需要重新連線。
- 每次提交使用工作區版本及資料 before-image 檢查，排程連動與刪除同一交易寫入。遇到衝突會拒絕整筆交易；重新整理後重新開啟編輯器，再套用仍需要的修改。逾時時可能已提交，先刷新確認，不要直接重送。
- 本機資料不自動覆蓋後端。先從本機模式匯出備份，再開啟同步網站並匯入 JSON。切換網址或裝置時也使用 JSON 搬移；瀏覽器無法讀取另一個來源的 IndexedDB。
- 「上傳本機資料」僅適用於**目前來源**曾存有本機工作空間的情況，例如由靜態模式升級成同網址的同步網站。此入口只接受後端版本 0 的全新工作區，原本 IndexedDB 保留。需要刻意取代既有共享資料時，使用有確認提示的 JSON 匯入；這會影響所有訪客。
- 語言、每週起始日及預設提醒提前量同步；音效及外觀是裝置設定，不會由另一裝置覆蓋。開機自啟、系統匣與關窗常駐設定已移除。
- 工作時間使用工作區建立時保存的 IANA 時區。首次啟動時設定正確 `TZ`；裝置需使用相同時區才能修改，以免跨時區重新排程偏移。不同時區仍可讀取，但會提示並拒絕修改；顯示日期依裝置當地時間呈現。
- 網頁自動連接同源共享 API，不使用應用程式帳密、session cookie 或 bearer token。連線失敗時可重試，不會悄悄改用另一份本機資料。

### 從舊桌面／網頁版本升級

- **先備份**。既有桌面 SQLite 不會被網頁讀取或刪除。在舊應用程式匯出 JSON，再於網頁的「設定 → 匯入 JSON」搬入；支援原本 `cproject-js` version 1 備份，忽略已移除的自啟與關窗設定。macOS 舊資料仍位於 `~/Library/Application Support/dev.cproject.desktop/cproject.db`。
- 同來源的既有瀏覽器資料庫會自動升級至 version 3，保留工作空間與異動紀錄；沿用歷史名稱 `cproject-preview`，不是另開空白資料庫。如果升級被舊分頁阻擋，關閉其他 CProject 分頁後重新載入。
- 升級同步後端前，**停止舊服務並備份完整資料庫**，不要同時執行新舊後端。首次啟動新版會以單一交易遷移至 schema v3：沒有舊帳號時建立新工作區，只有一個舊帳號時沿用其資料、版本、時區與完整異動紀錄。
- 舊瀏覽器資料、後端 schema v2 及 JSON 備份若缺少每週起始日，會補為週一，設定歷史也會同步遷移；已指定的週日等有效選擇會保留。此設定僅控制行事曆顯示順序，不改變工作日定義或重複事件規則。
- 若有多個舊帳號，啟動會停止並要求明確選擇；設定 `CPROJECT_LEGACY_ACCOUNT=原帳號名稱` 後再啟動。未指定或名稱錯誤不會變更舊資料。這只決定首次遷移的來源，不是登入設定；完成遷移後不再用它切換資料。
- 所有舊帳號的原始快照及歷史（含選中的帳號）保存在 `archived_accounts`、`archived_changes`，不合併、不對 API 開放。管理者可查詢 `SELECT id,username,snapshot,timezone,revision FROM archived_accounts`，並依 `user_id` 查詢 `archived_changes`、以 `seq` 排序取回歷史。未選中資料需由管理者另行匯出；不要把匯入誤認為自動合併。
- 舊密碼雜湊、salt 及 session 資料不再保留於新 schema，舊登入介面也已移除。SQLite 舊頁面、WAL 與升級前備份仍應視為敏感資料，這不是安全抹除保證。舊分頁若仍傳送帳號標頭會被拒絕；請重新載入網頁使用新版共享 API。

### 維運與安全

- `CPROJECT_HOST` 預設 `127.0.0.1`；`CPROJECT_PORT` 預設 `8787`；`CPROJECT_PUBLIC_URL` 預設 `http://localhost:8787`；`CPROJECT_DATA_DIR` 預設專案下的 `server-data`。除了 loopback 測試，伺服器網址必須使用 HTTPS，不能包含子路徑或帳密。
- 所有 API 寫入必須符合 `CPROJECT_PUBLIC_URL` 的 Origin；不開放 CORS，已移除 `CPROJECT_ALLOWED_ORIGINS`。部署時讓反向代理保留瀏覽器 Origin，不要以放寬驗證繞過設定錯誤。
- 已移除建帳號／重設密碼命令及應用程式驗證。若反向代理需要使用者驗證，應由代理完成；前端保留同源請求的瀏覽器憑證支援（例如代理設定的 cookie）。不要將後端裸露在可繞過代理的網路介面。
- SQLite 本身**未加密**。保護主機、資料目錄與備份；Origin 檢查只能限制瀏覽器跨站請求，不能阻止能直接連線的訪客或程式讀寫。
- 備份 `CPROJECT_DATA_DIR/sync.sqlite` 前先停止服務，或使用 SQLite 一致性備份工具；**不要在服務運作時只複製主檔而漏掉 WAL**。完整資料庫備份也包含舊工作區封存，須視為敏感資料。JSON 匯出只包含目前共享工作區與異動紀錄。
- 限制：單次請求 10 MiB、工作區 5 MiB、每次交易 20,000 筆異動、工作區歷史 40 MiB 或 100,000 筆。達上限會明確拒絕，不會刪除舊資料。歷史滿時先匯出 JSON 並完整備份，停止服務後改用新的資料目錄再匯入工作區；匯入會重建當前資料異動，不搬入全部歷史，舊目錄應保留。
- `server-data/`、`.env*`、`dist/` 不納入 Git。若改用其他資料路徑，也應放在版本庫外。`package-lock.json` 應保留。

## 使用流程

1. **行事曆**：月／週檢視預設以週一為第一天，可在「設定 → 每週起始日」選擇任一星期並儲存，日期欄位及每週工作規則列表會一起調整順序。設定每週工作時段（預設週一至週五 09:00–12:00、13:30–18:00），加入假日、補班或自訂例外。例外日優先於星期規則；時段不可重疊。月／週檢視可瀏覽事件與專案截止日。
2. **專案**：選工作日曆與時段制／整日制，建立任務及一層子任務。時段制工期以分鐘輸入；整日制以整數工作天輸入。留空工期由起訖時間推導。進度自子層等權平均；手動進度留空即恢復自動。
3. **依賴**：新增 FS（完成→開始）、延遲分鐘與自動連動開關。拒絕成環與跨專案依賴；關閉連動後保留日期並顯示衝突。整日制的延遲須為 1440 分鐘的倍數。其他依賴型別保留於 schema／核心，UI 不開放。
4. **事件**：支援單次、每日、每週、每月 RRULE，可指定 `INTERVAL`、`COUNT`、`UNTIL`、每週 `BYDAY`。不支援的規則會回報錯誤。覆蓋目標必須使用同一工作日曆：`exclude` 讓出工作時間並保持工期；`rewrite` 直接改寫目標起訖。整日制只要某日與 exclude 重疊，該日就不計工作日。重複 rewrite 使用系列起點／明確改寫日期，不會隨每日刷新移動目標。
5. **展延**：時間軸拖曳專案右端，或專案頁輸入新結束時間；確認是否同步移動任務。選擇不移動時保留任務日期。
6. **提醒**：專案／任務到期與事件開始依設定提前提醒（預設 1440、120 分鐘），亦可新增自訂提醒。稍後提醒建立獨立排程，原筆留下紀錄。自動提醒由來源與預設提前量管理；自訂提醒可編輯／刪除。
7. **設定**：切換繁體中文、English、日本語，調整音效、提前量與通知授權。頂欄及連線畫面可快速切換亮色／暗色；「設定 → 外觀」可改回跟隨系統。JSON 匯入將取代目前有效資料，保留刪除紀錄。請先備份。復原恢復最近一筆本裝置操作及連動變更；不是完整的多步 undo/redo 編輯器，若有其他更新會拒絕覆蓋。

## 瀏覽器提醒與資料

- 「設定 → 瀏覽器通知 → 啟用通知」由使用者操作授權；需要 HTTPS 或 loopback，以及瀏覽器支援。拒絕或不支援通知時不會把提醒標示為已派送，仍可在提醒頁查看。權限被拒絕時請到瀏覽器網站設定調整。
- 工作空間開啟且就緒時約每 15 秒檢查，也會在頁面重新取得焦點時檢查到期提醒。通知文字依工作空間語言顯示，派送成功後才回寫 `fired_at`。支援 Service Worker 時使用其通知 API；通知點擊會聚焦網站。
- **沒有 Web Push、背景排程或關窗常駐**。關閉、休眠或背景節流後不保證即時通知；手機通知支援另取決於平台政策。Service Worker 僅處理通知顯示與點擊，不快取網站、不在背景輪詢後端。重新開啟且工作空間就緒後會處理尚未派送的到期提醒。
- `fired_at` 表示瀏覽器通知 API 接受派送，**不保證作業系統實際顯示**。勿擾模式、通知權限與音效仍由瀏覽器及系統控制。支援 Web Locks 時同來源分頁協調派送；跨裝置競爭、派送後斷線或崩潰仍可能重複通知，不提供 exactly-once 保證。
- 提醒預先計算 366 天，每日換日及視窗取得焦點時刷新。同步版時區不同時不重算排程，且拒絕修改。
- UI 只呼叫 Repository／application service；所有實體使用 UUID v7、UTC epoch ms、版本及軟刪除。IndexedDB／後端 SQLite 都將每次變更與異動紀錄放在同一交易，版本衝突不會部分提交。
- 本機模式與伺服器共享工作區分開儲存。所有連到同一伺服器的裝置共用資料；未提供使用者權限隔離或資料庫加密。

## 建置與架構

`.github/workflows/web.yml` 執行型別檢查、測試覆蓋率及網頁建置，產出 `cproject-web` artifact（`dist/`）。不再建置 macOS／Windows 安裝包，也不需要簽章 secrets。同步部署除了前端產物，還需要專案中的 Node.js 後端與 runtime dependencies。

- `src/core/`：純函式工作日曆、RRULE、依賴圖、進度、排程與提醒。
- `src/data/`：型別驗證、IndexedDB Repository、交易 change log、備份與復原、提醒狀態回寫。
- `src/sync/`：同源共享工作區連線、HTTP Repository、自動刷新與本機資料搬移。
- `server/`：Node.js HTTP／靜態網頁、SQLite 單一工作區與原子交易、舊資料遷移與封存。
- `src/features/`、`src/components/`：專案、月週行事曆、拖曳時間軸、提醒、設定與瀏覽器通知生命週期。
- `public/notification-worker.js`：通知顯示支援與點擊處理。
- `public/favicon.ico`：紫色 C· 網站圖示，包含 16、24、32、48、64、128、256 px 尺寸。
- `src/i18n/{zh-TW,en,ja}.ts`：完整三語字典；缺 key 以英文回退。

核心覆蓋率門檻為 statements／branches／functions／lines 各 90%；測試使用 America/New_York 時區，涵蓋 DST、假日、反向計算、成環拒絕、依賴扇入、階層、覆蓋、展延與提醒去重。另有瀏覽器提醒狀態、舊備份、免登入同步交易、Origin 保護與後端資料遷移測試。
