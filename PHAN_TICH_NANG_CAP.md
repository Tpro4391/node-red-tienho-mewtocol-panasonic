# Báo cáo phân tích & nâng cấp node-red-contrib-mewtocol

Phiên bản gốc: **0.0.12** (Oleg Aroslanov, 11/2022, phụ thuộc `jsmewtocol` 0.0.7)
Phiên bản nâng cấp: **1.0.0** — gói `@tpro4391/node-red-tienho-mewtocol-panasonic`, 07/10/2026

---

## 1. Tóm tắt

Bản gốc chỉ gồm 7 node đọc, mỗi node ~45 dòng chép gần như y hệt nhau, toàn bộ giao thức nằm ở thư viện `jsmewtocol`.
Qua rà soát mã và chạy thử với PLC giả lập, phát hiện **2 lỗi chức năng nghiêm trọng**, **nhiều lỗi về độ ổn định** và
một vấn đề kiến trúc lớn: **mỗi message mở một kết nối TCP mới** — trên PLC thật (ET-LAN chỉ nhận vài kết nối) điều này
làm phần lớn lệnh bị từ chối khi poll dày.

Bản 1.0.0 viết lại toàn bộ lõi giao thức (không còn phụ thuộc runtime), dùng **một kết nối TCP bền vững + hàng đợi** cho
mỗi PLC, bổ sung các node **ghi** và các kiểu dữ liệu, đồng thời **giữ tương thích 100%** với flow cũ.

## 2. Các lỗi tìm thấy trong bản 0.0.12

| # | Mức độ | Vị trí | Mô tả | Hậu quả |
|---|--------|--------|-------|---------|
| 1 | **Nghiêm trọng** | `mewtocol-rs.js`, `mewtocol-rk.js` | Gọi `mewclient.RR(...)` thay vì `RS` / `RK` | Node RS/RK trả về **system register**, không phải giá trị timer/counter — dữ liệu sai mà không báo lỗi |
| 2 | **Nghiêm trọng** | mọi node | Tạo `new MewClient()` (1 socket TCP) cho **mỗi** message | Cạn số kết nối của ET-LAN; thử với PLC giả lập giới hạn 4 socket: **292/300 lệnh thất bại** |
| 3 | Cao | `jsmewtocol.sendCommand` | Xử lý gói theo từng sự kiện `data`, không ghép luồng theo CR | Khi TCP chia nhỏ gói (Wi-Fi, bộ chuyển đổi serial→Ethernet) → lỗi "Unexpected response" |
| 4 | Cao | `jsmewtocol` multi-frame | Frame đầu bị cắt mất 3 ký tự (`slice(3, …)`) | Đọc > 509 word (frame `<`) trả về **giá trị sai lệch** (đã tái hiện: 0,1,2 → 4096, 8192, 12288) |
| 5 | Cao | mọi node | `msg.x ? msg.x : config.x` | `msg.startaddress = 0` bị bỏ qua, dùng giá trị cấu hình |
| 6 | Cao | mọi node | `RED.nodes.getNode(config.server)` không kiểm tra null | Xoá/thiếu config node → TypeError trong handler |
| 7 | Trung bình | `jsmewtocol` | Mỗi lệnh thêm listener `data`/`error` mới, không gỡ | Rò rỉ listener nếu dùng lại client |
| 8 | Trung bình | `jsmewtocol` | `emit('error')` | Không có listener → crash tiến trình Node-RED |
| 9 | Trung bình | `jsmewtocol.RCP` | `split()` không đối số | RCP trả về 1 số thay vì mảng bit (không được node nào dùng) |
| 10 | Trung bình | mọi node | Lỗi tham số chỉ `node.error()` rồi `return` | Không có gì ra output lỗi, không gắn msg → Catch node không bắt được |
| 11 | Trung bình | mọi node | Output 2 gửi object `{error}` thô | Không giữ các thuộc tính của msg gốc (topic, …) |
| 12 | Thấp | toàn bộ | Gửi BCC `**` (bỏ qua kiểm tra), không kiểm tra BCC phản hồi | Không phát hiện nhiễu đường truyền |
| 13 | Thấp | node | Không có handler `close`, không dùng `send/done` | Socket treo khi redeploy; không tương thích chuẩn Node-RED ≥ 1.0 |
| 14 | Thấp | `mewtocol-client.html` | Regex host sai thứ tự ưu tiên; thiếu `</div>` | Validate host gần như vô tác dụng; HTML lỗi |
| 15 | Thấp | `package.json` | `"main": "node"` không tồn tại; license `MIT-feh` không phải SPDX; phụ thuộc gói `net` / `events` vô nghĩa | Cảnh báo npm, gói rác |

## 3. Kiến trúc mới

```
mewtocol-client (config node)
   └── MewtocolClient  (lib/client.js)   kiểm tra tham số, chia nhỏ theo frame, kiểu dữ liệu
        └── MewtocolConnection (lib/connection.js)
              • 1 socket TCP / PLC, hàng đợi FIFO (1 lệnh tại một thời điểm – đúng chuẩn MEWTOCOL)
              • ghép luồng theo CR, multi-frame '&', BCC, kiểm tra header/station/mã lệnh
              • timeout từng lệnh → reset socket để không lệch luồng
              • tự kết nối lại (back-off 2 s → 30 s), fail-fast khi PLC offline, giới hạn hàng đợi
        └── lib/protocol.js     hàm thuần: BCC, build frame, mã hoá word, int32/float32/string/bits, RT …
mewtocol/common.js     khung chung cho mọi node: msg ưu tiên hơn config, xử lý lỗi, status, send/done
mewtocol/mewtocol-*.js mỗi node chỉ còn 5-15 dòng
```

