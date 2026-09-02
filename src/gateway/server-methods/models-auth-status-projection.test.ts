import { describe, expect, it } from "vitest";
import type { AuthProviderHealth } from "../../agents/auth-health.js";
import type { AuthProfileStore, RuntimeAuthProfileStore } from "../../agents/auth-profiles.js";
import type { ProviderAuthAliasLookupParams } from "../../agents/provider-auth-aliases.js";
import type { OpenClawConfig } from "../../config/config.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import {
  projectModelAuthStatusProvider,
  resolveConfigBoundAuthBindings,
} from "./models-auth-status-projection.js";

const profileId = "openai:default";

function health(profileIds: string[] = [profileId], provider = "openai"): AuthProviderHealth {
  const profiles = profileIds.map((id) => ({
    profileId: id,
    provider,
    type: "oauth" as const,
    status: "ok" as const,
    expiresAt: 1_000_000,
    remainingMs: 60_000,
    source: "store" as const,
    label: id,
  }));
  return { provider, status: "ok", profiles };
}

function project(params: {
  store: AuthProfileStore;
  config?: OpenClawConfig;
  provider?: AuthProviderHealth;
  authAliasLookupParams?: ProviderAuthAliasLookupParams;
  includeProfileIdentity?: boolean;
}) {
  const config = params.config ?? {};
  return projectModelAuthStatusProvider({
    provider: params.provider ?? health(),
    config,
    store: params.store,
    authAliasLookupParams: params.authAliasLookupParams ?? { config },
    usageByProvider: new Map(),
    expectsOAuthProviders: new Set(),
    apiKeys: new Map(),
    logoutProfileIds: new Set(Object.keys(params.store.profiles)),
    configBoundProfileIds: new Set(),
    configBoundAuthProviders: new Set(),
    externalProfileIds: new Set(),
    externalCliProfileIds: new Set(),
    includeProfileIdentity: params.includeProfileIdentity ?? true,
  });
}

function credential(overrides: Record<string, unknown> = {}) {
  return {
    type: "oauth" as const,
    provider: "openai",
    access: "access",
    refresh: "refresh",
    expires: 1_000_000,
    ...overrides,
  };
}

describe("projectModelAuthStatusProvider", () => {
  it("projects profile identity, last use, and a local explicit order", () => {
    const store: RuntimeAuthProfileStore = {
      version: 1,
      profiles: {
        [profileId]: credential({
          email: "owner@example.com",
          displayName: "Work account",
        }),
      },
      order: { openai: [profileId] },
      usageStats: { [profileId]: { lastUsed: 42 } },
      runtimeLocalProfileIds: [profileId],
      runtimeLocalOrderProviders: ["openai"],
    };

    const provider = project({ store });

    expect(provider.profileOrder).toEqual([profileId]);
    expect(provider.profileOrderStored).toBe(true);
    expect(provider.profiles[0]).toMatchObject({
      source: "saved",
      displayName: "Work account",
      email: "owner@example.com",
      lastUsedAt: 42,
    });
  });

  it("does not mark an inherited profile order as resettable", () => {
    const store: RuntimeAuthProfileStore = {
      version: 1,
      profiles: { [profileId]: credential() },
      order: { openai: [profileId] },
      runtimeLocalProfileIds: [],
      runtimeLocalOrderProviders: [],
      runtimeInheritsMainState: true,
    };

    const provider = project({ store });

    expect(provider.profileOrder).toEqual([profileId]);
    expect(provider.profileOrderStored).toBeUndefined();
    expect(provider.profiles[0]?.source).toBe("inherited");
  });

  it("projects a stored order written under a provider auth alias", () => {
    const aliasedProfileId = "gmi:default";
    const metadataSnapshot = createPluginMetadataSnapshotFixture({
      plugins: [
        {
          id: "gmi",
          providerAuthAliases: { "gmi-cloud": "gmi" },
        },
      ],
    });
    const store: RuntimeAuthProfileStore = {
      version: 1,
      profiles: {
        [aliasedProfileId]: credential({ provider: "gmi" }),
      },
      order: { "gmi-cloud": [aliasedProfileId] },
      runtimeLocalProfileIds: [aliasedProfileId],
      runtimeLocalOrderProviders: ["gmi-cloud"],
    };

    const provider = project({
      store,
      provider: health([aliasedProfileId], "gmi"),
      authAliasLookupParams: { metadataSnapshot },
    });

    expect(provider.profileOrder).toEqual([aliasedProfileId]);
    expect(provider.profileOrderStored).toBe(true);
  });

  it("marks configured profile order as externally managed", () => {
    const backupId = "openai:backup";
    const store: AuthProfileStore = {
      version: 1,
      profiles: {
        [profileId]: credential(),
        [backupId]: credential({ access: "backup-access", refresh: "backup-refresh" }),
      },
    };

    const provider = project({
      store,
      config: { auth: { order: { openai: [profileId] } } },
      provider: health([profileId, backupId]),
    });

    expect(provider.profileOrder).toEqual([profileId]);
    expect(provider.profiles).toHaveLength(2);
    expect(provider.profileOrderStored).toBeUndefined();
    expect(provider.profileOrderLocked).toBe("auth-config");
  });

  it("omits profile identity when it is not requested", () => {
    const store: AuthProfileStore = {
      version: 1,
      profiles: {
        [profileId]: credential({
          email: "owner@example.com",
          displayName: "Work account",
        }),
      },
    };

    const provider = project({ store, includeProfileIdentity: false });

    expect(provider.profiles[0]).not.toHaveProperty("email");
    expect(provider.profiles[0]).not.toHaveProperty("displayName");
  });
});

describe("resolveConfigBoundAuthBindings", () => {
  it("attributes a split-provider profile binding to the requested provider", () => {
    const lockedProfileId = "credential-owner:locked";
    const config: OpenClawConfig = {
      models: {
        providers: {
          openai: { baseUrl: "https://example.test/v1", apiKey: lockedProfileId },
          "credential-owner": { baseUrl: "https://example.test/v1" },
        },
      },
    };
    const store: AuthProfileStore = {
      version: 1,
      profiles: {
        [lockedProfileId]: {
          type: "token",
          provider: "credential-owner",
          token: "token",
        },
      },
    };

    const bindings = resolveConfigBoundAuthBindings(config, store, { config });

    expect([...bindings.profileIds]).toEqual([lockedProfileId]);
    expect([...bindings.authProviders]).toEqual(["openai"]);
  });
});
