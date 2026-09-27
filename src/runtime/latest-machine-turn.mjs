import { captureLatestRoleTurn } from "../ui/latest-turn.mjs";
import { parseMachineFrame } from "./machine-frame.mjs";

export async function captureNewestMachineFrame(
  page,
  role,
  { lastSeenTurnId = null, captureTurn = captureLatestRoleTurn } = {}
) {
  const turn = await captureTurn(page, role);
  if (!turn) return null;

  const turnId = String(turn.turn_id || "").trim();
  if (turnId && lastSeenTurnId && turnId === String(lastSeenTurnId)) {
    return null;
  }

  const parsed = parseMachineFrame(turn.text);
  return {
    turn,
    frame: parsed.frame,
    body: parsed.body,
    raw: parsed.raw
  };
}
