# MAGASIN Supervisor

Production local autonomy runtime for MAGASIN Business OS.

## Sole project authority

There is exactly **one** canonical project Source of Truth:

`/SOURCE_OF_TRUTH.md`

Read that file for:
- current architecture;
- implementation plan;
- task status;
- runtime contract;
- recovery behavior;
- acceptance criteria.

README is navigation only and is **not** project authority.

Any document under `docs/`, any historical JSON authority file, pull request, issue, chat transcript, runtime state file, or Git history entry that conflicts with `/SOURCE_OF_TRUTH.md` is non-authoritative.

## Current forward architecture

Owner-approved on 2026-09-28:

**Single Conversation + Disposable Chat + Persistent Source of Truth**

Forward operating rule:
- Owner supplies only the Source of Truth URL;
- Robot creates ChatGPT conversations itself;
- at most one Robot-controlled ChatGPT conversation is active at a time;
- ChatGPT conversation URLs are temporary runtime resources, not project identity;
- if a conversation becomes unusable, Robot creates a new chat and rehydrates from Source of Truth;
- persistent Planner/Executor chat URLs are superseded.

The currently installed runtime still contains legacy Planner/Executor and older Three-Lane implementation code while migration is in progress. Those implementations are not forward architecture authority.

## Historical documentation

Files under `docs/` are retained for implementation evidence, migration history, rollback analysis, and component-level reference.

In particular, the former:
- `docs/SUPERVISOR_PLANNER_EXECUTOR_V1_SOURCE_OF_TRUTH.md`
- `docs/SUPERVISOR_PLANNER_EXECUTOR_V1_SOURCE_OF_TRUTH.json`

are explicitly **SUPERSEDED / NON-AUTHORITATIVE**.

For all new work, start with `/SOURCE_OF_TRUTH.md`.
