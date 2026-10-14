# MPC-010 — H4 Control Center UI release readiness (SOURCE/QA ONLY)
Date: 2026-10-14 Asia/Ho_Chi_Minh.
Authority: canonical SOURCE_OF_TRUTH.md on main; this implementation fixture does not grant installation, START, or production authority.

## Owner outcome
Display the reviewed MAGASIN PROJECT CONTROL Vietnamese Dự án tree and a read-only Supervisor status panel on DESKTOP-H4A16IL. Do not enable any robot, clear STOP/AUTOSTART_DISABLED, dispatch jobs, or change live project authority.

## Read-only H4 inventory observed 2026-10-14 19:57 +07
- Host: DESKTOP-H4A16IL, identity DESKTOP-H4A16IL\admin.
- Installed path: D:\MAGASIN_ROBOTS\control-center.
- Port 8781 was NOT LISTENING; healthz unavailable. Earlier successful HTTP requests do not attest current process liveness.
- Drive free space: C 4.69 GiB, D 56.04 GiB, subject to change.
- Installed file SHA256 snapshots:
  - server.py = 3ED5333493E3F4A3884BF78083C20FDD6C53B01AF77428E075E3A987F50165FB
  - web\app.js = 1CF3119D30276B6A2237E0E060FAD9450E537EF85A09D3DB8FA32EF936B35BAA
  - web\index.html = C982C99AB98C2AA03E23D0520CC15016652E027038AD1EC31BE31152C0E0484A
  - web\styles.css = 0968EFA7E7747ACCCFB47E214754CE0F74444E794EE9532DE29F3FEA19514C68
  - supervisor_project_links.py = AE352EAB4B6E5FE892BFE9FD1301120313B45C03ED605B9DBEEC403CC4367ACF
- The limited read did NOT independently prove current physical STOP latches or in-flight outbound transaction safety; these require separate on-host proof. No backup, source staging, install or worker change was done in this MPC-010 source scope.

## Required source inventory and dependency closure
The MPC UI bundle contains Python server.py, owner_request_drafts.py, project_tree_catalogue.py; and browser app.js, index.html, styles.css, project_tree_view.mjs, project_detail_view.mjs, project_request_view.mjs, project_supervisor_telemetry.mjs. Existing observability, project-link and Coordinator lifecycle Python imports also require independent compatibility checks. Never install only index.html/app.js: the bundle needs the Python API routes, module routing and accurate Owner session enforcement.

## Verified scope and blocker
The synthetic read-only validator src/control-center/mpc010_control_center_preflight.mjs accepts only caller-supplied metadata. All caller values, including host/STOP assertions and source hashes, remain UNTRUSTED. Its output ALWAYS has fieldApplyAuthorized=false, stageAuthorized=false, workerStartAuthorized=false, productionAccepted=false and ownerApprovalEstablished=false. A matching synthetic fixture is not real H4 proof. Negative cases cover wrong machine/admin, moved main, installed drift, STOP removal, business processes/outbound ambiguity, incomplete module bundle, low D space, wrong/multiple port listeners, unknown Owner credential state, no rollback and forbidden write scope. Both hosted Supervisor Tests and Supervisor Integrity run the targeted test.

A SEPARATE root-SOT-approved, final-head-review/CI-qualified field release gate is required for exact-main H4-only hash-pinned backup, stage and atomic application. It must independently verify physical STOP and AUTOSTART_DISABLED, frozen old/new digests, Windows process and identity, no ambiguous outbound or worker, isolated hash-verified D backups, live file readback, rollback rehearsal, only viewer restart on 127.0.0.1:8781, and HTTP healthz/API/projects/module smoke. Owner-only write routes stay locked until separately configured through approved credential handling. User acceptance over local screen/phone is a separate gate. This source-only work does NOT authorize H4 apply or a new service, job cancellation, credential setup, network exposure, worker START, production data writes or project switch.

MPC-009 remains BLOCKED by SC-013 P1-P3 and Owner authorizations. MPC-010 remains IN PROGRESS and is not a live release.


## Preserved Python dependency SHA snapshot, H4 read-only 2026-10-14
Independent file-existence/hash readback found all six auxiliary runtime modules. These are NOT imported from the new 10-file GitHub candidate and can break startup or route requests when absent or changed. Treat them as separately pinned, compatibility-checked live prerequisites, not as a bundled deployment:
- D:\MAGASIN_ROBOTS\control-center\observability.py = 7B4E2BBC830E8136D5256D223EF59E2B3CCAA9F0D77596F0F3CCDD6DE68AE469
- D:\MAGASIN_ROBOTS\control-center\cutover_preflight.py = 1A2F9D5D91E983F1CF88456BEB14F40934BE19B81250F69071C6CFA1DEF1AF98
- D:\MAGASIN_ROBOTS\control-center\specialist_readiness.py = CBEA44CF78C84C1F06F0F2F972A4E1474D9A789C947B4A03BC74E7FA7FD20AC5
- D:\MAGASIN_ROBOTS\control-center\supervisor_project_links.py = AE352EAB4B6E5FE892BFE9FD1301120313B45C03ED605B9DBEEC403CC4367ACF
- D:\MAGASIN_ROBOTS\robots\coordinator\owner_lifecycle.py = 545E83DC723C545C521DD56EDD7F53559F6A3CCBB1FC25F5C0386A161534B952
- D:\MAGASIN_ROBOTS\robots\supervisor\control_adapter.py = 90F92C32C266C6A3571347169C802C8300FFBBD6F0EC0BDD70143E2F2C68B1E5

The synthetic classifier requires the complete exact per-file hashes PLUS explicit caller-provided compatibility flags, rejecting missing, changed or unverified preserved imports. Those flags remain untrusted and do not establish live H4 readiness. Before any future approved release, run a separately reviewed H4-native import/route compatibility smoke without worker activation and re-read all dependency digests.
