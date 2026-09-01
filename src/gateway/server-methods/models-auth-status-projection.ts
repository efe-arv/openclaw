import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { AuthProviderHealth } from "../../agents/auth-health.js";
import {
  type AuthProfileStore,
  getRuntimeLocalOrderProviders,
  getRuntimeLocalProfileIds,
  resolveAuthProfileMetadata,
  resolveExplicitAuthOrderSelection,
} from "../../agents/auth-profiles.js";
import {
  isNonSecretApiKeyMarker,
  NON_ENV_SECRETREF_MARKER,
} from "../../agents/model-auth-markers.js";
import { resolveProviderEntryApiKeyProfileReference } from "../../agents/model-auth.js";
import {
  type ProviderAuthAliasLookupParams,
  resolveProviderIdForAuth,
} from "../../agents/provider-auth-aliases.js";
import type { OpenClawConfig } from "../../config/config.js";
import { hasConfiguredSecretInput } from "../../config/types.secrets.js";
import { providerUsageLabel, resolveUsageProviderId } from "../../infra/provider-usage.shared.js";
import {
  aggregateRefreshableAuthStatus,
  buildModelAuthExpiry,
} from "./models-auth-status-rollup.js";
import type { ProviderUsageStatus } from "./models-auth-status-usage-cache.js";
import type {
  ModelAuthStatusProfile,
  ModelAuthStatusProvider,
} from "./models-auth-status.types.js";

function providerDisplayName(provider: string): string {
  const usageId = resolveUsageProviderId(provider);
  return (usageId ? providerUsageLabel(usageId) : undefined) ?? provider;
}

export function projectModelAuthStatusProvider(params: {
  provider: AuthProviderHealth;
  config: OpenClawConfig;
  store: AuthProfileStore;
  authAliasLookupParams: ProviderAuthAliasLookupParams;
  usageByProvider: Map<string, ProviderUsageStatus>;
  expectsOAuthProviders: ReadonlySet<string>;
  apiKeys: ReadonlyMap<string, ModelAuthStatusProvider["apiKey"]>;
  logoutProfileIds: ReadonlySet<string>;
  configBoundProfileIds: ReadonlySet<string>;
  configBoundAuthProviders: ReadonlySet<string>;
  externalProfileIds: ReadonlySet<string>;
  externalCliProfileIds: ReadonlySet<string>;
  includeProfileIdentity: boolean;
}): ModelAuthStatusProvider {
  const {
    provider,
    config,
    store,
    authAliasLookupParams,
    usageByProvider,
    expectsOAuthProviders,
    apiKeys,
    logoutProfileIds,
    configBoundProfileIds,
    configBoundAuthProviders,
    externalProfileIds,
    externalCliProfileIds,
    includeProfileIdentity,
  } = params;
  const providerKey = normalizeProviderId(provider.provider);
  const authProviderKey = resolveProviderIdForAuth(provider.provider, authAliasLookupParams);
  const profileOrder = resolveExplicitAuthOrderSelection({
    storeOrder: store.order,
    configuredOrder: config.auth?.order,
    providerKey,
    providerAuthKey: authProviderKey,
  });
  const localOrderProviders = new Set(
    getRuntimeLocalOrderProviders(store).map((providerId) =>
      resolveProviderIdForAuth(providerId, authAliasLookupParams),
    ),
  );
  const localProfileIds = new Set(getRuntimeLocalProfileIds(store));
  const providerOrderLocked = configBoundAuthProviders.has(authProviderKey);
  const configuredOrderLocked = profileOrder.order !== undefined && !profileOrder.fromStore;
  const usageProfile =
    provider.profiles.find((profile) => profile.type === "oauth" || profile.type === "token") ??
    provider.profiles.find((profile) => profile.type === "api_key");
  const usageKey = resolveUsageProviderId(provider.provider, {
    credentialType: usageProfile?.type,
  });
  const usage = usageKey ? usageByProvider.get(usageKey) : undefined;
  const rawRollup = aggregateRefreshableAuthStatus(
    provider,
    Date.now(),
    expectsOAuthProviders.has(provider.provider),
  );
  const effectiveProfiles = provider.effectiveProfiles ?? provider.profiles;
  const refreshableProfiles = effectiveProfiles.filter(
    (profile) => profile.type === "oauth" || profile.type === "token",
  );
  // External CLI access tokens rotate without operator action. Keep their raw
  // profile expiry diagnostic, but do not turn it into a provider login warning.
  const externalCliOwnsOAuthRefresh =
    refreshableProfiles.length > 0 &&
    refreshableProfiles.every(
      (profile) => profile.type === "oauth" && externalCliProfileIds.has(profile.profileId),
    );
  const rollup =
    externalCliOwnsOAuthRefresh &&
    (rawRollup.status === "expired" || rawRollup.status === "expiring")
      ? { status: "ok" as const, expiresAt: undefined, remainingMs: undefined }
      : rawRollup;
  const apiKey = apiKeys.get(providerKey);
  const hasRefreshableProfile = provider.profiles.some(
    (profile) => profile.type === "oauth" || profile.type === "token",
  );
  return {
    provider: provider.provider,
    authProvider: authProviderKey,
    displayName: providerDisplayName(provider.provider),
    status:
      apiKey && !hasRefreshableProfile && rollup.status === "missing" ? "static" : rollup.status,
    expiry: buildModelAuthExpiry(rollup.remainingMs, rollup.expiresAt),
    profiles: provider.profiles.map((profileHealth) => {
      const metadata = resolveAuthProfileMetadata({
        cfg: config,
        store,
        profileId: profileHealth.profileId,
      });
      const lastUsedAt = store.usageStats?.[profileHealth.profileId]?.lastUsed;
      const profile: ModelAuthStatusProfile = {
        profileId: profileHealth.profileId,
        type: profileHealth.type,
        status: profileHealth.status,
        reasonCode: profileHealth.reasonCode,
        source: configBoundProfileIds.has(profileHealth.profileId)
          ? "config"
          : externalProfileIds.has(profileHealth.profileId)
            ? "external"
            : localProfileIds.has(profileHealth.profileId)
              ? "saved"
              : "inherited",
        expiry: buildModelAuthExpiry(profileHealth.remainingMs, profileHealth.expiresAt),
      };
      if (externalCliProfileIds.has(profileHealth.profileId)) {
        profile.externallyManaged = true;
      }
      if (includeProfileIdentity && metadata.displayName) {
        profile.displayName = metadata.displayName;
      }
      if (includeProfileIdentity && metadata.email) {
        profile.email = metadata.email;
      }
      if (lastUsedAt) {
        profile.lastUsedAt = lastUsedAt;
      }
      if (
        (profileHealth.type === "oauth" || profileHealth.type === "token") &&
        logoutProfileIds.has(profileHealth.profileId) &&
        !configBoundProfileIds.has(profileHealth.profileId)
      ) {
        profile.logoutSupported = true;
      }
      return profile;
    }),
    ...(profileOrder.order !== undefined ? { profileOrder: profileOrder.order } : {}),
    ...(profileOrder.fromStore && localOrderProviders.has(authProviderKey)
      ? { profileOrderStored: true }
      : {}),
    ...(providerOrderLocked
      ? { profileOrderLocked: "provider-config" as const }
      : configuredOrderLocked
        ? { profileOrderLocked: "auth-config" as const }
        : {}),
    ...(apiKey ? { apiKey } : {}),
    usage:
      usage && usageKey
        ? {
            providerId: usageKey,
            windows: usage.windows,
            ...(usage.summary ? { summary: usage.summary } : {}),
            ...(usage.plan ? { plan: usage.plan } : {}),
            ...(usage.billing?.length ? { billing: usage.billing } : {}),
            ...(includeProfileIdentity && usage.accountEmail
              ? { accountEmail: usage.accountEmail }
              : {}),
          }
        : undefined,
  };
}

