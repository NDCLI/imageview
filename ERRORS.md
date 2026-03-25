# ERROR LOGS

Mọi lỗi phát sinh trong quá trình phát triển sẽ được ghi lại tại đây để học hỏi và rút kinh nghiệm.

## [2026-03-25 21:51] - Lỗi Trắng Màn Hình Khi Deploy GitHub Pages

- **Type**: Agent/Process
- **Severity**: Critical
- **File**: `.github/workflows/jekyll-gh-pages.yml`
- **Agent**: oh
- **Root Cause**: Tồn tại 2 workflow deploy song song (`static.yml` và `jekyll-gh-pages.yml`). GitHub Pages có thể đã ưu tiên Jekyll (mặc định) để deploy root `index.html` thay vì deploy từ thư mục `dist` sau khi build Vite. Kết quả là trình duyệt không tìm thấy file `/src/main.jsx`.
- **Error Message**: 
  ```
  GET https://nkhcloud.github.io/src/main.jsx net::ERR_ABORTED 404
  ```
- **Fix Applied**: Xoá bỏ workflow Jekyll dư thừa, giữ lại workflow build Vite chuyên dụng.
- **Prevention**: Luôn kiểm tra các workflow mặc định khi clone project hoặc khởi tạo. Đảm bảo chỉ có một luồng deploy duy nhất và đúng mục tiêu (`dist` cho Vite). Tên repo và `base` trong `vite.config.js` phải khớp nhau.
- **Status**: Fixed

---
