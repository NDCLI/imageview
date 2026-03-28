# Image Viewer Pro - Universal ZIP Viewer

Ứng dụng Vite + React chuyên dụng để duyệt, so sánh và quản lý dữ liệu ảnh từ tập tin ZIP với hiệu năng cực cao và các tính năng hỗ trợ kiểm tra (audit) chuyên sâu.

## 🚀 Tính năng nổi bật

### 1. Xử lý ZIP Siêu tốc (fflate + Web Worker)
- **Hiệu năng vượt trội**: Sử dụng thư viện `fflate` và **Web Worker** để giải nén ảnh ngoài luồng chính, giữ cho giao diện luôn đạt 60 FPS ngay cả khi xử lý hàng nghìn ảnh.
- **Persistence**: Tự động nhận diện và đề xuất nạp lại file ZIP từ bộ nhớ tạm khi tải lại trang, giúp quy trình làm việc không bị gián đoạn.

### 2. Tìm kiếm & Truy vấn Thông minh (Smart Search)
- **Truy vấn theo ID Frame**: Nhập trực tiếp ID từ file `annotations.xml` vào ô tìm kiếm để nhảy đến chính xác frame cần kiểm tra.
- **Tìm kiếm theo Tên**: Hỗ trợ tìm kiếm mờ (fuzzy search) theo tên tập tin ảnh.
- **Phím tắt**: Nhấn `Ctrl + F` để kích hoạt nhanh ô tìm kiếm từ bất kỳ đâu.

### 3. Trải nghiệm Kiểm tra (Viewer UX)
- **Duy trì Zoom/Pan**: Khi đang soi chi tiết, việc chuyển ảnh (Next/Prev) sẽ giữ nguyên mức thu phóng và vị trí hiện tại, giúp so sánh các frame liên tiếp dễ dàng hơn.
- **Auto Center**: Tự động căn giữa và Fit ảnh mới vào màn hình khi người dùng không ở chế độ zoom.
- **Annotation Overlay**: Hiển thị các box annotation từ file XML với khả năng bật/tắt (Toggle) linh hoạt.
- **Footer Compact**: Hiển thị đầy đủ thông số (ID, Resolution, Zoom, Index) trên một hàng ngang tối giản.

## 🛠️ Chạy dự án

```bash
# Cài đặt dependencies
npm install

# Chạy ở chế độ development
npm run dev
```

## 📂 Miền dữ liệu (Data Domain)
- **Định dạng hỗ trợ**: Chỉ nạp dữ liệu qua tập tin **.zip** để đảm bảo tính đóng gói và hiệu năng.
- **Metadata**: Tự động nhận diện file `annotations.xml` (chuẩn CVAT) để hiển thị nhãn và khung bao (bounding boxes).

---
*Phát triển bởi Antigravity & nkhcloud*