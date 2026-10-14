# SC-013 — Kiểm kê toàn bộ hàng đợi SQLite MCP (cổng chỉ đọc)

Nguồn thẩm quyền duy nhất: [Supervisor SOURCE_OF_TRUTH.md](../../SOURCE_OF_TRUTH.md). Phạm vi thực hiện trong PR này chỉ là **mã nguồn và kiểm thử giả lập**, không chạy truy vấn trực tiếp trên H4.

## Bằng chứng đã có

- GitHub ↔ H4 ↔ GitHub từng trả receipt thành công, nhưng Issue #381 vẫn `WAIT_OWNER_STOP`.
- CSDL local Gateway theo snapshot gần nhất có #339 `WAIT_SOT_AUTHORITY`, #381 `WAIT_OWNER_STOP`, mỗi mục chưa gắn local job; 8 mục khác ở snapshot đã `DONE`.
- Lệnh `local_jobs.py recent` chỉ hiển thị 10 jobs gần nhất, đều `DONE`. **Không thể suy ra rằng toàn bộ jobs đã DONE.**
- Một lần gọi SQLite trực tiếp trên H4 đã bị cơ chế an toàn chặn. Không được đổi cách gọi hoặc thông qua GitHub Actions, MCP Agent hay shell khác để tránh chặn.

## Cơ chế kiểm thử mới

`src/coordinator/local_mcp_whole_ledger_fixture.py` tạo và chỉ chấp nhận SQLite **trong RAM**, tự nó không nhận bất kỳ đường dẫn database thật nào, không có CLI, không đọc máy H4, không khởi động worker và không kết nối mạng. Module đọc toàn bộ `dispatch_inbox` và `jobs` bằng truy vấn có số đếm chéo; nếu tổng bản ghi vượt giới hạn thì từ chối thay vì cắt bớt. Trước truy vấn COUNT đã có SQLite progress handler và thời hạn kiểm tra; từng giá trị và tổng dữ liệu đọc vào RAM được giới hạn, dùng duyệt từng dòng thay vì `fetchall()` không kiểm soát. Đây là hai lỗi P2 Codex phát hiện và được sửa trong PR #433. Review tiếp theo xác định lỗi P2 thứ ba: `ORDER BY` với bảng không có index có thể tạo sort B-tree trước khi kiểm soát dung lượng. Đã bỏ `ORDER BY`; chỉ chấp nhận hai bảng thường trong `main`, từ chối view hoặc TEMP table che tên bảng. Bộ test giả lập xác minh quét không index không tạo `USE TEMP B-TREE`. Codex review tiếp theo phát hiện hai lỗi P2 khác: virtual table (ví dụ FTS) được SQLite ghi type='table', và bất kỳ object TEMP hoặc PRAGMA temp_store=FILE nào cũng có thể ghi xuống đĩa. Bản sửa yêu cầu CREATE TABLE thông thường, temp_store=MEMORY và TEMP schema rỗng hoàn toàn; kiểm thử FTS5, bảng TEMP không liên quan và temp_store=FILE đều phải từ chối. Lỗi P2 tiếp theo liên quan metadata SQL dài chưa được giới hạn trước khi gọi `_valid_fixture`: bản sửa bật giới hạn thời gian/kích thước SQLite trước mọi truy vấn schema và kiểm tra sự tồn tại TEMP bằng `SELECT 1 ... LIMIT 1` thay vì lấy toàn bộ tên. Kiểm thử SQL comment lớn và hết hạn ngay ở bước metadata phải từ chối.

Biên nhận chỉ chứa tổng số và trạng thái, kèm hai yêu cầu cũ và các cờ sai lệch; không xuất `details`, `result_json`, log riêng tư, đường dẫn local hay credentials. SQLite fixture được đặt `query_only=ON`. Test âm tính cố tình đặt một job `QUEUED` trước 10 job gần nhất; kết quả phải phát hiện được. File SQLite, tệp tạm có tên rỗng, SQLite chưa được đăng ký và `ATTACH` phải bị từ chối.

**Không có bất kỳ giá trị kết quả nào cấp quyền tác nghiệp:** `live_h4_observed=false`, `production_database_opened=false`, `field_apply_authorized=false`, `cancellation_performed=false`.

## Bước triển khai thực tế còn thiếu

1. Kiểm tra một **kênh bảo trì được phê duyệt riêng** cung cấp toàn bộ bảng SQLite chỉ đọc theo snapshot nhất quán; xác minh danh tính, hash nguồn, SOT `main` mới nhất, STOP và tiến trình sở hữu kết nối. Không thể tự mặc định GitHub relay / Remote shell là kênh này.
2. Thực hiện kiểm kê **toàn bộ** `jobs` và `dispatch_inbox` trên H4 qua kênh đó; chỉ xuất metadata tối thiểu, phân loại `QUEUED`/`RUNNING`/không xác định; giữ biên nhận xác minh từ H4.
3. Chỉ khi bằng chứng thực tế cho thấy không có nhiệm vụ hoạt động và chỉ hai yêu cầu cũ phù hợp, mới xây dựng một nhiệm vụ áp dụng **riêng** với SQLite Online Backup API trên D:, kiểm tra WAL, ACL, hash, `integrity_check`, restore, transaction `CANCELLED_STALE`, post-readback, kiểm tra replay và rollback.
4. Cổng cập nhật Gateway để `health_check` chạy khi STOP là một việc **riêng**, không phải quyền chạy `execute_task`, `sync_revenue` hay `render_qc`.

Nếu kênh thao tác thật chưa được phê duyệt, không tiếp tục xóa hoặc thay đổi H4. Không xóa lịch sử `DONE`, checkpoint SAYDI, hay STOP/AUTOSTART_DISABLED. Theo dõi audit độc lập tại [Issue #430](https://github.com/magasincoffee/magasin-supervisor/issues/430).

**Trạng thái: source-only / chưa chạy whole-ledger trên H4 / chưa hủy hàng đợi / chưa áp dụng Gateway patch.**