Các node: **RD, RCC, RCS, RCP, RS, RK, RR, RT** (đọc) · **WD, WCC, WCS, WS, WK** (ghi) · **RAW** (lệnh bất kỳ).

Tối ưu chính:
- Dùng chung kết nối: 300 lệnh → **1** kết nối thay vì 300; không tốn thời gian bắt tay TCP mỗi lệnh
  (LAN không trễ: 119 ms → 25 ms).
- Tự chia lệnh: đọc/ghi bao nhiêu word cũng được, mỗi frame vừa 118 ký tự (`%`) hoặc 2048 ký tự (`<`).
  Chế độ `<` đọc 1200 word chỉ bằng 3 lệnh.
- Trạng thái node chỉ cập nhật khi thay đổi (giảm tải websocket cho editor khi poll nhanh).

## 4. Kiểm thử

- **40 test tự động** (`npm test`) chạy với PLC giả lập `test/mock-plc.js`: BCC theo ví dụ trong tài liệu Panasonic
  (`%01#RCSX00001D`), mọi lệnh đọc/ghi, mọi kiểu dữ liệu, TCP bị chia nhỏ ngẫu nhiên, multi-frame, lỗi PLC,
  lỗi BCC, timeout, PLC ngắt kết nối, PLC chỉ nhận 1 socket, flow 0.0.12, thiếu config node.
- Chạy Node-RED 4.1 thật + trình duyệt headless: 15 node nạp không lỗi, mở hộp thoại của từng node không lỗi JS,
  node/config cũ hiển thị đúng giá trị mặc định.

So sánh (300 lệnh RD 10 word gửi đồng thời):

| Kịch bản | 0.0.12 | 1.0.0 |
|----------|--------|-------|
| LAN, PLC trả lời ngay | 300/300 OK, 300 kết nối, 119 ms | 300/300 OK, **1** kết nối, 25 ms |
| PLC thực tế (CPU xử lý tuần tự 5 ms/lệnh, tối đa 4 socket) | **8/300 OK**, 292 bị từ chối | **300/300 OK**, 1,6 s |
| Đọc 200 word, gói TCP bị chia nhỏ | Lỗi "Unexpected response" | Đúng |

> Lưu ý: với PLC giả lập "lý tưởng" (không giới hạn socket, xử lý song song), bản cũ nhanh hơn vì mở 160 socket song song.
> PLC thật không hoạt động như vậy — MEWTOCOL được CPU xử lý tuần tự và module Ethernet chỉ nhận vài kết nối.

## 5. Tương thích ngược

- Giữ nguyên tên node (`mewtocol-rd`, …), tên thuộc tính (`station`, `area`, `startaddress`, `endaddress`, `address`,
  `sendonerror`) và định dạng output mặc định (int16, 1 giá trị → số, nhiều giá trị → mảng; RT trả object như cũ, thêm `mode`).
- Config node cũ (chỉ có host/port/timeout) chạy với BCC bật, giữ kết nối, frame chuẩn `%`.
- Khác biệt có chủ đích: lỗi tham số nay đi ra output 2; output 2 là bản sao msg gốc có thêm `msg.error` (chuỗi, như cũ),
  `msg.errorCode`, `msg.plcErrorCode`; lỗi cũng được báo tới Catch node. Kết quả có thêm `msg.mewtocol`.
- Đọc > 20 word: bản cũ dùng header `<`, bản mới mặc định `%` + tự chia lệnh (chạy được trên mọi dòng PLC, kể cả FP0/FP2 đời cũ).
  Chọn *Extended* trong config nếu PLC hỗ trợ để giảm số lượt hỏi-đáp.

## 6. Triển khai

```bash
cd ~/.node-red
npm uninstall node-red-contrib-mewtocol        # gỡ bản gốc nếu đã cài (trùng tên node type)
npm install @tpro4391/node-red-tienho-mewtocol-panasonic
```
Khởi động lại Node-RED. Ví dụ flow: *Menu → Import → Examples → @tpro4391/node-red-tienho-mewtocol-panasonic → basic-read-write*.

## 7. Hạn chế & khuyến nghị

1. **Chưa thử trên PLC thật.** Toàn bộ kiểm thử dựa trên PLC giả lập viết theo tài liệu MEWTOCOL-COM. Nên chạy thử RD/WD/RT,
   WCS và một lệnh đọc dài (> 27 word) trên PLC của dự án trước khi đưa vào sản xuất. Phần dễ khác biệt nhất giữa các dòng PLC là
   định dạng multi-frame và hỗ trợ header `<` (đã tránh bằng cách tự chia lệnh).
2. Khi ghi một khối lớn bị chia thành nhiều lệnh, việc ghi **không còn nguyên tử** (PLC có thể chạy 1 scan giữa hai lệnh).
   Với dữ liệu cần nhất quán, giữ khối ghi ≤ 24 word (`%`) hoặc ≤ 507 word (`<`).
3. Gói phát hành với tên `@tpro4391/node-red-tienho-mewtocol-panasonic` nhưng giữ nguyên tên node type để flow cũ chạy được, vì vậy không cài song song với gói gốc. Giấy phép gốc yêu cầu ghi nhận tác giả — đã giữ trong README/LICENSE.
4. Chưa hỗ trợ: ghi nhiều frame từ host (không cần vì đã tự chia), MEWTOCOL qua cổng serial trực tiếp (dùng bộ chuyển đổi TCP),
   các lệnh RM/MD/RP (có thể gửi qua node RAW).
5. Test tự động cần Node.js ≥ 18 (dùng `node:test`); runtime của node chạy từ Node.js 14.