export function resolveConfigBoundProfileIds(
  config: OpenClawConfig,
  store: AuthProfileStore,
  authAliasLookupParams?: ProviderAuthAliasLookupParams,
): Set<string> {
  const profileIds = new Set<string>();
  for (const provider of Object.keys(config.models?.providers ?? {})) {
    const reference = resolveProviderEntryApiKeyProfileReference({
      cfg: config,
      authAliasLookupParams,
      provider,
      store,
    });
    if (reference.kind === "profile" || reference.kind === "profile-incompatible") {
      profileIds.add(reference.profileId);
    }
  }
  return profileIds;
}

export function resolveConfiguredProviders(
  config: OpenClawConfig,
  apiKeys: ReadonlyMap<string, ModelAuthStatusProvider["apiKey"]>,
): { providers: string[]; expectsOAuth: Set<string> } {
  const providers = new Set<string>();
  const expectsOAuth = new Set<string>();
  for (const [id, provider] of Object.entries(config.models?.providers ?? {})) {
    const normalized = normalizeProviderId(id);
    if (!normalized) {
      continue;
    }
    const rawKey = typeof provider?.apiKey === "string" ? provider.apiKey.trim() : "";
    const hasApiKey =
      hasConfiguredSecretInput(provider?.apiKey, config.secrets?.defaults) &&
      (rawKey === NON_ENV_SECRETREF_MARKER ||
        !isNonSecretApiKeyMarker(rawKey, { includeEnvVarName: false }));
    const mode = provider?.auth;
    if (mode !== "oauth" && mode !== "token" && !hasApiKey) {
      continue;
    }
    if (apiKeys.has(normalized)) {
      continue;
    }
    providers.add(normalized);
    if (mode === "oauth") {
      expectsOAuth.add(normalized);
    }
  }
  for (const profile of Object.values(config.auth?.profiles ?? {})) {
    const provider = profile?.provider;
    const mode = profile?.mode;
    if (
      typeof provider !== "string" ||
      provider.length === 0 ||
      (mode !== "oauth" && mode !== "token")
    ) {
      continue;
    }
    const normalized = normalizeProviderId(provider);
    if (!normalized || apiKeys.has(normalized)) {
      continue;
    }
    providers.add(normalized);
    if (mode === "oauth") {
      expectsOAuth.add(normalized);
    }
  }
  return { providers: [...providers], expectsOAuth };
}
