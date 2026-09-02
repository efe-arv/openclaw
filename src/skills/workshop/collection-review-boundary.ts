import fs from "node:fs/promises";
import path from "node:path";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { canonicalizePath } from "../../agents/utils/paths.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { RunCronAgentTurnParams } from "../../cron/isolated-agent/run-prepare-runtime.js";
import type { RunCronAgentTurnResult } from "../../cron/isolated-agent/run.types.js";
import { bumpSkillsSnapshotVersion } from "../runtime/refresh-state.js";
import { scanSkillContent, scanSource } from "../security/scanner.js";
import {
  commitCollectionBackup,
  createCollectionBackup,
  discardPendingCollectionBackup,
} from "./collection-backup.js";
import { pruneOlderSkillCollectionBackups } from "./collection-paths.js";
import { buildCollectionReviewPrompt } from "./collection-review-prompt.js";
import {
  recordSkillCollectionReviewHistory,
  recordSkillCollectionReviewStatus,
  withSkillCollectionReviewClaim,
  type SkillCollectionReviewResult,
} from "./collection-review-state.js";
import { restoreSkillCollectionDirectoryFromBackup } from "./collection-rollback.js";
import { clearSkillUsageForRemovedSkills } from "./curator.js";
import { readSkillProposalTargetTreeSha256 } from "./proposal-bundle.js";
import { resolveWorkshopSkillsDir } from "./skills-root.js";
import { listWritableWorkshopSkillSummaries } from "./workspace-skill-read.js";

type ReviewTurn = (params: {
  job: RunCronAgentTurnParams["job"];
  message: string;
  abortSignal?: AbortSignal;
  executionRoot: NonNullable<RunCronAgentTurnParams["executionRoot"]>;
}) => Promise<RunCronAgentTurnResult>;

type ReviewSkill = ReturnType<typeof listWritableWorkshopSkillSummaries>[number];

