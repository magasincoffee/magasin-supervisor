# Platform Mirror — MAGASIN_LANE_DIRECTIVE_V1 Protocol

> MIG-002 platform-oriented mirror. Business OS original remains unchanged and authoritative for project integration during the compatibility window.
> Protocol semantics and byte-exact markers are unchanged. Deep project-state decoupling is deferred to MIG-003.

# MAGASIN_LANE_DIRECTIVE_V1 — Canonical Brain → Robot Protocol

Status: **CANONICAL / REQUIRED FOR ALL MAGASIN BRAIN PROJECTS**

Purpose: define the exact machine-readable response a Brain must return so MAGASIN Supervisor can parse it and dispatch work to the lane's Work conversation.

This protocol is project-agnostic. Any MAGASIN Brain — Coffee, Content Money Engine, Cup, or a future project — must use this exact serialization when controlled by Supervisor Three-Lane.

## 1. Mandatory output rule

When the Robot asks a Brain for the next directive, the Brain must return **exactly one fenced code block** containing one valid directive block.

Recommended Brain response:

~~~text
<<<MAGASIN_LANE_DIRECTIVE_V1>>>
{"action":"WORK","task_id":"TASK-ID","instruction":"Self-contained work instruction"}
<<<END_MAGASIN_LANE_DIRECTIVE_V1>>>
~~~

The fenced code block is recommended because ChatGPT should render the marker characters literally. The Robot reads the rendered assistant text; the Markdown fence itself is not part of the directive payload.

Do not add explanatory prose before or after the directive when the Brain is operating under Robot control.

## 2. Exact markers

The start marker must be exactly:

~~~text
<<<MAGASIN_LANE_DIRECTIVE_V1>>>
~~~

The end marker must be exactly:

~~~text
<<<END_MAGASIN_LANE_DIRECTIVE_V1>>>
~~~

These are invalid and must never be emitted:

~~~text
<<\<MAGASIN_LANE_DIRECTIVE_V1>>>
<<\<END_MAGASIN_LANE_DIRECTIVE_V1>>>
"<<<MAGASIN_LANE_DIRECTIVE_V1>>>"
<<< MAGASIN_LANE_DIRECTIVE_V1 >>>
~~~

Do not insert a backslash before `<`. Do not add spaces inside the marker. Do not wrap the entire block in quotation marks.

## 3. WORK schema

Canonical WORK directive:

~~~text
<<<MAGASIN_LANE_DIRECTIVE_V1>>>
{"action":"WORK","task_id":"MCME-011","instruction":"BẮT ĐẦU MCME-011. Thực hiện đúng một task. Trả evidence và dừng sau task này."}
<<<END_MAGASIN_LANE_DIRECTIVE_V1>>>
~~~

Required fields:

- `action`: `"WORK"`
- `task_id`: non-empty task identifier accepted by the Supervisor parser
- `instruction`: non-empty, self-contained instruction for Work

Current `task_id` parser contract:

~~~text
^[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}$
~~~

Examples of valid IDs:

- `TASK-RBT-005/LONG-RUNNING-WORK-WATCHDOG-01`
- `MCME-011`
- `TASK-065`
- `CUP:STOCK.AUDIT-01`

## 4. IDLE schema

If there is no dependency-correct work to dispatch:

~~~text
<<<MAGASIN_LANE_DIRECTIVE_V1>>>
{"action":"IDLE"}
<<<END_MAGASIN_LANE_DIRECTIVE_V1>>>
~~~

Do not invent placeholder tasks merely to avoid IDLE.

## 5. JSON serialization rules

The content between the markers must be valid JSON.

Required:

- use double quotes around JSON keys and string values;
- escape an internal double quote as `\"`;
- encode a literal backslash as `\\`;
- if a newline is needed inside `instruction`, encode it as `\n`;
- keep the directive to one JSON object;
- prefer a single-line JSON object for reliability.

Never use invalid JSON escapes such as:

~~~text
\<
\'
\a
~~~

Example of an invalid instruction fragment:

~~~text
"safe_reference=\<public reference>"
~~~

Use this instead:

~~~text
"safe_reference=PUBLIC_OR_SANITIZED_REFERENCE_IF_ANY"
~~~

## 6. No Markdown transformation inside machine fields

Inside `instruction`, prefer plain text.

Do not use Markdown links:

