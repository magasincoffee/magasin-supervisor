import { decideContinuation } from "../decision.mjs";
import { executeDecision } from "../ui/actions.mjs";

export async function runSupervisorStep({
  session,
  projectState,
  retryCount = 0,
  maxRetries = 2,
  dryRun = true
}) {
  if (!session) throw new TypeError("session is required");

  const probe = await session.probe();
  const decision = decideContinuation({
    projectState,
    observation: probe.classification.observation,
    retryCount,
    maxRetries
  });

  const page = session.adapter?.getActivePage?.();
  if (!page) {
    return {
      probe,
      decision,
      execution: {
        executed: false,
        dryRun,
        action: decision.action,
        reason: "no active ChatGPT page"
      }
    };
  }

  const execution = await executeDecision({
    page,
    decision,
    dryRun
  });

  return { probe, decision, execution };
}
