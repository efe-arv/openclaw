/** Canonical projection from skill workshop config to system-owned cron jobs. */
import { listAgentIds, tryResolveAmbientOwnerAgentId } from "../agents/agent-scope.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveHeartbeatSchedulerSeed } from "../infra/heartbeat-runner.js";
import { resolveHeartbeatPhaseMs } from "../infra/heartbeat-schedule.js";
import { resolveSkillWorkshopConfig } from "../skills/workshop/config.js";
import { SKILL_COLLECTION_REVIEW_DECLARATION_PREFIX } from "./system-owned-declaration.js";
import type { CronJob, CronJobCreate } from "./types.js";

const SKILL_COLLECTION_REVIEW_EVERY_MS = 7 * 24 * 60 * 60_000;

export function skillCollectionReviewMonitorAgentId(job: CronJob): string | undefined {
  const key = job.declarationKey;
  if (!key?.startsWith(SKILL_COLLECTION_REVIEW_DECLARATION_PREFIX)) {
    return undefined;
  }
  return key.slice(SKILL_COLLECTION_REVIEW_DECLARATION_PREFIX.length) || undefined;
}

/**
 * One job, because the Workshop owns one global skill collection; a second job would only
 * contend for the same review lease. The owner is a scheduler identity, not a workspace: the
 * review uses the ambient system agent, while the execution boundary redirects the turn to
 * the global Workshop directory.
 */
export function resolveSkillCollectionReviewMonitorSpecs(
  cfg: OpenClawConfig,
  options: { schedulerSeed?: string } = {},
): Array<{ agentId: string; input: CronJobCreate }> {
  const agentId = tryResolveAmbientOwnerAgentId(cfg) ?? listAgentIds(cfg)[0];
  if (!agentId) {
    return [];
  }
  const schedulerSeed = resolveHeartbeatSchedulerSeed(options.schedulerSeed);
  return [
    {
      agentId,
      input: {
        declarationKey: `${SKILL_COLLECTION_REVIEW_DECLARATION_PREFIX}${agentId}`,
        name: `skill-collection-review-${agentId}`,
        displayName: `Skill collection review (${agentId})`,
        agentId,
        enabled: resolveSkillWorkshopConfig(cfg).autonomous.mode === "auto",
        schedule: {
          kind: "every",
          everyMs: SKILL_COLLECTION_REVIEW_EVERY_MS,
          anchorMs: resolveHeartbeatPhaseMs({
            schedulerSeed,
            agentId,
            intervalMs: SKILL_COLLECTION_REVIEW_EVERY_MS,
          }),
        },
        payload: {
          kind: "agentTurn",
          message:
            "Review the global Skill Workshop collection. Work only inside the Workshop directory provided for this turn.",
        },
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
      },
    },
  ];
}
