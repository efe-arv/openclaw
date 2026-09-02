import fs from "node:fs/promises";
import path from "node:path";
import { removePathWithinRoot } from "../../infra/fs-safe-remove.js";
import { pathExists } from "../../infra/fs-safe.js";
import { logWarn } from "../../logger.js";

export async function restoreSkillCollectionBackupTransaction(params: {
  skillsRoot: string;
  backupDir: string;
}): Promise<void> {
  const rollbackDir = path.join(params.backupDir, `.restore-${Date.now()}`);
  await fs.mkdir(rollbackDir, { recursive: true });
  try {
    if (await pathExists(params.skillsRoot)) {
      await fs.cp(params.skillsRoot, path.join(rollbackDir, "skills"), {
        recursive: true,
        errorOnExist: true,
        force: false,
        preserveTimestamps: true,
      });
    }
    await replaceSkillCollectionTree(params.skillsRoot, path.join(params.backupDir, "skills"));
  } catch (error) {
    try {
      await replaceSkillCollectionTree(params.skillsRoot, path.join(rollbackDir, "skills"));
    } catch (rollbackError) {
      const failure = new Error(
        "Skill collection restore failed and the current collection was not restored.",
        { cause: error },
      );
      Object.assign(failure, { rollbackError });
      throw failure;
    }
    throw error;
  } finally {
    await removePathWithinRoot({
      rootDir: params.backupDir,
      relativePath: path.basename(rollbackDir),
      recursive: true,
      force: true,
    }).catch((error: unknown) => {
      logWarn(`skill-workshop: failed to discard restore snapshot: ${String(error)}`);
    });
  }
}

export async function restoreSkillCollectionDirectoryFromBackup(params: {
  skillsRoot: string;
  backupDir: string;
  relativeDir: string;
  existedBefore: boolean;
}): Promise<void> {
  const liveDir = path.join(params.skillsRoot, params.relativeDir);
  if (await pathExists(liveDir)) {
    await removePathWithinRoot({
      rootDir: params.skillsRoot,
      relativePath: params.relativeDir,
      recursive: true,
      force: true,
    });
  }
  if (params.existedBefore) {
    await fs.mkdir(path.dirname(liveDir), { recursive: true });
    await fs.cp(path.join(params.backupDir, "skills", params.relativeDir), liveDir, {
      recursive: true,
      errorOnExist: true,
      force: false,
      preserveTimestamps: true,
    });
  }
}

async function replaceSkillCollectionTree(skillsRoot: string, snapshotRoot: string): Promise<void> {
  await fs.mkdir(skillsRoot, { recursive: true });
  for (const entry of await fs.readdir(skillsRoot)) {
    await removePathWithinRoot({
      rootDir: skillsRoot,
      relativePath: entry,
      recursive: true,
      force: true,
    });
  }
  if (await pathExists(snapshotRoot)) {
    await fs.cp(snapshotRoot, skillsRoot, {
      recursive: true,
      errorOnExist: false,
      force: true,
      preserveTimestamps: true,
    });
  }
}
