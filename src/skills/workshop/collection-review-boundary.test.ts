import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { CronStoredJob } from "../../cron/types.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createTrackedTempDirs } from "../../test-utils/tracked-temp-dirs.js";
import { getSkillsSnapshotVersion } from "../runtime/refresh-state.js";
import { restoreLatestSkillCollectionBackup } from "./collection-reconcile.js";
import { runSkillCollectionReviewForAgent } from "./collection-review-boundary.js";
import { listSkillCollectionReviewOutcomes } from "./collection-review-state.js";
import { resolveWorkshopSkillsDir } from "./skills-root.js";

const tempDirs = createTrackedTempDirs();

describe("skill collection review boundary", () => {
  it("snapshots, scans, records tree changes, and restores the pre-turn tree", async () => {
    const testState = await createOpenClawTestState({
      layout: "state-only",
      prefix: "openclaw-skill-collection-review-boundary-",
    });
    const workspaceDir = await tempDirs.make("openclaw-skill-collection-review-workspace-");
    const skillsRoot = resolveWorkshopSkillsDir(testState.env);
    const config = {
      skills: { workshop: { autonomous: { mode: "auto" } } },
    };
    const job = {
      id: "skill-review",
      declarationKey: "skill-collection-review:main",
      name: "skill review",
      enabled: true,
      createdAtMs: 1,
      updatedAtMs: 1,
      agentId: "main",
      schedule: { kind: "every", everyMs: 604_800_000 },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: {
        kind: "agentTurn",
        message: "review",
        toolsAllow: ["read", "write", "edit", "apply_patch", "exec", "process"],
      },
      state: {},
    } satisfies CronStoredJob;

    try {
      await writeSkill(skillsRoot, "keep", "Keep procedure", "# Keep\n");
      await writeSkill(skillsRoot, "rewrite", "Rewrite procedure", "# Before\n");
      await writeSkill(skillsRoot, "drop", "Stale fragment", "# Drop\n");
      await writeSkill(skillsRoot, "silent-drop", "Unclear fragment", "# Silent\n");
      await writeSkill(skillsRoot, "unsafe", "Unsafe procedure", "# Unsafe\n");
      const beforeVersion = getSkillsSnapshotVersion();

      const result = await runSkillCollectionReviewForAgent({
        config,
        agentId: "main",
        job,
        env: testState.env,
        runTurn: async ({ job: reviewJob, message, executionRoot }) => {
          expect(reviewJob.payload.kind).toBe("agentTurn");
          expect(reviewJob.payload).toEqual({
            kind: "agentTurn",
            message,
            toolsAllow: ["read", "write", "edit", "apply_patch", "exec", "process"],
          });
          expect(message).toContain(`Workshop directory: ${skillsRoot}`);
          expect(message).toContain("Total skills: 5");
          expect(message).toContain("List the Workshop directory for the full inventory");
          expect(message).toContain("Recorded usage (name useCount lastUsedDaysAgo):");
          expect(message).not.toContain("Current Workshop skills");
          expect(message).not.toContain("description");
          expect(executionRoot).toEqual({
            workspaceDir: skillsRoot,
            cwd: skillsRoot,
            sessionRoot: skillsRoot,
          });
          await fs.writeFile(
            path.join(skillsRoot, "rewrite", "SKILL.md"),
            "---\nname: rewrite\ndescription: Rewritten procedure\n---\n\n# After\n",
          );
          await fs.rm(path.join(skillsRoot, "drop"), { recursive: true });
          await fs.rm(path.join(skillsRoot, "silent-drop"), { recursive: true });
          await fs.mkdir(path.join(skillsRoot, "added"), { recursive: true });
          await fs.writeFile(
            path.join(skillsRoot, "added", "SKILL.md"),
            "---\nname: added\ndescription: Added procedure\n---\n\n# Added\n",
          );
          await fs.writeFile(
            path.join(skillsRoot, "unsafe", "SKILL.md"),
            '---\nname: unsafe\ndescription: Unsafe procedure\n---\n\n```js\nconst cp = require("child_process");\ncp.exec("bad");\n```\n',
          );
          return {
            status: "ok",
            summary: "reviewed",
            outputText: "DROP drop: stale fragment",
          };
        },
      });

      expect(result.status).toBe("error");
      expect(result.error).toBe(
        "Skill collection review completed with errors: security scan rejected unsafe",
      );
      expect(getSkillsSnapshotVersion()).toBeGreaterThan(beforeVersion);
      expect(listSkillCollectionReviewOutcomes({ env: testState.env })[0]).toMatchObject({
        kept: ["keep", "unsafe"],
        written: ["added", "rewrite"],
        dropped: [
          { name: "drop", reason: "stale fragment" },
          { name: "silent-drop", reason: "no reason given" },
        ],
      });
      await expect(
        fs.readFile(path.join(skillsRoot, "unsafe", "SKILL.md"), "utf8"),
      ).resolves.toContain("# Unsafe");

      const restored = await restoreLatestSkillCollectionBackup({
        workspaceDir,
        env: testState.env,
      });
      expect(restored.restored).toContain("drop");
      await expect(fs.access(path.join(skillsRoot, "added"))).rejects.toThrow();
      await expect(
        fs.readFile(path.join(skillsRoot, "rewrite", "SKILL.md"), "utf8"),
      ).resolves.toContain("# Before");
      await expect(
        fs.readFile(path.join(skillsRoot, "drop", "SKILL.md"), "utf8"),
      ).resolves.toContain("# Drop");
    } finally {
      await testState.cleanup();
      await tempDirs.cleanup();
    }
  });
});

async function writeSkill(
  skillsRoot: string,
  name: string,
  description: string,
  body: string,
): Promise<void> {
  const skillDir = path.join(skillsRoot, name);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(
    path.join(skillDir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}`,
  );
}
