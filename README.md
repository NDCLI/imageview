# Local Image Compare

Ứng dụng Vite + React để nạp nhiều ảnh local, tổng hợp ảnh trong một lưới để so sánh và mở từng ảnh trong tab mới.

## Tính năng

- Chọn nhiều ảnh local từ máy tính.
- Chọn cả thư mục local để nạp toàn bộ ảnh trong thư mục.
- Hiển thị danh sách ảnh kèm tên file, loại file, dung lượng và độ phân giải.
- Ghim tối đa 4 ảnh vào khay so sánh.
- Bấm vào ảnh bất kỳ để mở tab mới với kích thước mặc định.
- Xóa từng ảnh hoặc xóa toàn bộ.

## Chạy dự án

Cần cài Node.js trước, vì máy hiện tại chưa có `node`/`npm` trong PATH.

```bash
npm install
npm run dev
```

## Cấu trúc

- `src/App.jsx`: logic nạp ảnh local, khay so sánh, mở ảnh trong tab mới.
- `src/styles.css`: giao diện responsive.