import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

test("control panel is a three-lane Owner-facing surface", async () => {
  const source = await fs.readFile(
    new URL("../windows/control-panel.ps1", import.meta.url),
    "utf8"
  );

  assert.match(source, /MAGASIN BUSINESS OS — 3 LUỒNG LÀM VIỆC/);
  assert.match(source, /3 LUỒNG ĐỘC LẬP/);
  assert.match(source, /for \(\$i = 0; \$i -lt 3; \$i\+\+\)/);
  assert.match(source, /lane-1/);
  assert.match(source, /lane-2/);
  assert.match(source, /lane-3/);
  assert.match(source, /lanes\.json/);
  assert.match(source, /lane-registry\.json/);
  assert.match(source, /lane-status\.json/);
});

test("each lane has Owner Brain URL and optional Owner-or-Robot Work URL", async () => {
  const source = await fs.readFile(
    new URL("../windows/control-panel.ps1", import.meta.url),
    "utf8"
  );

  assert.match(source, /LINK BỘ NÃO/);
  assert.match(source, /LINK WORK/);
  assert.match(source, /\$workBox\.ReadOnly = \$false/);
  assert.match(source, /Test-ChatConversationUrl/);
  assert.match(source, /brain_url/);
  assert.match(source, /work_url/);
  assert.match(source, /brain_url_revision/);
  assert.match(source, /work_url_revision/);
  assert.match(source, /LƯU BỘ NÃO/);
  assert.match(source, /Save-BrainTarget/);
  assert.match(source, /\$ui\.Brain\.Enabled = \$true/);
  assert.match(source, /\$ui\.Work\.Enabled = \$true/);
  assert.match(source, /LƯU WORK/);
  assert.match(source, /Save-WorkTarget/);
  assert.match(source, /work_url_saved_at/);
  assert.match(source, /work_mode/);
  assert.match(source, /LINK WORK không hợp lệ/);
  assert.doesNotMatch(source, /DÙNG CHAT ĐANG MỞ LÀM BỘ NÃO/);
  assert.doesNotMatch(source, /BRAIN_REBIND\.request\.json/);
});

test("each lane has independent start and stop controls", async () => {
  const source = await fs.readFile(
    new URL("../windows/control-panel.ps1", import.meta.url),
    "utf8"
  );

  assert.match(source, /▶  BẮT ĐẦU LUỒNG/);
  assert.match(source, /■  DỪNG LUỒNG/);
  assert.match(source, /Save-Lane \$id/);
  assert.match(source, /\$lane\.enabled = \$Enabled/);
  assert.match(source, /\$ui\.Project\.Enabled = -not \$enabled/);
  assert.match(source, /\$ui\.Brain\.Enabled = \$true/);
  assert.match(source, /\$ui\.SaveBrain\.Enabled = \$true/);
});

test("Owner opens explicit Brain or Work URLs in the dedicated Robot Chrome profile", async () => {
  const panel = await fs.readFile(
    new URL("../windows/control-panel.ps1", import.meta.url),
    "utf8"
  );
  const launcher = await fs.readFile(
    new URL("../windows/open-supervisor-chat.ps1", import.meta.url),
    "utf8"
  );

  assert.match(panel, /Open-RobotUrl/);
  assert.match(panel, /open-supervisor-chat\.ps1/);
  assert.match(panel, /'-Url'/);
  assert.match(launcher, /\[string\]\$Url/);
  assert.match(launcher, /browser_profile/);
  assert.match(launcher, /--user-data-dir=/);
  assert.match(launcher, /--remote-debugging-address=127\.0\.0\.1/);
});

test("lane UI exposes plain-language live states", async () => {
  const source = await fs.readFile(
    new URL("../windows/control-panel.ps1", import.meta.url),
    "utf8"
  );

  for (const label of [
    "ĐÃ DỪNG",
    "CẦN LINK BỘ NÃO",
    "ĐANG CHỜ BỘ NÃO",
    "ĐANG LÀM VIỆC",
    "ĐANG GỬI KẾT QUẢ",
    "SẴN SÀNG",
    "ĐANG TỰ KHÔI PHỤC",
    "CẦN BẠN XỬ LÝ"
  ]) {
    assert.match(source, new RegExp(label));
  }
});

