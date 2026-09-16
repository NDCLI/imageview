# Chuyển ImageView sang bản Desktop (Electron) — kết nối CVAT trực tiếp bằng PAT

## Context

**Vấn đề hiện tại.** Bản CVAT hiện nay chạy theo mô hình web LAN:

```
Browser đồng nghiệp → http://<IP-LAN>:3000/imageview/ → Node server (giữ token.txt) → CVAT API
```

Mô hình này có 3 điểm yếu thực tế:
- **Phụ thuộc một máy chủ duy nhất** — máy đó phải bật, không sleep, và nằm trong mạng công ty. Tắt máy là cả nhóm không xem được.
- **PAT dùng chung** — mọi người chia sẻ một quyền đọc duy nhất. Không có audit trail theo từng người; thu hồi token là ảnh hưởng cả nhóm.
- **HTTP LAN không mã hóa** — ảnh và annotation truyền dạng plaintext trong mạng nội bộ (đã ghi nhận trong `IMAGEVIEW_CVAT_LAN_PLAN.md`).

**Mục tiêu.** Đóng gói thành app desktop Windows. Mỗi người dùng nhập **PAT CVAT của chính mình**, app gọi **thẳng** vào CVAT server — không qua tầng proxy trung gian nào. Phân phối bằng installer nội bộ trước (NSIS), sau đó đưa lên Microsoft Store (MSIX).

**Ràng buộc đã chốt với người dùng:**
1. **Electron** (không phải Tauri) — vì `server/cvat-lan.cjs` + `server/frame-cache.cjs` đã là Node CommonJS, tái sử dụng gần như nguyên vẹn.
2. **NSIS trước, MSIX sau** — có bản dùng nội bộ ngay, Store làm ở giai đoạn 2.
3. **Giữ cả hai chế độ** — bản web LAN vẫn chạy; dùng chung codebase qua một lớp adapter.

**Kiến trúc đích:**

```
┌─ Renderer (SolidJS — giữ nguyên ~95%) ─────────┐
│  src/lib/cvat-client.js  ← adapter mới          │
│  desktop → fetch('cvat://api/...')              │
│  web/LAN → fetch('/api/cvat/...')               │
└──────────────┬──────────────────────────────────┘
               │ protocol.handle()
┌──────────────▼──────────────────────────────────┐
│ Electron main process (Node)                    │
│  • cvat-api.cjs   ← TÁI SỬ DỤNG từ cvat-lan.cjs │
│  • frame-cache.cjs← TÁI SỬ DỤNG nguyên vẹn      │
│  • token-vault.cjs← MỚI, safeStorage/DPAPI      │
└──────────────┬──────────────────────────────────┘
               │ HTTP(S) + Authorization: Bearer <PAT>
        ┌──────▼──────┐
        │  CVAT API   │  (10.43.2.147:8080, 10.43.2.12:8080)
        └─────────────┘
```

