# Image Viewer Pro - Stable Base

Ứng dụng Vite + React tối ưu hóa cho việc duyệt, so sánh và quản lý ảnh từ tập tin ZIP với tính ổn định cao.

## 🚀 Tính năng nổi bật

### 1. Xử lý ZIP (fflate + Web Worker)
- **Hiệu năng cao**: Sử dụng `fflate` để giải nén ZIP với tốc độ vượt trội.
- **Không treo UI**: Toàn bộ quá trình giải nén được xử lý bởi **Web Worker**, đảm bảo giao diện luôn mượt mà (60 FPS) ngay cả khi nạp tệp ZIP lớn.
- **Hỗ trợ nạp lại**: Tự động nhận diện và đề xuất nạp lại dữ liệu ZIP từ bộ nhớ tạm để tiết kiệm thời gian.

### 2. Hệ thống Tìm kiếm Thông minh (Smart Search)
- **Tìm kiếm kép**: Tìm theo cả **Tên ảnh** và **Frame ID** tại một ô nhập liệu duy nhất.
- **Phím tắt nhanh**: Nhấn `Ctrl + F` để kích hoạt nhanh ô tìm kiếm.
- **Phản hồi tức thì**: Nhảy đến ảnh ngay khi tìm thấy kết quả.

### 3. Giao diện Người dùng Tối ưu (UI/UX)
- **Footer Compact**: Toàn bộ thông số (Stats, Search, Frame, Resolution, Zoom) được ép trên **1 hàng ngang**, tiết kiệm diện tích tối đa cho việc hiển thị ảnh.
- **Auto Reset Zoom**: Tự động căn chỉnh ảnh về chế độ `fit-to-screen` mỗi khi chuyển ảnh, đảm bảo trải nghiệm liền mạch bất kể độ phân giải.

## 🛠️ Chạy dự án

```bash
# Cài đặt dependencies
npm install

# Chạy ở chế độ development
npm run dev
```

## 📂 Miền dữ liệu (Data Domain)
- Chỉ hỗ trợ nạp dữ liệu qua tập tin **.zip**.
- Tự động parse file **annotations.xml** để hiển thị thông tin metadata/frame đi kèm.

---
*Phát triển bởi nkhcloud*