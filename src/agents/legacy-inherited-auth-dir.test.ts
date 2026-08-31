import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { writeConfigMachineState } from "../state/config-machine-state.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  resolveInheritedAuthProfileWriteAgentDir,
  resolveLegacyInheritedAuthAgentId,
} from "./legacy-inherited-auth-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

describe("legacy inherited auth ownership", () => {
  it("uses the raw legacy marker owner for direct config inputs", () => {
    const cfg: OpenClawConfig = {
      agents: { entries: { main: {}, ops: { default: true } } },
    };

    expect(resolveLegacyInheritedAuthAgentId(cfg)).toBe("ops");
  });

  it("routes only the configured inheritance owner to shared state", () => {
    const stateDir = tempDirs.make("openclaw-auth-write-owner-");
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir, OPENCLAW_AGENT_DIR: undefined };
    const cfg: OpenClawConfig = {
      agents: { defaults: { authInheritance: { agentId: "owner" } } },
    };
    writeConfigMachineState("auth.sharedStore", { location: "state-db" }, { env });

    expect(resolveInheritedAuthProfileWriteAgentDir(cfg, "owner", "/tmp/owner", env)).toBe(
      undefined,
    );
    expect(resolveInheritedAuthProfileWriteAgentDir(cfg, "worker", "/tmp/worker", env)).toBe(
      "/tmp/worker",
    );
  });
});
