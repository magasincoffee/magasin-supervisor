import process from "node:process";

const ACTIVE = new Set(["queued","pending","requested","waiting","in_progress"]);

function clean(value) {
  return String(value || "").trim();
}

function sameSha(a,b) {
  const x = clean(a).toLowerCase();
  const y = clean(b).toLowerCase();
  return Boolean(x && y && x === y);
}

export function trackedGitHubRunDescriptor(externalWork = {}) {
  const repo = clean(externalWork.repo);
  const runId = clean(externalWork.workflow_run_id);
  const status = clean(externalWork.workflow_status).toLowerCase();
  const authority = clean(externalWork.run_authority || "AUTHORITATIVE").toUpperCase();
  const authoritativeSha = clean(externalWork.authoritative_sha || externalWork.commit_sha);

  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) return null;
  if (!/^\d+$/.test(runId)) return null;
  if (!ACTIVE.has(status) && status !== "completed") return null;
  if (authority === "OBSOLETE") return null;

  return {
    repo,
    run_id: runId,
    tracked_status: status,
    authoritative_sha: authoritativeSha || null
  };
}

export async function inspectTrackedGitHubRun({
  externalWork,
  fetchImpl = globalThis.fetch,
  timeoutMs = 5_000,
  token = process.env.MAGASIN_GITHUB_TOKEN || process.env.GITHUB_TOKEN || ""
} = {}) {
  const descriptor = trackedGitHubRunDescriptor(externalWork);
  if (!descriptor || typeof fetchImpl !== "function") {
    return { supported: false, reason: "NO_TRACKED_GITHUB_RUN" };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(250, Number(timeoutMs) || 5_000));
  try {
    const headers = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28"
    };
    if (clean(token)) headers.Authorization = `Bearer ${clean(token)}`;

    const response = await fetchImpl(
      `https://api.github.com/repos/${descriptor.repo}/actions/runs/${descriptor.run_id}`,
      { headers, signal: controller.signal }
    );
    if (!response?.ok) {
      return {
        supported: false,
        reason: `HTTP_${Number(response?.status || 0)}`
      };
    }

    const body = await response.json();
    const status = clean(body?.status).toLowerCase();
    const conclusion = clean(body?.conclusion).toLowerCase() || null;
    const headSha = clean(body?.head_sha);
    const authoritative = descriptor.authoritative_sha;

    if (authoritative && headSha && !sameSha(authoritative, headSha)) {
      return {
        supported: true,
        authority: "OBSOLETE",
        terminal: true,
        status,
        conclusion,
        head_sha: headSha,
        updated_at: clean(body?.updated_at) || null
      };
    }

    if (status === "completed" && authoritative && headSha && sameSha(authoritative, headSha)) {
      const runSetResponse = await fetchImpl(
        `https://api.github.com/repos/${descriptor.repo}/actions/runs?head_sha=${encodeURIComponent(headSha)}&per_page=100`,
        { headers, signal: controller.signal }
      );

      if (runSetResponse?.ok) {
        const runSetBody = await runSetResponse.json();
        const sameShaRuns = Array.isArray(runSetBody?.workflow_runs)
          ? runSetBody.workflow_runs.filter((run) => sameSha(headSha, run?.head_sha))
          : null;

        if (sameShaRuns) {
          const activeRuns = sameShaRuns.filter((run) =>
            ACTIVE.has(clean(run?.status).toLowerCase())
          );
          const completedRuns = sameShaRuns.filter((run) =>
            clean(run?.status).toLowerCase() === "completed"
          );
          const failedRuns = completedRuns.filter((run) => {
            const value = clean(run?.conclusion).toLowerCase();
            return Boolean(value && value !== "success" && value !== "skipped" && value !== "neutral");
          });

          if (activeRuns.length > 0) {
            return {
              supported: true,
              authority: "AUTHORITATIVE",
              terminal: false,
              active: true,
              status: "aggregate_in_progress",
              conclusion: null,
              head_sha: headSha,
              updated_at: clean(body?.updated_at) || null,
              tracked_run_terminal: true,
              run_set_supported: true,
              run_set_count: sameShaRuns.length,
              run_set_active_count: activeRuns.length,
              run_set_completed_count: completedRuns.length,
              run_set_failure_count: failedRuns.length
            };
          }

          return {
            supported: true,
            authority: "AUTHORITATIVE",
            terminal: true,
            active: false,
            status,
            conclusion,
            head_sha: headSha,
            updated_at: clean(body?.updated_at) || null,
            tracked_run_terminal: true,
            run_set_supported: true,
            run_set_count: sameShaRuns.length,
            run_set_active_count: 0,
            run_set_completed_count: completedRuns.length,
            run_set_failure_count: failedRuns.length
          };
        }
      }
    }

    return {
      supported: true,
      authority: "AUTHORITATIVE",
      terminal: status === "completed",
      active: ACTIVE.has(status),
      status,
      conclusion,
      head_sha: headSha || authoritative || null,
      updated_at: clean(body?.updated_at) || null,
      run_set_supported: false
    };
  } catch (error) {
    return {
      supported: false,
      reason: error?.name === "AbortError" ? "TIMEOUT" : "FETCH_ERROR"
    };
  } finally {
    clearTimeout(timer);
  }
}

export function nextLocalMonitorSeconds(attempt = 1) {
  const steps = [20, 30, 30, 30];
  const index = Math.min(Math.max(1, Number(attempt) || 1) - 1, steps.length - 1);
  return steps[index];
}