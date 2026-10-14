import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(
  new URL("../.github/scripts/sc013-watchdog-owner-onefile-apply.ps1",import.meta.url),
  "utf8"
);

test("approved H4 Owner Windows identity and real elevated token are mandatory", () => {
  for(const token of [
    "DESKTOP-H4A16IL","DESKTOP-H4A16IL\\admin",
    "S-1-5-21-604228481-1555572614-3695427994-1001",
    "OWNER_ADMIN_TOKEN_REQUIRED","OWNER_IDENTITY_MISMATCH",
    "SC013_WATCHDOG_ONLY_H4_OWNER_APPROVED_20261014",
    "STAGE_OWNER_OR_ACL_MISMATCH","STAGE_ACL_HAS_UNAPPROVED_ENTRY",
  ]) assert.ok(source.includes(token),token);
  assert.match(source,/GetOwner\(\[Security.Principal.SecurityIdentifier\]\)/);
  assert.match(source,/\.AreAccessRulesProtected/);
});

test("only exact canonical nonreparse H4 root and fresh GitHub main are accepted", () => {
  for(const token of [
    "C:\\Users\\admin\\AppData\\Local\\MAGASIN\\BusinessOS\\supervisor",
    "CANONICAL_SUPERVISOR_ROOT_MISMATCH","RUNTIME_OR_STAGE_ANCESTOR_REDIRECTED",
    "refs/heads/main","LIVE_MAIN_NOT_PINNED","LIVE_MAIN_UNAVAILABLE",
    "STOP","AUTOSTART_DISABLED","OWNER_STOP_LATCH_MISSING",
    "STAGED_MANIFEST_MISMATCH","owner_sid",
  ]) assert.ok(source.includes(token),token);
  assert.match(source,/git -c credential.interactive=never ls-remote/);
  assert.match(source,/Assert-NoReparseDirs/);
});

test("exclusive same-handle write prevents check/write races", () => {
  assert.match(source,/\[IO.FileShare\]::None/);
  assert.match(source,/\$liveHandle = \[IO.File\]::Open\(\$live/);
  assert.match(source,/Read-LockedFile \$liveHandle/);
  assert.match(source,/Write-LockedFile \$liveHandle \$sourceBytes/);
  assert.match(source,/EXCLUSIVE_LIVE_HASH_CHANGED/);
  assert.match(source,/Assert-LiveFileHandle \$liveHandle/);
  assert.match(source,/GetFileInformationByHandle/);
  assert.match(source,/GetFinalPathNameByHandle/);
  assert.match(source,/NumberOfLinks -ne 1/);
  assert.match(source,/WATCHDOG_HANDLE_TARGET_MISMATCH/);
  assert.match(source,/WATCHDOG_HANDLE_REPARSE_OR_HARDLINK/);

  assert.match(source,/\$stream\.Flush\(\$true\)/);
  assert.match(source,/WATCHDOG_RUNTIME_RELOAD_NOT_PROVEN=True/);
  assert.doesNotMatch(source,/Move-Item -LiteralPath \$temp -Destination \$live/);
  assert.doesNotMatch(source,/Copy-Item -LiteralPath \$backup -Destination \$live/);
  assert.doesNotMatch(source,/Start-Process|Restart-(?:Process|Service|Computer)|Stop-(?:Process|Service|Computer)|Start-(?:Service|Job)|Invoke-Expression|Start-ScheduledTask|schtasks|sqlite3|dispatch_gateway|local_jobs\.py/i);
});

test("durable APPLY_STARTED journal precedes write and recovery is explicit", () => {
  assert.match(source,/SC013_WATCHDOG_EXCLUSIVE_FILE_TRANSACTION_V1/);
  assert.match(source,/Write-DurableReceipt \$transaction/);
  assert.match(source,/INTERRUPTED_TRANSACTION_REQUIRES_RECOVER/);
  assert.match(source,/UNQUALIFIED_RECOVERY_JOURNAL/);
  assert.match(source,/NO_INTERRUPTED_TRANSACTION/);
  assert.match(source,/Write-LockedFile \$liveHandle \$backupBytes/);
  assert.match(source,/RECOVERY_DIGEST_MISMATCH/);
  assert.match(source,/Write-DurableReceipt \$receipt/);
  assert.match(source,/\[IO.File\]::Move\(\$temporary,\$file\)/);
  assert.match(source,/\$stageLock = \[IO.File\]::Open\(\$lockPath,\[IO.FileMode\]::OpenOrCreate/);
  assert.match(source,/Assert-PlausiblePartialWrite \$bytesBefore \$backupBytes \$sourceBytes/);
  assert.match(source,/RECOVERY_HOLD_EXTERNAL_EDIT/);

  assert.ok(source.indexOf("Write-DurableReceipt $transaction") <
    source.indexOf("Write-LockedFile $liveHandle $sourceBytes"));
});
