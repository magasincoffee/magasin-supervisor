# SC-013 — Cổng bảo trì MCP local H4 (chỉ kiểm thử mã nguồn)

Nguồn thẩm quyền duy nhất: [Supervisor SOURCE_OF_TRUTH.md](../../SOURCE_OF_TRUTH.md). Tài liệu này không cấp quyền cài đặt, xóa hàng chờ hoặc thực thi lệnh trên máy H4.

## Bằng chứng thực tế

- Kênh GitHub → H4 → GitHub đã trả biên nhận; Issue #381 vẫn ở `WAIT_OWNER_STOP`.
- Gateway local vẫn ở SHA256 `64d2758f...`; bản vá cho phép `health_check` khi STOP chưa được áp dụng.
- Hàng đợi Gateway có hai yêu cầu tồn đọng: #339 `execute_task/WAIT_SOT_AUTHORITY` và #381 `health_check/WAIT_OWNER_STOP`; cả hai chưa tạo local job. Tám mục gần nhất khác đã DONE.
- CLI chỉ hiển thị 10 worker jobs mới nhất (đều DONE). Không được coi đó là bằng chứng toàn bộ SQLite không có job hoạt động.

## Bằng chứng bắt buộc trước khi bảo trì thực tế

1. Xác minh chủ thể Owner từ GitHub độc lập bằng cả login và immutable numeric ID, sự đồng ý gắn chặt với tác vụ hiện tại, chính xác `main` SHA và đọc SOT hai lần.
2. Khẳng định chạy đúng H4; STOP và AUTOSTART_DISABLED giữ nguyên. Định danh đầy đủ hai tiến trình Gateway, worker và watchdog. Không giết các tiến trình Python không rõ chủ sở hữu.
3. Đọc toàn bộ `dispatch_inbox` và `jobs` trong cùng một snapshot nhất quán, không giới hạn 10 dòng; đối chiếu chính xác hai yêu cầu cũ, không có worker đang QUEUED/RUNNING hay mục chờ khác.
4. Tạo bản sao lưu nhất quán bằng SQLite Online Backup API trên D: với ACL hạn chế; kiểm tra hàm băm, `integrity_check` và khả năng khôi phục trên bản thử nghiệm. Không sao chép riêng tệp .sqlite3 khi WAL đang hoạt động hoặc xóa WAL/SHM.
5. Sau khi một giao diện bảo trì riêng được nghiệm thu và cấp quyền, chỉ đánh dấu đúng hai yêu cầu là `CANCELLED_STALE` bằng một transaction có điều kiện; không DELETE, không sửa dữ liệu DONE, jobs hoặc dedupe key. Xác nhận không tái nhập yêu cầu sau hai vòng Gateway poll.
6. Áp dụng bản vá `health_check` khi STOP là **một gate riêng**, có SHA nguồn, backup, giới hạn đúng tiến trình Gateway và rollback. Phải chứng minh một yêu cầu mới có local job ID, DONE và GitHub receipt; tuyệt đối không tự cấp quyền execute_task/render_qc/sync_revenue.
7. Bất kỳ sai lệch nào: HOLD hoặc ROLLBACK, không báo hoàn thành.

## Mã kiểm thử hiện tại

`src/coordinator/local_mcp_field_preflight.py` là hàm thuần chỉ đánh giá metadata tổng hợp. Không có I/O máy H4, không mở SQLite, không gọi command/shell, không chạy robot. Ngay cả khi metadata giả lập khớp, `field_apply_authorized=false` vì bằng chứng chưa được chứng thực bởi kênh field độc lập. Bài kiểm thử âm tính nằm trong `test/test_sc013_local_mcp_field_preflight.py`.

Lệnh SQLite trực tiếp từng bị cơ chế kiểm tra an toàn chặn. Không đổi cú pháp lệnh hay chuyển sang GitHub Issue/Actions, shell hoặc một agent khác để né chặn. Chỉ thực thi bằng giao diện bảo trì được duyệt và chứng minh độc lập. Issue #430 vẫn theo dõi audit độc lập toàn kiến trúc; Codex review của PR không thay thế audit đó.

**Trạng thái: SOURCE-ONLY; H4 chưa xóa yêu cầu, chưa thay Gateway, STOP vẫn bật.**