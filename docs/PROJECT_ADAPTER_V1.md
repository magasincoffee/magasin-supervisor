# Supervisor Project Adapter V1

Status: MIG-003 platform contract

## Purpose

Supervisor is an orchestration platform. Project/business policy remains owned by the project and its Brain/source-of-truth. Supervisor consumes only bounded orchestration inputs through an explicit adapter document.

Schema: `supervisor-project-adapter.v1`

## Minimal document

```json
{
  "schema_version": "supervisor-project-adapter.v1",
  "project_state": {
    "project": "Example Project",
    "repository": "example/project",
    "current_phase": "PHASE-A",
    "current_task": "WORK-001",
    "current_task_title": "Example work item",
    "next_task": "WORK-002",
    "status": "READY",
    "autonomy": "AUTO_CONTINUE",
    "blocked": false,
    "requires_user": false,
    "supervisor_orchestration": {
      "mode": "BRAIN_WORKER_V1"
    },
    "instructions": {
      "continue": "Project-owned continuation policy.",
      "owner_reconcile": "Project-owned Owner-boundary reconciliation policy.",
      "handoff": "Project-owned handoff policy.",
      "brain_bootstrap": "Project-owned Brain bootstrap policy."
    }
  }
}
```

## Source resolution

Exactly one source is allowed:

- `SUPERVISOR_PROJECT_ADAPTER_PATH` / `--project-adapter`
- `SUPERVISOR_PROJECT_ADAPTER_URL` / `--project-adapter-url`

The legacy CLI flag `--state-url` remains a compatibility alias for an explicit adapter URL. It does not provide a default.

If no adapter source is configured, platform runtime fails closed. There is no default Business OS repository or PROJECT_STATE path.

## Boundary

The adapter intentionally does not copy CURRENT_STATE, TASK_QUEUE, business documents, credentials, private URLs, message content, browser profile data or project source-of-truth into the Supervisor repository.

The optional instruction fields are bounded strings supplied by the project integration boundary. Generic fallback instructions are project-neutral and fail closed on ambiguity.

Implementation: `src/project-adapter.mjs`
Tests: `test/project-adapter.test.mjs`