~~~text
[https://www.pinterest.com/example/](https://www.pinterest.com/example/)
~~~

Use the raw URL:

~~~text
https://www.pinterest.com/example/
~~~

Avoid angle-bracket placeholders that may be transformed by Markdown rendering. Prefer uppercase symbolic placeholders:

~~~text
OWNER_EMAIL
PUBLIC_OR_SANITIZED_REFERENCE_IF_ANY
EXACT_COMMIT_SHA
~~~

Markdown emphasis, headings, tables, nested code fences, and blockquotes are unnecessary inside `instruction` and should be avoided in machine directives.

## 7. Brain responsibility

The Brain, not the Robot, owns directive serialization.

Before returning a WORK directive, Brain must verify:

1. exactly one start marker exists;
2. exactly one end marker exists;
3. neither marker contains a backslash;
4. JSON parses as one object;
5. `action` is WORK;
6. `task_id` matches the allowed format;
7. `instruction` is non-empty and self-contained;
8. raw URLs are used instead of Markdown links;
9. no invalid JSON escape exists;
10. Work is told where to stop and must not self-start the next task.

If any check fails, Brain must repair its own output before answering.

## 8. Recommended Brain system instruction

Every MAGASIN project Brain controlled by Supervisor should include this rule in its persistent architecture/prompt:

~~~text
ROBOT DIRECTIVE OUTPUT CONTRACT

When MAGASIN Supervisor requests the next directive, return exactly one fenced code block and no prose outside it.

The code block must contain exactly:

<<<MAGASIN_LANE_DIRECTIVE_V1>>>
VALID_JSON_OBJECT
<<<END_MAGASIN_LANE_DIRECTIVE_V1>>>

For work:
{"action":"WORK","task_id":"TASK-ID","instruction":"SELF-CONTAINED INSTRUCTION"}

For no work:
{"action":"IDLE"}

Hard rules:
- markers must be byte-exact;
- never emit <<\<MAGASIN... or any backslash before <;
- JSON must be valid;
- no Markdown links inside instruction; use raw URLs;
- no angle-bracket placeholders; use plain symbolic placeholders;
- task_id must match ^[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}$;
- exactly one directive per response;
- no explanation outside the fenced code block while Robot is polling the Brain.
~~~

## 9. Canonical MCME example

~~~text
<<<MAGASIN_LANE_DIRECTIVE_V1>>>
{"action":"WORK","task_id":"MCME-011","instruction":"BẮT ĐẦU THỰC HIỆN MCME-011 trên repository magasincoffee/MAGASIN-CONTENT-MONEY-ENGINE. Đây là task DUY NHẤT được phép active. Pinterest property: https://www.pinterest.com/bachvantoi1994/ . Thu sanitized evidence theo task contract. Không lưu password, OTP/MFA, cookie, token, tax ID, identity document, bank/card data hoặc secret. safe_reference=PUBLIC_OR_SANITIZED_REFERENCE_IF_ANY. DỪNG sau MCME-011 và trả exact commit SHA cùng evidence."}
<<<END_MAGASIN_LANE_DIRECTIVE_V1>>>
~~~

## 10. Invalid MCME example

Do not emit:

~~~text
<<\<MAGASIN_LANE_DIRECTIVE_V1>>>
{"action":"WORK","task_id":"MCME-011","instruction":"Pinterest: [https://example.com](https://example.com/) ; safe_reference=\<public ref>"}
<<\<END_MAGASIN_LANE_DIRECTIVE_V1>>>
~~~

Why it fails:

- start/end markers are not exact because they contain `\`;
- `\<` is not a valid JSON escape;
- Markdown link rendering can change the text observed by the Robot.

## 11. Parser authority

Current Supervisor parser authority is:

`src/runtime/three-lane.mjs::parseLaneDirective()`

The parser intentionally fails closed when the exact block is absent, JSON is invalid, action is unsupported, task ID is invalid, or the WORK instruction is empty.

Brain projects must conform to the protocol. They must not depend on the Robot guessing or rewriting malformed directives.

## 12. Optional Brain planning/result-verdict extension

TASK-RBT-008 keeps the protocol name and byte-exact markers unchanged. The legacy payloads remain valid exactly as written:

`{"action":"WORK","task_id":"TASK-ID","instruction":"..."}`

`{"action":"IDLE"}`

For current Supervisor automation, `IDLE` may also include an optional `idle_reason`:

- `PROJECT_COMPLETE` — valid only when every task in the current project plan is complete;
- `DEPENDENCY_BLOCKED` — temporary blocker outside the unfinished project tasks that Brain can dispatch;
- `NO_SAFE_WORK` — temporary safety/external boundary;
- `OWNER_REQUIRED` — explicit human input or authority is required.

If the blocker is itself an unfinished task in `project_plan`, Brain must dispatch that dependency task instead of returning `IDLE`. `DEPENDENCY_BLOCKED` and `NO_SAFE_WORK` are soft blockers: Robot automatically rechecks Brain with bounded backoff (1m, 2m, 4m, 8m, then max 10m), so Owner does not need to prompt Brain again. Only `OWNER_REQUIRED` is an intentional human wait state.

Optional `project_plan` is the project Source of Truth snapshot. It is backward-compatible at parser level, but the current first/resume Brain handshake requires it so the Robot can initialize project progress without rereading GitHub. Shape:

```json
{
  "project_plan": {
    "tasks": [
      { "task_id": "TASK-1", "title": "Foundation" },
      { "task_id": "TASK-2", "title": "Runtime" }
    ],
    "completed_task_ids": ["TASK-1"]
  }
}
```

Rules:
- `tasks` is the full currently-known project task list, in planning order, maximum 200 entries;
- every task ID is stable and unique and follows the normal `task_id` format;
- `completed_task_ids` is only for bootstrapping work already completed before this progress model was present;
- after bootstrap, the Robot marks a planned task `ACTIVE` only after dispatch confirmation;
- the Robot marks a planned task `DONE` only when Brain returns a correlated `previous_result.verdict=ACCEPT`;
- REJECT never increments completed count;
- resend the full `project_plan` only when the roadmap/task list changes.

A Brain that has just received a Robot result relay may add one optional `previous_result` object:

```json
{
  "action": "WORK",
  "task_id": "TASK-NEXT",
  "instruction": "One bounded outcome with dependency, DoD, evidence and stop boundary.",
  "previous_result": {
    "task_id": "TASK-PREV",
    "relay_id": "0123456789abcdef0123456789abcdef",
    "verdict": "ACCEPT",
    "reason_code": "ACCEPT_DOD_MET"
  }
}
```

Allowed verdicts are only `ACCEPT` and `REJECT`. `relay_id` must be the deterministic relay ID supplied by the Robot for that exact result. Runtime correlation is against durable lane truth; a mismatched task or relay fails closed.

For a REJECT correction that uses a different correction task ID, add:

```json
"correction_of": {
  "task_id": "TASK-PREV",
  "relay_id": "0123456789abcdef0123456789abcdef"
}
```

A REJECT may also reuse the same `task_id` without `correction_of`. REJECT must not jump to an unrelated roadmap task. If correction cannot proceed without Owner intervention, REJECT + IDLE is the bounded stop path.

Optional `reason_code` is metadata only and is restricted to the runtime allowlist. Free-form review prose, private reasoning and message content do not belong in verdict metadata.

The parser is deliberately narrow. Unknown top-level directive fields and unknown fields inside known optional metadata are rejected rather than becoming covert control surfaces.

Transport confirmation and semantic acceptance are different facts:

- `RESULT_RELAY_CONFIRMED` means the result reached the exact Brain conversation.
- `previous_result.verdict=ACCEPT` means Brain accepted that result against its DoD/evidence.
- A relay is never automatically converted into ACCEPT.

The Brain planning contract is:

`PLAN → DISPATCH → VERIFY → ACCEPT/REJECT → NEXT PLAN`

For decomposable work, Brain targets roughly <=20 minutes of active implementation per task and splits work expected to exceed 30 minutes when it can be split safely. These are planning targets only; they do not modify the RBT-005 inactivity watchdog or create a runtime task timeout.

## 13. Owner usage

To configure another Brain project, tell that Brain:

> Read and permanently follow the canonical MAGASIN Supervisor directive protocol in `01_DOCS/MAGASIN/00_MAGASIN_LANE_DIRECTIVE_V1_PROTOCOL.md`. When the Robot polls you, output only a valid directive according to that file.

The protocol defines serialization only. Project-specific planning, dependency checks, DoD, safety rules, and Work instructions remain the responsibility of each project's Brain architecture.
