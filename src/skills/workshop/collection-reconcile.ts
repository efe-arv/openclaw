import path from "node:path";
import { pathExists } from "../../infra/fs-safe.js";
import { bumpSkillsSnapshotVersion } from "../runtime/refresh-state.js";
import { latestCommittedBackupId, readCollectionBackupManifest } from "./collection-backup.js";
import type { SkillCollectionRestoreResult } from "./collection-contracts.js";
import { resolveSkillCollectionBackupRoot } from "./collection-paths.js";
import { withSkillCollectionReviewClaim } from "./collection-review-state.js";
import { restoreSkillCollectionBackupTransaction } from "./collection-rollback.js";
import { readSkillProposalTargetTreeSha256 } from "./proposal-bundle.js";
import { resolveWorkshopSkillsDir } from "./skills-root.js";
import { listWritableWorkshopSkillSummaries } from "./workspace-skill-read.js";

export async function restoreLatestSkillCollectionBackup(params: {
  workspaceDir: string;
  env?: NodeJS.ProcessEnv;
}): Promise<SkillCollectionRestoreResult> {
  return await withSkillCollectionReviewClaim(
    async (lease) => {
      const skillsRoot = resolveWorkshopSkillsDir(params.env);
      const backupRoot = resolveSkillCollectionBackupRoot(params.env);
      const backupId = await latestCommittedBackupId(backupRoot);
      if (!backupId) {
        throw new Error("No skill collection backup is available.");
      }
      const backupDir = path.join(backupRoot, backupId);
      const manifest = await readCollectionBackupManifest({ backupDir, backupId, skillsRoot });
      lease.assertOwned();
      for (const relativeDir of manifest.resultSkillDirs) {
        const currentHash = await readSkillProposalTargetTreeSha256(
          path.join(skillsRoot, relativeDir),
        );
        if (currentHash !== manifest.resultSkillHashes[relativeDir]) {
          throw new Error(`Skill collection changed after cleanup: ${relativeDir}`);
        }
      }
      for (const relativeDir of manifest.skillDirs) {
        if (
          !manifest.resultSkillDirs.includes(relativeDir) &&
          (await pathExists(path.join(skillsRoot, relativeDir)))
        ) {
          throw new Error(`Skill collection changed after cleanup: ${relativeDir}`);
        }
      }
      lease.assertOwned();
      const currentSkills = listWritableWorkshopSkillSummaries({ env: params.env });
      lease.assertOwned();
      await restoreSkillCollectionBackupTransaction({ skillsRoot, backupDir });
      lease.assertOwned();
      bumpSkillsSnapshotVersion({ reason: "workshop" });
      lease.assertOwned();
      const restoredSkills = listWritableWorkshopSkillSummaries({ env: params.env });
      return {
        backupId,
        restored: restoredSkills
          .filter((skill) => manifest.skillDirs.includes(path.relative(skillsRoot, skill.baseDir)))
          .map((skill) => skill.name),
        removed: currentSkills
          .filter(
            (skill) =>
              manifest.resultSkillDirs.includes(path.relative(skillsRoot, skill.baseDir)) &&
              !manifest.skillDirs.includes(path.relative(skillsRoot, skill.baseDir)),
          )
          .map((skill) => skill.name),
      };
    },
    params.env ? { env: params.env } : {},
  );
}