export async function runSkillCollectionReviewForAgent(params: {
  config: OpenClawConfig;
  agentId: string;
  job: RunCronAgentTurnParams["job"];
  env?: NodeJS.ProcessEnv;
  abortSignal?: AbortSignal;
  runTurn: ReviewTurn;
}): Promise<RunCronAgentTurnResult> {
  if (params.config.skills?.workshop?.autonomous?.mode !== "auto") {
    return { status: "skipped", summary: "skill collection review disabled" };
  }
  const skillsRoot = resolveWorkshopSkillsDir(params.env);
  const stateOptions = params.env ? { env: params.env } : {};
  const assertCurrent = (lease: { assertOwned: () => void }) => {
    lease.assertOwned();
    params.abortSignal?.throwIfAborted();
  };
  try {
    return await withSkillCollectionReviewClaim(async (lease) => {
      const attemptedAtMs = Date.now();
      assertCurrent(lease);
      recordSkillCollectionReviewStatus({ attemptedAtMs }, stateOptions);
      assertCurrent(lease);
      await fs.mkdir(skillsRoot, { recursive: true });
      const before = await resolveReviewSkills(params.config, params.env);
      const backup = await createCollectionBackup({
        skillsRoot,
        skillDirs: before.map((skill) => path.relative(skillsRoot, skill.baseDir)),
        env: params.env,
      });
      try {
        assertCurrent(lease);
        const message = buildCollectionReviewPrompt(before, params.env);
        const turnResult = await params.runTurn({
          job: {
            ...params.job,
            payload: { kind: "agentTurn", message },
          },
          message,
          ...(params.abortSignal ? { abortSignal: params.abortSignal } : {}),
          // File tools are rooted at Workshop; host exec retains normal cron authority.
          // cwd is a working directory, not a shell filesystem jail.
          executionRoot: {
            workspaceDir: skillsRoot,
            cwd: skillsRoot,
            sessionRoot: skillsRoot,
          },
        });
        assertCurrent(lease);
        const reviewErrors: string[] = [];
        const dropReasons = parseDropReasons(turnResult.outputText);
        const after = await resolveReviewSkills(params.config, params.env);
        const beforeByName = new Map(before.map((skill) => [skill.name, skill]));
        const afterByName = new Map(after.map((skill) => [skill.name, skill]));
        const changed = [...afterByName.values()].filter((skill) => {
          const previous = beforeByName.get(skill.name);
          return !previous || previous.treeHash !== skill.treeHash;
        });
        for (const skill of changed) {
          assertCurrent(lease);
          const content = await fs.readFile(skill.filePath, "utf8");
          const findings = [
            ...scanSkillContent(content, skill.filePath),
            ...scanSource(content, skill.filePath),
          ];
          if (findings.some((finding) => finding.severity === "critical")) {
            const previous = beforeByName.get(skill.name);
            assertCurrent(lease);
            await restoreSkillCollectionDirectoryFromBackup({
              skillsRoot,
              backupDir: backup.backupDir,
              relativeDir: path.relative(skillsRoot, skill.baseDir),
              existedBefore: previous !== undefined,
            });
            reviewErrors.push(`security scan rejected ${skill.name}`);
          }
        }
        assertCurrent(lease);
        const finalSkills = await resolveReviewSkills(params.config, params.env);
        const finalByName = new Map(finalSkills.map((skill) => [skill.name, skill]));
        const result: SkillCollectionReviewResult = {
          backupId: backup.manifest.id,
          kept: before
            .filter((skill) => finalByName.get(skill.name)?.treeHash === skill.treeHash)
            .map((skill) => skill.name),
          written: finalSkills
            .filter((skill) => {
              const previous = beforeByName.get(skill.name);
              return !previous || previous.treeHash !== skill.treeHash;
            })
            .map((skill) => skill.name),
          dropped: before
            .filter((skill) => !finalByName.has(skill.name))
            .map((skill) => ({
              name: skill.name,
              reason: dropReasons.get(skill.name) ?? "no reason given",
            })),
        };
        assertCurrent(lease);
        await commitCollectionBackup(
          skillsRoot,
          backup,
          finalSkills.map((skill) => path.relative(skillsRoot, skill.baseDir)),
        );
        assertCurrent(lease);
        bumpSkillsSnapshotVersion({ reason: "workshop" });
        assertCurrent(lease);
        recordSkillCollectionReviewHistory(Date.now(), result, stateOptions);
        assertCurrent(lease);
        await pruneOlderSkillCollectionBackups(backup.backupRoot, backup.manifest.id);
        assertCurrent(lease);
        clearSkillUsageForRemovedSkills(
          before
            .filter((skill) => !finalByName.has(skill.name))
            .map((skill) => canonicalizePath(skill.filePath)),
          stateOptions,
        );
        assertCurrent(lease);
        if (reviewErrors.length > 0) {
          const error = `Skill collection review completed with errors: ${reviewErrors.join("; ")}`;
          recordSkillCollectionReviewStatus({ attemptedAtMs, error }, stateOptions);
          return { ...turnResult, status: "error", error, summary: error };
        }
        recordSkillCollectionReviewStatus(
          { attemptedAtMs, succeededAtMs: Date.now() },
          stateOptions,
        );
        return turnResult;
      } catch (error) {
        assertCurrent(lease);
        recordSkillCollectionReviewStatus({ attemptedAtMs, error }, stateOptions);
        await discardPendingCollectionBackup(backup);
        throw error;
      }
    }, stateOptions);
  } catch (error) {
    const summary = `Skill collection review failed: ${String(error)}`;
    return { status: "error", error: summary, summary };
  }
}

async function resolveReviewSkills(
  config: OpenClawConfig,
  env?: NodeJS.ProcessEnv,
): Promise<Array<ReviewSkill & { treeHash: string }>> {
  const skills = listWritableWorkshopSkillSummaries({ config: resolveReviewConfig(config), env });
  const hashes = await Promise.all(
    skills.map(async (skill) => await readSkillProposalTargetTreeSha256(skill.baseDir)),
  );
  const resolvedSkills: Array<ReviewSkill & { treeHash: string }> = [];
  for (const [index, skill] of skills.entries()) {
    const treeHash = hashes[index];
    if (treeHash === undefined) {
      throw new Error(`Could not hash Workshop skill: ${skill.name}`);
    }
    resolvedSkills.push({ ...skill, treeHash });
  }
  return resolvedSkills;
}

function resolveReviewConfig(config: OpenClawConfig): OpenClawConfig {
  return {
    ...config,
    skills: {
      ...config.skills,
      limits: {
        ...config.skills?.limits,
        maxCandidatesPerRoot: Number.MAX_SAFE_INTEGER,
        maxSkillsLoadedPerSource: Number.MAX_SAFE_INTEGER,
      },
    },
  };
}

function parseDropReasons(outputText: string | undefined): Map<string, string> {
  const reasons = new Map<string, string>();
  for (const line of outputText?.split(/\r?\n/u) ?? []) {
    const match = /^DROP\s+(\S+)\s*:\s*(.*)$/u.exec(line.trim());
    if (!match?.[1]) {
      continue;
    }
    reasons.set(match[1], truncateUtf16Safe(match[2]?.trim() ?? "", 300));
  }
  return reasons;
}