test("control panel uses fixed Vietnam time", async () => {
  const source = await fs.readFile(
    new URL("../windows/control-panel.ps1", import.meta.url),
    "utf8"
  );

  assert.match(source, /SE Asia Standard Time/);
  assert.match(source, /TimeZoneInfo\]::ConvertTime/);
  assert.match(source, /dd\/MM\/yyyy HH:mm:ss/);
  assert.match(source, /giờ Việt Nam/);
  assert.doesNotMatch(source, /ToLocalTime\(\)/);
});

test("control panel integrates an explicitly configured local GitHub Runner", async () => {
  const source = await fs.readFile(
    new URL("../windows/control-panel.ps1", import.meta.url),
    "utf8"
  );

  assert.match(source, /SUPERVISOR_RUNNER_ROOT/);
  assert.match(source, /Runner\.Listener\.exe/);
  assert.match(source, /KẾT NỐI GITHUB/);
  assert.match(source, /GITHUB ĐANG KẾT NỐI/);
});

test("installer normalizes Vietnamese panel to UTF-8 BOM and syntax-checks it", async () => {
  const source = await fs.readFile(
    new URL("../windows/install-supervisor.ps1", import.meta.url),
    "utf8"
  );

  assert.match(source, /UTF8Encoding\(\$true\)/);
  assert.match(source, /Language\.Parser\]::ParseFile/);
  assert.match(source, /Control panel PowerShell syntax check failed/);
  assert.match(source, /MAGASIN BUSINESS OS CONTROL\.lnk/);
});


test("control panel hot-saves Work and stages AUTO without requiring lane stop", async () => {
  const source = await fs.readFile(
    new URL("../windows/control-panel.ps1", import.meta.url),
    "utf8"
  );

  assert.match(source, /MỞ WORK/);
  assert.match(source, /LƯU WORK/);
  assert.match(source, /TỰ TẠO WORK/);
  assert.match(source, /Save-WorkTarget \$id \$workUrl/);
  assert.match(source, /Save-WorkTarget \$id '' \$true \$true/);
  assert.match(source, /ĐÃ LƯU WORK · revision/);
  assert.match(source, /ĐANG CHỜ ÁP DỤNG/);
  assert.match(source, /\$ui\.ResetWork\.Enabled = \$true/);
  assert.match(source, /\$ui\.SaveWork\.Enabled = \$true/);
  assert.match(source, /Không tăng revision/);
});

test("invalid Work URL is rejected before config mutation and save does not start runtime", async () => {
  const source = await fs.readFile(
    new URL("../windows/control-panel.ps1", import.meta.url),
    "utf8"
  );
  const start = source.indexOf("function Save-WorkTarget");
  const end = source.indexOf("function Save-BrainTarget", start);
  const saveWork = source.slice(start, end);

  assert.match(source, /ConvertTo-CanonicalChatConversationUrl/);
  assert.match(source, /LINK WORK không hợp lệ/);
  assert.match(saveWork, /Write-JsonAtomic \$configFile \$config/);
  assert.doesNotMatch(saveWork, /Start-Process/);
  assert.doesNotMatch(saveWork, /Request-LifecycleRecovery/);
});

test("Brain target can be saved independently while lane is active", async () => {
  const source = await fs.readFile(
    new URL("../windows/control-panel.ps1", import.meta.url),
    "utf8"
  );

  assert.match(source, /function Save-BrainTarget/);
  assert.match(source, /brain_url_revision/);
  assert.match(source, /\$saveBrain\.Text = 'LƯU BỘ NÃO'/);
  assert.match(source, /Save-BrainTarget \$id \$brainUrl/);
  assert.match(source, /kể cả khi Work hiện tại vẫn đang chạy/);
});