**Đã xác minh (không phải suy đoán):**
- `safeStorage` trên Windows dùng **DPAPI**, khóa theo từng user — chỉ user cùng logon credential mới giải mã được.
- `protocol.handle(scheme, handler)` nhận `GlobalRequest` trả `Response` chuẩn Web API; phải gọi `protocol.registerSchemesAsPrivileged()` **trước** khi app ready với `standard/secure/supportFetchAPI/corsEnabled` để renderer `fetch()` được.
- electron-builder hỗ trợ target `nsis` (mặc định), `appx`, `msix` — hai target sau dùng cho Microsoft Store; build được trên Windows 10+. Máy đang là Windows 11 ✓.
- `showOpenFilePicker()` **hoạt động** trong Electron (luồng ZIP giữ nguyên). Chỉ tính năng nhớ thư mục cũ theo `id` là `NOTIMPLEMENTED` ([electron/electron#42352](https://github.com/electron/electron/issues/42352)) — ảnh hưởng thẩm mỹ, không chặn.
- Version mới nhất: **Electron 44.4.1**, **electron-builder 26.15.3**. Node hiện có v24.14.0 ✓ (thỏa `engines >=20`).

---

## Bề mặt cần sửa (đã khoanh vùng chính xác)

Chỉ **3 điểm** trong frontend gọi `/api/cvat/*` — adapter rất mỏng:

| File | Dòng | Lời gọi hiện tại |
|---|---|---|
| [MainPage.jsx:63](src/pages/MainPage.jsx#L63) | `fetch('/api/cvat/servers')` |
| [MainPage.jsx:285](src/pages/MainPage.jsx#L285) | `fetch('/api/cvat/jobs/${cvatServerId()}/${jobId}')` |
| [ViewerPage.jsx:90](src/pages/ViewerPage.jsx#L90) | `fetch('/api/cvat/jobs/${serverId}/${jobId}/frames/${frame}')` |

Backend tái sử dụng được ngay vì `readJob(server, jobId)` nhận object `{ url, token }` — **không quan tâm token đến từ đâu**. Desktop chỉ cần đổi nguồn cấp `server` object: từ `readTokenConfig(token.txt)` sang token vault.

---

## Phase 0 — Nền tảng & tách adapter (không đổi behavior)

**0.1 Đổi tên `server/cvat-lan.cjs` → `server/cvat-api.cjs`**
File này là logic CVAT thuần, không hề LAN-specific — tên cũ sẽ gây nhầm khi Electron dùng lại. Cập nhật import ở `server/lan-server.cjs:5` và đổi tên file test `server/cvat-lan.node-tests.cjs` → `server/cvat-api.node-tests.cjs` cùng script `test:lan` → `test:server`.

**0.2 Tạo `src/lib/cvat-client.js`** — gom 3 lời gọi trên vào một module:
```js
const isDesktop = typeof window !== 'undefined' && window.imageview?.desktop === true
const base = isDesktop ? 'cvat://api' : '/api/cvat'
export async function listServers()            // GET {base}/servers
export async function openJob(serverId, jobId) // GET {base}/jobs/:sid/:jid
export async function fetchFrame(sid, jid, f)  // GET {base}/jobs/:sid/:jid/frames/:f → Blob
```
Cả hai transport đều trả `Response` chuẩn → `loadCvatFrame()` ở ViewerPage gần như không đổi, chỉ thay URL builder. Toàn bộ pipeline `URL.createObjectURL` → `preDecodeUrl` → double-buffer giữ nguyên.

**0.3 Thêm build mode `desktop` vào `vite.config.js`**

`base: '/imageview/'` hiện tại sẽ vỡ khi load từ scheme khác. Chuyển sang dạng hàm để đọc `mode` — đúng pattern mà `build:lan` (`vite build --mode lan` + `.env.lan`) đang dùng:

```js
export default defineConfig(({ mode }) => ({
  plugins: [solidPlugin()],
  base:
    mode === 'desktop' ? './' : process.env.VERCEL ? '/' : '/imageview/',
  // ...giữ nguyên phần build/optimizeDeps/server/test hiện có
}))
```

Kèm file `.env.desktop`:
```
VITE_DESKTOP=true
```
Vite tự nạp `.env.desktop` khi chạy `--mode desktop`, giống hệt cách `.env.lan` đang hoạt động.

**0.4 Tắt service worker + analytics ở chế độ desktop**
- [main.jsx:7](src/main.jsx#L7) đang đăng ký `sw.js` khi `PROD && isSecureContext`. Ở desktop, cập nhật app do electron-updater đảm nhiệm — SW chỉ gây xung đột cache. Thêm guard `if (import.meta.env.VITE_DESKTOP) return`.
- [main.jsx:20](src/main.jsx#L20) đã có guard `VITE_LAN_MODE`. Mở rộng thành `if (import.meta.env.VITE_LAN_MODE === 'true' || import.meta.env.VITE_DESKTOP) return`.

**Kiểm tra Phase 0:** `npm run lint && npm test && npm run test:server && npm run build` xanh; bản web LAN vẫn mở Job bình thường (adapter chưa đổi hành vi).

---

## Phase 1 — Electron shell

**1.1 Cấu trúc mới**
```
electron/
├── main.cjs          # lifecycle, BrowserWindow, app:// + cvat:// scheme
├── preload.cjs       # contextBridge → window.imageview
├── token-vault.cjs   # Phase 2
└── frame-service.cjs # Phase 2
```

**1.2 `package.json`** — thêm `"main": "electron/main.cjs"` (bắt buộc, Electron đọc field này; Vite bỏ qua nên không ảnh hưởng web build) và `"author"` (electron-builder cần cho NSIS). devDependencies: `electron@^44`, `electron-builder@^26`, `concurrently`, `wait-on`.

**1.3 Nạp renderer qua privileged scheme `app://`, KHÔNG dùng `file://`**

`file://` kéo theo một loạt vấn đề: origin không ổn định cho `localStorage`/OPFS partition, `history.replaceState` với `pathname` (đang dùng ở `writeViewerIndexToUrl`), và đăng ký service worker. Dùng `app://` với `secure: true` cho một origin ổn định, secure context đầy đủ:

```js
protocol.registerSchemesAsPrivileged([{
  scheme: 'app',
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
}, {
  scheme: 'cvat',
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
}])
```
Phải gọi **trước** `app.whenReady()`. `stream: true` cho `cvat://` để trả ảnh frame dạng stream.

**1.4 Hardening** — `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`; CSP nghiêm ngặt; `setWindowOpenHandler` + `will-navigate` chặn mọi điều hướng ra ngoài `app://`.

**1.5 Xử lý `window.open` cho viewer tab**

[MainPage.jsx:335](src/pages/MainPage.jsx#L335) mở viewer bằng `window.open(viewerUrl, PREVIEW_TAB_NAME)`. Trong Electron phải bắt qua `setWindowOpenHandler` và tạo `BrowserWindow` mới load `app://index.html?viewer=1&index=N` với cùng webPreferences.

Giữ nguyên được cơ chế hiện có vì cùng origin `app://`: `localStorage` chia sẻ state (`VIEWER_STATE_KEY`) và `BroadcastChannel('image-view-channel')` cho luồng ZIP cross-window vẫn hoạt động — **không cần sửa logic nào ở hai page**.

**1.6 Scripts**
```json
"dev:desktop":   "concurrently -k \"vite --mode desktop\" \"wait-on tcp:5173 && cross-env VITE_DEV_SERVER_URL=http://localhost:5173 electron .\"",
"build:desktop": "vite build --mode desktop && electron-builder --win nsis",
"build:msix":    "vite build --mode desktop && electron-builder --win msix"
```
Ở dev, main.cjs load `VITE_DEV_SERVER_URL`; ở prod load `app://`.

**Kiểm tra Phase 1:** `npm run dev:desktop` mở app, dashboard render đúng, drag&drop ZIP hoạt động, mở viewer window, Next/Prev + zoom + box toggle OK, restart app vẫn khôi phục được ZIP (IndexedDB handle).

---

## Phase 2 — PAT vault + kết nối CVAT trực tiếp

**2.1 `electron/token-vault.cjs`**
- Lưu tại `app.getPath('userData')/cvat-servers.enc`
- `safeStorage.encryptString(JSON.stringify(servers))` → Buffer → ghi file; đọc bằng `decryptString`
- Mỗi server: `{ id, label, url, token }` — **đúng shape mà `readJob()` đang nhận**, nên không cần sửa gì ở `cvat-api.cjs`
- Kiểm tra `safeStorage.isEncryptionAvailable()` trước; nếu false thì báo lỗi rõ, **không fallback plaintext**
- Không bao giờ log token; IPC chỉ trả label + preview che (`abcd…wxyz`)

**2.2 `cvat://api/*` protocol handler** — map đúng 3 endpoint mà adapter gọi, reuse `readJob()` và `createFrameCache()`:
- `cvat://api/servers` → danh sách từ vault (chỉ `id` + `label`)
- `cvat://api/jobs/:sid/:jid` → `readJob(server, jobId)`
- `cvat://api/jobs/:sid/:jid/frames/:f` → fetch frame + cache LRU

Giữ nguyên các giới hạn đã có trong `cvat-api.cjs`: `AbortSignal.timeout(20000)`, `validId()` chặn ID không hợp lệ, phân biệt 401/403 → 502. Frame cache cấu hình lại qua `IMAGEVIEW_FRAME_CACHE_ENTRIES` / `_MB`.

**Lưu ý hiệu năng:** handler chạy ở main process. Nén ảnh song song nhiều có thể nghẽn UI thread. Client đã tự giới hạn `CVAT_MAX_PARALLEL_REQUESTS = 3` ([ViewerPage.jsx:30](src/pages/ViewerPage.jsx#L30)) nên áp lực thấp; nếu vẫn giật, chuyển frame-service sang `utilityProcess` (nâng cấp tùy chọn, không làm ngay).

**2.3 UI Cài đặt kết nối CVAT**

Sửa `cvat-panel` đang có ở [MainPage.jsx:363](src/pages/MainPage.jsx#L363). Chế độ desktop thêm nút "⚙ Server CVAT" mở panel:
- Thêm/sửa/xóa server: **URL** + **PAT** (field `type="password"`)
- Nút **"Test connection"** → gọi `GET /api/users/self` bằng PAT, báo rõ token hợp lệ hay 401/403
- Dán được link Job (`/jobs/123`) để tự tách Job ID
- Sửa dòng chữ "Token được LAN server giữ cục bộ; trình duyệt không nhận token." ([MainPage.jsx:366](src/pages/MainPage.jsx#L366)) — không còn đúng ở desktop. Nhánh theo mode: desktop → "PAT của bạn được mã hóa bằng Windows DPAPI, lưu trên máy này."

**2.4 HTTP nội bộ không phải vấn đề.** CVAT server là `http://10.43.2.x:8080`. Request xuất phát từ **main process (Node)** chứ không phải renderer → không có mixed-content, không có CORS. Đây chính là lý do mô hình desktop bỏ được tầng proxy.

**Kiểm tra Phase 2:** thêm server + PAT thật, Test connection báo đúng, mở Job bằng ID, tua frame liên tục (Next giữ nút) không trắng hình, box annotation đúng vị trí, 401 hiện thông báo rõ chứ không treo, restart app vẫn nhớ PAT (không phải nhập lại).

---

## Phase 3 — Installer NSIS (dùng nội bộ ngay)

**3.1 `electron-builder.yml`**
```yaml
appId: com.nkhcloud.imageview
productName: ImageView
directories: { output: release }
files: [dist/**, electron/**, server/cvat-api.cjs, server/frame-cache.cjs, package.json]
win:
  target: [nsis]
  icon: public/favicon.svg   # cần đổi sang .ico 256x256
nsis:
  oneClick: false
  allowToChangeInstallationDirectory: true
  perMachine: false           # cài per-user → không cần quyền admin
```
`files` chỉ đóng đúng phần cần — **không** đóng `token.txt`, `server/lan-server.cjs`, source `.jsx`.

**3.2 Cần thêm icon `.ico`** — hiện chỉ có `public/favicon.svg`. NSIS yêu cầu ICO.

**3.3 Code signing.** Không ký → SmartScreen cảnh báo. Phương án:
- **Nội bộ:** self-signed cert, đẩy cert qua GPO cho máy công ty, hoặc chấp nhận cảnh báo
- **Nghiêm túc:** cert OV/EV từ nhà cung cấp (EV bỏ được cảnh báo ngay)
- **Bắt buộc cho Store:** cert phải khớp publisher identity (Phase 4)

**3.4 Auto-update (tùy chọn).** `electron-updater` với generic feed trỏ vào thư mục mạng công ty (`\\fileserver\imageview\updates`) — không cần hạ tầng ngoài.

**3.5 Phân phối:** đặt `.exe` lên share công ty + file `DESKTOP_USAGE.md` hướng dẫn cài, tạo PAT trong CVAT (Settings → Tokens), nhập vào app.

---

## Phase 4 — Microsoft Store (MSIX)

> Làm sau khi bản NSIS đã ổn định trong nhóm.

**4.1 Chuẩn bị (ngoài code — cần quyết định của công ty)**
- Tài khoản **Microsoft Partner Center** (~$19 một lần, loại company)
- **Reserved app name** + package identity (`Publisher`, `PublisherDisplayName` phải khớp cert)
- **Code signing cert** khớp identity đó

**4.2 Cấu hình build** — thêm target `msix` vào `win.target`. electron-builder build được MSIX trên Windows 10+; máy đang là Windows 11 ✓.

**4.3 Store listing** — screenshots, mô tả, privacy policy URL, khai báo quyền. Lưu ý review của Microsoft có thể hỏi về việc app truy cập mạng nội bộ; chuẩn bị sẵn mô tả rõ đây là tool nội bộ đọc CVAT.

**4.4 Ràng buộc MSIX cần kiểm tra trước khi submit:** app chạy trong container nên đường ghi phải nằm trong `app.getPath('userData')` (vault đã đúng chỗ). Cần smoke test lại toàn bộ luồng ZIP — OPFS và IndexedDB handle trong môi trường MSIX có thể khác NSIS.

**4.5 Submit** → certification → phát hành (có thể chọn private/organization-only nếu Store hỗ trợ, tránh public tool nội bộ).

---

## Phase 5 — Dọn dẹp, test & tài liệu

**5.1 Test**
- `server/cvat-api.node-tests.cjs` — giữ 3 test hiện có, thêm test cho đường desktop (cùng `readJob`, nguồn server khác)
- `electron/token-vault.node-tests.cjs` — MỚI, mock `safeStorage`; test encrypt/decrypt round-trip, file hỏng, thiếu server
- Vitest cho `src/lib/cvat-client.js` — mock cả hai transport, đảm bảo shape response giống nhau
- **Regression bắt buộc:** luồng ZIP (cả `showOpenFilePicker` lẫn drag&drop), annotation XML CVAT, phím tắt, cross-window state

**5.2 CI** — thêm job build desktop vào `.github/workflows/ci.yml` (windows-latest, `npm ci` → lint → test → `vite build --mode desktop`). Chưa sign/publish trong CI ở giai đoạn này.

**5.3 Tài liệu**
- `DESKTOP_USAGE.md` — MỚI: cài đặt, tạo PAT, thêm server, khắc phục lỗi
- `README.md` — bổ sung mục Desktop, ghi rõ 2 chế độ và khi nào dùng cái nào
- `LAN_USAGE.md` — giữ nguyên, thêm ghi chú "hoặc dùng bản desktop để không cần máy chủ LAN"

---

## Thứ tự & ước lượng

| Phase | Nội dung | Ước lượng | Rủi ro |
|---|---|---|---|
| **0** | Đổi tên file, adapter, build mode desktop | 2-3 giờ | 🟢 Thấp |
| **1** | Electron shell, `app://`, viewer window | 4-6 giờ | 🟡 Trung bình |
| **2** | PAT vault (DPAPI) + `cvat://` + UI settings | 4-6 giờ | 🟡 Trung bình |
| **3** | NSIS installer, icon, signing, phân phối | 2-3 giờ | 🟡 Trung bình (signing) |
| **4** | MSIX + Microsoft Store | 4-8 giờ + chờ review | 🔴 Cao (thủ tục ngoài code) |
| **5** | Test, CI, tài liệu | 2-3 giờ | 🟢 Thấp |

**Tổng code: ~14-21 giờ** (Phase 0-3 + 5) để có bản desktop cài đặt được nội bộ. Phase 4 phụ thuộc thủ tục Partner Center, nên tách riêng.

**Điểm dừng hữu ích:** xong Phase 3 là đã có bản desktop dùng được cho cả nhóm, không cần máy chủ LAN.

---

## Rủi ro cần lưu ý

| Rủi ro | Mức | Giảm thiểu |
|---|---|---|
| `base: '/imageview/'` vỡ asset khi load trong Electron | Cao nếu bỏ sót | Phase 0.3 bắt buộc; verify asset load trong `npm run dev:desktop` trước khi đi tiếp |
| `window.open` không tạo viewer window | Trung bình | Phase 1.5 `setWindowOpenHandler`; test sớm, đây là luồng chính |
| `safeStorage.isEncryptionAvailable()` false trên vài máy | Thấp | Báo lỗi rõ, không fallback plaintext; test trên máy thật của nhóm |
| Frame fetch nghẽn main process | Thấp | Client đã giới hạn 3 request song song; `utilityProcess` là phương án dự phòng |
| Code signing / SmartScreen | Trung bình | Quyết định sớm: self-signed + GPO, hay mua cert |
| MSIX container giới hạn quyền ghi/OPFS | Trung bình | Phase 4.4 smoke test đầy đủ trước khi submit, không giả định giống NSIS |
| PAT lưu trên máy cá nhân | Thấp | DPAPI theo user; khuyến nghị PAT read-only; mỗi người tự thu hồi được |

---

## Verify end-to-end

Sau mỗi phase, chạy:
```bash
npm run lint && npm test && npm run test:server && npm run build:lan
```

**Phase 1 xong:**
```bash
npm run dev:desktop
```
→ app mở, dashboard render, drag&drop ZIP chạy, mở viewer window, Next/Prev + zoom + box OK, restart vẫn khôi phục ZIP.

**Phase 2 xong** (cần PAT thật + vào được mạng công ty):
1. ⚙ Server CVAT → thêm `http://10.43.2.147:8080` + PAT → **Test connection** báo hợp lệ
2. Nhập Job ID → **Mở Job** → ảnh hiện ra
3. Giữ phím Next tua ~50 frame: không trắng hình, không lệch frame
4. Bật **Show Boxes**: box đúng vị trí, đúng label màu
5. Sai PAT → thông báo 401 rõ ràng, không treo
6. Restart app → không phải nhập lại PAT
7. **Regression:** mở ZIP bằng cả 2 cách (picker + drag&drop), annotation XML vẫn đúng

**Phase 3 xong:** cài `.exe` trên **một máy khác** trong công ty (không có repo, không có Node) → chạy được, thêm PAT, mở Job.

**Song song:** bản web LAN (`npm run build:lan && npm run start:lan`) vẫn hoạt động y như trước — không được regress.

---

## Git workflow

```
codex/imageview-cvat-lan  (hiện tại)
 └── feat/desktop-phase-0-adapter     ← PR #1
 └── feat/desktop-phase-1-shell       ← PR #2
 └── feat/desktop-phase-2-pat         ← PR #3
 └── feat/desktop-phase-3-installer   ← PR #4
 └── feat/desktop-phase-5-tests-docs  ← PR #5
 └── feat/desktop-phase-4-msix        ← PR #6 (sau)
```

Mỗi phase một PR riêng, merge được từng cái — Phase 0 và 1 không phá vỡ bản web nên an toàn merge sớm.

---

## Nguồn đã tra cứu

- [Electron `safeStorage` API](https://www.electronjs.org/docs/latest/api/safe-storage) — DPAPI trên Windows, khóa theo user
- [Electron `protocol` API](https://www.electronjs.org/docs/latest/api/protocol) — `protocol.handle()`, `registerSchemesAsPrivileged()`
- [electron-builder Windows targets](https://www.electron.build/docs/win) — `nsis`, `appx`, `msix` cho Microsoft Store
- [electron/electron#42352](https://github.com/electron/electron/issues/42352) — xác nhận `showOpenFilePicker()` hoạt động trong Electron
