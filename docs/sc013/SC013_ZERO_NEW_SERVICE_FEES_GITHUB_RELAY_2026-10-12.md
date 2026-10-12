# SC-013: Owner cost decision (2026-10-12)

Subordinate architecture note; sole authority remains `SOURCE_OF_TRUTH.md`.

The Owner approves a communication architecture with no new paid cloud services beyond the existing ChatGPT Plus subscription. Prefer the connected GitHub service to carry requests and sanitized receipts; use an existing H4-local worker for approved read-only checks. GitHub is the message transport, never task authority. Project SOT and independent Owner lifecycle controls remain mandatory. Preserve all current STOP and AUTOSTART_DISABLED locks.

Do not require OpenAI Platform credit, Secure MCP Tunnel, a new paid subscription or hosted VPS. No public inbound H4 ports. No credentials or copyrighted audiobook media in requests. Quotas and existing hardware/energy costs remain separate. Phone access and local MCP connectivity require actual field verification.

This note is not authorization to execute tasks, restart workers, switch projects, or deploy software on H4.
## Architecture and safety

Communication target: Owner using ChatGPT Plus on a phone, existing GitHub connector as a request/receipt lane, existing MAGASIN local MCP/Coordinator on H4 as a later approved read-only executor. H4 must initiate HTTPS access to GitHub; no public inbound address or paid tunnel is required. The ChatGPT/GitHub connector on phone and H4 worker connectivity remain unverified until field tests.

The first trial is SAYDI `SAYDI002-VN-001`: compare V5 inventory metadata and bounded SHA in approved folders with no rendering, no write, and no worker restart. The SAYDI SOT remains authoritative for completion. GitHub issue content must be nonsecret metadata only; do not submit real audio, manuscript, local folder paths, customer information, credentials or finance data. Public repositories may expose issue content.

GitHub Issue creation is not an execution receipt. A future local receiver must verify the real GitHub issue identity and author using fresh API reads, repository and fixed task allowlist, immutable SOT revision, Owner STOP semantics, replay protection and reliable deduplication before it can even attempt read-only work. Existing legacy dispatch issue formats and old ambiguous messages must never be reused. P1 project selection, P2 MCP/browser transport and P3 Business Executor remain unqualified and independently gated.

Do not build an always-on polling loop or H4 service just because this document merged. First perform source-only architecture/unit testing, then obtain independent field proof via an authorized H4 channel. Only later, after reviewed gates, consider low-frequency bounded read-only polling with rate-limit backoff and clear status receipts. No automatic worker, service or production activation is authorized.

## Cost policy

Use GitHub features within their included/free limits; avoid Actions fanout, larger hosted runners and storage overages. GitHub's self-hosted runner has no separate Actions usage charge, but the Owner bears computer operation/energy. OpenAI API billing and ChatGPT Plus billing are separate; never assume a ChatGPT Plus subscription pays for Platform API calls.

References: https://docs.github.com/en/billing/concepts/product-billing/github-actions ; https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api ; https://help.openai.com/en/articles/12584461-developer-mode-and-full-mcp-connectors-in-chatgpt ; https://help.openai.com/en/articles/9039756-managing-billing-for-chatgpt-and-the-api-platform .
