import test from "node:test";
import assert from "node:assert/strict";

import {
  MACHINE_FRAME_ACTIONS,
  MACHINE_FRAME_PREFIX,
  MACHINE_FRAME_VERSION,
  assertMachineFrameAction,
  assertMachineFrameCorrelation,
  machineFrameLine,
  parseMachineFrame
} from "../src/runtime/machine-frame.mjs";
import { captureNewestMachineFrame } from "../src/runtime/latest-machine-turn.mjs";

test("PE-002 canonical @M parser consumes only the final non-empty line", () => {
  const parsed = parseMachineFrame([
    "Task body with an earlier example:",
    '@M {"v":1,"a":"assign","t":"OLD","i":"OLD-A"}',
    "Use the real assignment below.",
    '@M {"v":1,"a":"assign","t":"UI2-020","i":"A020"}',
    ""
  ].join("\n"));

  assert.equal(parsed.body, [
    "Task body with an earlier example:",
    '@M {"v":1,"a":"assign","t":"OLD","i":"OLD-A"}',
    "Use the real assignment below."
  ].join("\n"));
  assert.deepEqual(parsed.frame, {
    v: 1,
    a: "assign",
    t: "UI2-020",
    i: "A020"
  });

  assert.throws(
    () => parseMachineFrame([
      '@M {"v":1,"a":"assign","t":"UI2-020","i":"A020"}',
      "text after machine frame"
    ].join("\n")),
    /missing final @M frame/
  );
});

test("PE-002 machine protocol is strict on version/action/required fields but additive-safe", () => {
  const parsed = parseMachineFrame(
    '@M {"v":1,"a":"report","t":"T1","i":"A1","r":"R1","s":"PASS","future":{"x":1}}'
  );
  assert.deepEqual(parsed.frame, {
    v: 1,
    a: "report",
    t: "T1",
    i: "A1",
    r: "R1",
    s: "pass"
  });

  assert.throws(
    () => parseMachineFrame('@M {"v":"1","a":"assign","t":"T1","i":"A1"}'),
    /unsupported @M protocol version/
  );
  assert.throws(
    () => parseMachineFrame('@M {"v":1,"a":"unknown"}'),
    /unsupported @M action/
  );
  assert.throws(
    () => parseMachineFrame('@M {"v":1,"a":"report","t":"T1","i":"A1","r":"R1"}'),
    /report requires/
  );
  assert.throws(
    () => parseMachineFrame('@M []'),
    /JSON object/
  );
});

test("PE-002 correlation guard fails closed on task, assignment or result mismatch", () => {
  const frame = parseMachineFrame(
    '@M {"v":1,"a":"report","t":"T1","i":"A1","r":"R1","s":"pass"}'
  ).frame;

  assert.doesNotThrow(() => assertMachineFrameCorrelation(frame, {
    taskId: "T1",
    assignmentId: "A1",
    resultId: "R1"
  }));

  assert.throws(
    () => assertMachineFrameCorrelation(frame, { taskId: "T2" }),
    /task_id correlation mismatch/
  );
  assert.throws(
    () => assertMachineFrameCorrelation(frame, { assignmentId: "A2" }),
    /assignment_id correlation mismatch/
  );
  assert.throws(
    () => assertMachineFrameCorrelation(frame, { resultId: "R2" }),
    /result_id correlation mismatch/
  );
});

test("PE-002 action guard and serializer keep compact canonical envelope", () => {
  const frame = { v: MACHINE_FRAME_VERSION, a: "assign", t: "T1", i: "A1" };
  assert.equal(MACHINE_FRAME_PREFIX, "@M ");
  assert.ok(MACHINE_FRAME_ACTIONS.includes("accept_assign"));
  assert.equal(
    machineFrameLine(frame),
    '@M {"v":1,"a":"assign","t":"T1","i":"A1"}'
  );
  assert.equal(assertMachineFrameAction(frame, ["assign"]), frame);
  assert.throws(
    () => assertMachineFrameAction(frame, ["report"]),
    /unexpected @M action/
  );
});

test("PE-002 newest-turn parser ignores the persisted turn id and parses only a new turn", async () => {
  let calls = 0;
  const captureTurn = async (_page, role) => {
    calls += 1;
    assert.equal(role, "assistant");
    return {
      turn_id: "assistant:abc",
      digest: "abc",
      text: [
        "Do exactly one bounded task.",
        '@M {"v":1,"a":"assign","t":"T1","i":"A1"}'
      ].join("\n")
    };
  };

  const seen = await captureNewestMachineFrame(
    {},
    "assistant",
    {
      lastSeenTurnId: "assistant:abc",
      captureTurn
    }
  );
  assert.equal(seen, null);
  assert.equal(calls, 1);

  const fresh = await captureNewestMachineFrame(
    {},
    "assistant",
    {
      lastSeenTurnId: "assistant:older",
      captureTurn
    }
  );
  assert.equal(fresh.turn.turn_id, "assistant:abc");
  assert.equal(fresh.frame.a, "assign");
  assert.equal(fresh.frame.t, "T1");
  assert.equal(fresh.body, "Do exactly one bounded task.");
  assert.equal(calls, 2);
});

test("PE-002 newest-turn parser fails closed on malformed new machine output", async () => {
  await assert.rejects(
    captureNewestMachineFrame(
      {},
      "assistant",
      {
        lastSeenTurnId: "assistant:old",
        captureTurn: async () => ({
          turn_id: "assistant:new",
          digest: "new",
          text: "No machine frame"
        })
      }
    ),
    /missing final @M frame/
  );
});


test("project-aware @M metadata validates project generation and progress counts", () => {
  const parsed = parseMachineFrame(
    '@M {"v":1,"a":"assign","p":"UI2","g":4,"t":"UI2-018","i":"A18","pc":17,"pt":24}'
  );
  assert.deepEqual(parsed.frame, {
    v: 1,
    a: "assign",
    t: "UI2-018",
    i: "A18",
    p: "UI2",
    g: 4,
    pc: 17,
    pt: 24
  });

  assert.throws(
    () => parseMachineFrame('@M {"v":1,"a":"assign","t":"T1","i":"A1","pc":1}'),
    /both pc and pt/
  );
  assert.throws(
    () => parseMachineFrame('@M {"v":1,"a":"assign","t":"T1","i":"A1","pc":3,"pt":2}'),
    /cannot exceed/
  );
  assert.throws(
    () => parseMachineFrame('@M {"v":1,"a":"assign","t":"T1","i":"A1","g":0}'),
    /project_generation/
  );
});
