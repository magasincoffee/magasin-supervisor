# MPC-007 — Owner-approved intent → draft issue and SOT change proposal (SOURCE/QA)

Date: 2026-10-14 Asia/Ho_Chi_Minh
Authority: canonical repository root SOURCE_OF_TRUTH.md. This subordinate engineering contract cannot override it.
State: SOURCE CANDIDATE ONLY; no live approval workflow, H4 installation, production acceptance, GitHub issue creation or canonical SOT write.

## Outcome and trust model

MPC-006 stores only immutable PENDING_OWNER_REVIEW requests. They cannot become APPROVED by changing a client field, request JSON, local project tree or SQLite row. MPC-007 adds a pure, side-effect-free projection in src/control-center/owner_intent_proposals.py, returning an issue/task draft and a proposed canonical SOT change only when provided with:

1. The exact immutable MPC-006 request snapshot, with bounded canonical JSON and SHA-256 content integrity;
2. An independently source-verified, allowlisted project SOT path and immutable main commit SHA for the same exact target (not LOCAL_UNVERIFIED UI catalogue);
3. A separate explicitly APPROVED Owner decision proof, cryptographically authenticated with a separately provisioned 32+-byte verifier secret and bound to the request ID, payload hash, target, repository/path and canonical SOT revision.

No verifier secret, signer, Owner approval endpoint, issuer, external source-verifier bridge or live database adapter is installed here. Without a separately qualified trusted source verifier + Owner decision issuer, the source projector remains not executable through Control Center. This is intentional fail-closed separation, not evidence of approved live Owner intent.

## Output

The pure propose(request, source, approval, verifier_secret=...) function produces a deterministic proposal ID and:
- structured technical_issue_draft (repository, bounded target, Owner request text, priority, screenshot references); create_issue_authorized=false;
- structured canonical_sot_change_draft (allowlisted repo/path, immutable expected-main SHA and request intent); write_sot_authorized=false;
- immutable provenance linking original request ID/hash, Owner approval receipt ID, verified SOT source/revision and exact target;
- separate approval boundary and explicit false for worker dispatch, START, project switch and H4 apply.

The output does not contain issue number, PR number, dispatch ID or SOT update receipt. Draft fields are data, not rendered HTML/Markdown. Future UI must escape them; the projector does not directly render untrusted text. No generated proposal is authority to operate the Supervisor, switch projects or modify another project's SOT.

## MPC-007 P2 repair (independent review)

The initial final-head review found that Python urlsplit silently strips interior ASCII CR/LF/TAB from GitHub attachment URLs. The repair rejects ASCII control bytes 0x00-0x1F and 0x7F before parsing, both at MPC-006 request capture and again at MPC-007 projection, and adds negative regression fixtures at each boundary. This is a source-only fail-closed validation correction; no actual screenshot fetching or H4 mutation.

## QA and release gates

test/test_mpc007_owner_intent_proposals.py exercises deterministic identity, original immutable request hash, separate Owner decision binding, rejected unsigned/mismatched/replayed revision claims, rejected cross-repository SOT path, hostile links, no side effects, and true-only-draft flags. Hosted Supervisor Tests and Integrity must invoke this suite; all four hosted Supervisor workflows must PASS at exact final PR SHA, followed by ONE independent Codex review after the full task, grouped P1/P2 repair as necessary, reviewed merge and exact-main readback. Preserve STOP/AUTOSTART_DISABLED, SC-013 P1/P2/P3, no-fee policy and unrelated H4/MCP Local states.

No actual GitHub Issue or live SOT mutation is permitted until an independently reviewed Owner-authenticated approval issuer, verified canonical source bridge and explicit Owner release authorization are separately qualified. MPC-008 may consume only separately authorized, read-only telemetry; MPC-009 dispatch remains barred until SC-013 P1–P3 independent acceptance.
