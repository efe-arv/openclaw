// Model auth status methods report provider credential health, profile expiry,
// usage windows, cleanup actions, and auth-state refreshes.
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import {
  ErrorCodes,
  errorShape,
  validateModelsAuthLogoutParams,
  validateModelsAuthOrderSetParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { tryResolveAmbientOwnerAgentId } from "../../agents/agent-scope-config.js";
import { type AuthHealthSummary, buildAuthHealthSummary } from "../../agents/auth-health.js";
import {
  AuthProfileOrderChangedError,
  ensureAuthProfileStoreWithoutExternalProfiles,
  externalCliDiscoveryForConfigStatus,
  listRuntimeLocalProfileIds,
  listProfilesForProvider,
  removeAuthProfilesAcrossOwnerStores,
  removeProviderAuthProfilesWithLock,
  resolveExplicitAuthOrderSelection,
  resolvePersistedAuthProfileOwnerAgentDir,
  setAuthProfileOrder,
} from "../../agents/auth-profiles.js";
import { getRuntimeExternalCliProfileIds } from "../../agents/auth-profiles/runtime-external-profile-references.js";
import {
  clearCurrentProviderAuthState,
  warmCurrentProviderAuthStateOffMainThread,
} from "../../agents/model-provider-auth.js";
import { preparedModelRuntimeConfigsMatch } from "../../agents/prepared-model-runtime.js";
import {
  type ProviderAuthAliasLookupParams,
  resolveProviderIdForAuth,
} from "../../agents/provider-auth-aliases.js";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveUsageProviderId } from "../../infra/provider-usage.shared.js";
import type { UsageProviderId } from "../../infra/provider-usage.types.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { refreshActiveProviderAuthRuntimeSnapshot } from "../../secrets/runtime.js";
import { abortChatRunsForProvider, type ChatAbortOps } from "../chat-abort.js";
import { ADMIN_SCOPE } from "../operator-scopes.js";
import { loadDeferredCatalog, readPreparedCatalog } from "../server-model-catalog-auth.js";
import { formatForLog } from "../ws-log.js";
import { modelAuthAgentScopeError, resolveModelAuthAgentScope } from "./model-auth-agent-scope.js";
import { resolveModelProviderCapabilities } from "./model-provider-capabilities.js";
import { resolveProviderApiKeys } from "./models-auth-status-api-keys.js";
import {
  projectModelAuthStatusProvider,
  resolveConfigBoundAuthBindings,
  resolveConfiguredProviders,
} from "./models-auth-status-projection.js";
import {
  clearModelAuthStatusUsageCache,
  readProviderUsageStaleWhileRevalidate,
} from "./models-auth-status-usage-cache.js";
import type {
  ModelAuthLogoutResult,
  ModelAuthOrderSetResult,
  ModelAuthStatusResult,
  ModelProviderCapability,
} from "./models-auth-status.types.js";
import { getProviderUsageRuntimeSnapshot } from "./provider-usage-runtime.js";
import type { GatewayRequestContext, GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

export type {
  ModelAuthExpiry,
  ModelAuthLogoutResult,
  ModelAuthOrderSetResult,
  ModelAuthStatusProfile,
  ModelAuthStatusProvider,
  ModelAuthStatusResult,
  ModelProviderCapability,
} from "./models-auth-status.types.js";
export { aggregateRefreshableAuthStatus } from "./models-auth-status-rollup.js";

const log = createSubsystemLogger("models-auth-status");
const apiKeyUsageStatusProviders = new Set<UsageProviderId>(["clawrouter", "deepseek"]);

type PreparedAuthMetadataLookupParams = ProviderAuthAliasLookupParams & {
  metadataSnapshot: NonNullable<
    Awaited<ReturnType<typeof readPreparedCatalog>>
  >["metadataSnapshot"];
};

function buildProviderCapabilities(params: {
  config: OpenClawConfig;
  workspaceDir: string;
  metadataSnapshot: NonNullable<
    Awaited<ReturnType<typeof readPreparedCatalog>>
  >["metadataSnapshot"];
}): ModelProviderCapability[] {
  return resolveModelProviderCapabilities(params).capabilities;
}

function resolveAuthRefreshScope(cfg: OpenClawConfig): {
  providerIds: string[];
  profileIds?: string[];
} {
  const discovery = externalCliDiscoveryForConfigStatus({ cfg });
  if (discovery.mode !== "scoped") {
    return { providerIds: [] };
  }
  const providerIds = [...(discovery.providerIds ?? [])];
  const profileIds = [...(discovery.profileIds ?? [])];
  return {
    providerIds,
    ...(profileIds.length > 0 ? { profileIds } : {}),
  };
}

/**
 * Invalidate auxiliary usage and prepared provider-auth state after an auth
 * mutation. Auth health itself is rebuilt on every request; only outbound
 * usage enrichment is cached.
 */
export function invalidateModelAuthStatusCache(): void {
  clearModelAuthStatusUsageCache();
  // The prepared provider-auth map (model-provider-auth.ts) was built from
  // the pre-mutation auth state, so it must be invalidated alongside this
  // cache whenever an auth-profile mutation lands (logout, login, token
  // rotation, etc.). Without this, `/models` and pickers keep advertising
  // providers the running gateway can no longer authenticate.
  clearCurrentProviderAuthState();
}

async function refreshModelAuthStatusRuntimeState(): Promise<void> {
  // Durable and CLI auth refresh into the transient prepared owner below. Do not clear the
  // process-wide warmed auth state for a read; mutations still invalidate it explicitly.
  try {
    await refreshActiveProviderAuthRuntimeSnapshot();
  } catch (err) {
    log.warn(`runtime auth snapshot refresh before auth status failed: ${formatForLog(err)}`);
  }
}

function readProviderParam(params: Record<string, unknown>): string | null {
  const raw = params.provider;
  if (typeof raw !== "string") {
    return null;
  }
  const provider = normalizeProviderId(raw);
  return provider || null;
}

type LogoutProfileSelection = { ok: true; profileIds?: string[] } | { ok: false; message: string };

function readLogoutProfileSelection(params: Record<string, unknown>): LogoutProfileSelection {
  if (!("profileIds" in params)) {
    return { ok: true };
  }
  if (!Array.isArray(params.profileIds) || params.profileIds.length === 0) {
    return { ok: false, message: "profileIds must be a non-empty string array" };
  }
  const profileIds: string[] = [];
  for (const value of params.profileIds) {
    if (typeof value !== "string" || !value.trim()) {
      return { ok: false, message: "profileIds must be a non-empty string array" };
    }
    const profileId = value.trim();
    if (!profileIds.includes(profileId)) {
      profileIds.push(profileId);
    }
  }
  return { ok: true, profileIds };
}

type OrderProfileSelection =
  | { ok: true; profileIds: string[] | null }
  | { ok: false; message: string };

function readOrderProfileSelection(params: Record<string, unknown>): OrderProfileSelection {
  if (params.profileIds === undefined) {
    return { ok: true, profileIds: null };
  }
  if (!Array.isArray(params.profileIds) || params.profileIds.length === 0) {
    return { ok: false, message: "profileIds must be a non-empty string array when provided" };
  }
  const profileIds: string[] = [];
  for (const value of params.profileIds) {
    if (typeof value !== "string" || !value.trim()) {
      return { ok: false, message: "profileIds must be a non-empty string array when provided" };
    }
    const profileId = value.trim();
    if (!profileIds.includes(profileId)) {
      profileIds.push(profileId);
    }
  }
  return { ok: true, profileIds };
}

function createAuthLogoutAbortOps(context: GatewayRequestContext): ChatAbortOps {
  return {
    chatAbortControllers: context.chatAbortControllers,
    chatRunState: context.chatRunState,
    removeChatRun: context.removeChatRun,
    agentRunSeq: context.agentRunSeq,
    broadcast: context.broadcast,
    nodeSendToSession: context.nodeSendToSession,
  };
}

// Auth profiles can be adopted by a provider-specific owner agent dir. Logout
// must remove every owning store or stale profiles reappear on the next status
// read and provider-auth warmup.
async function removeProviderAuthProfilesAcrossOwnerStores(params: {
  provider: string;
  agentDir: string;
  inheritedAuthDir?: string;
  profileIds: string[];
}): Promise<boolean> {
  const ownerAgentDirs = new Set<string | undefined>([params.agentDir]);
  for (const profileId of params.profileIds) {
    ownerAgentDirs.add(
      resolvePersistedAuthProfileOwnerAgentDir({
        agentDir: params.agentDir,
        ...(params.inheritedAuthDir ? { inheritedAuthDir: params.inheritedAuthDir } : {}),
        profileId,
      }),
    );
  }
  for (const ownerAgentDir of ownerAgentDirs) {
    const updatedStore = await removeProviderAuthProfilesWithLock({
      provider: params.provider,
      agentDir: ownerAgentDir,
    });
    if (!updatedStore) {
      return false;
    }
  }
  return true;
}

export const modelsAuthStatusHandlers: GatewayRequestHandlers = {
  "models.authOrderSet": async ({ params, respond, context }) => {
    if (
      !assertValidParams(params, validateModelsAuthOrderSetParams, "models.authOrderSet", respond)
    ) {
      return;
    }
    const provider = readProviderParam(params);
    if (!provider) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "provider is required"));
      return;
    }
    const selection = readOrderProfileSelection(params);
    if (!selection.ok) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, selection.message));
      return;
    }
    try {
      const cfg = context.getRuntimeConfig();
      const scope = resolveModelAuthAgentScope(cfg, params.agentId);
      if (!scope.ok) {
        respond(false, undefined, modelAuthAgentScopeError(scope));
        return;
      }
      const preparedSnapshot = await readPreparedCatalog(context, scope.agentId);
      if (!preparedSnapshot) {
        throw new Error(`prepared model auth owner is unavailable (${scope.agentId})`);
      }
      const authAliasLookupParams: PreparedAuthMetadataLookupParams = {
        config: preparedSnapshot.config,
        workspaceDir: preparedSnapshot.workspaceDir,
        metadataSnapshot: preparedSnapshot.metadataSnapshot,
        includeUntrustedWorkspacePlugins: false,
      };
      const authProvider = resolveProviderIdForAuth(provider, authAliasLookupParams);
      const configuredOrder = resolveExplicitAuthOrderSelection({
        storeOrder: preparedSnapshot.authStore.order,
        configuredOrder: preparedSnapshot.config.auth?.order,
        providerKey: normalizeProviderId(provider),
        providerAuthKey: authProvider,
      });
      if (
        selection.profileIds &&
        configuredOrder.order !== undefined &&
        !configuredOrder.fromStore
      ) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `profile priority for provider ${provider} is controlled by auth configuration`,
          ),
        );
        return;
      }
      const availableProfileIds = Object.entries(preparedSnapshot.authStore.profiles)
        .filter(
          ([, credential]) =>
            resolveProviderIdForAuth(credential.provider, authAliasLookupParams) === authProvider,
        )
        .map(([profileId]) => profileId);
      const configBoundAuthProviders = resolveConfigBoundAuthBindings(
        preparedSnapshot.config,
        preparedSnapshot.authStore,
        authAliasLookupParams,
      ).authProviders;
      if (selection.profileIds && configBoundAuthProviders.has(authProvider)) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `profile priority for provider ${provider} is controlled by provider configuration`,
          ),
        );
        return;
      }
      const invalidProfile = selection.profileIds?.find((profileId) => {
        const credential = preparedSnapshot.authStore.profiles[profileId];
        return (
          !credential ||
          resolveProviderIdForAuth(credential.provider, authAliasLookupParams) !== authProvider
        );
      });
      if (invalidProfile) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `profileId ${invalidProfile} is unavailable for provider ${provider}`,
          ),
        );
        return;
      }
      if (selection.profileIds && selection.profileIds.length !== availableProfileIds.length) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `profileIds must include every available profile for provider ${provider}`,
          ),
        );
        return;
      }
      if (!preparedModelRuntimeConfigsMatch(preparedSnapshot.config, context.getRuntimeConfig())) {
        throw new AuthProfileOrderChangedError();
      }
      const updated = await setAuthProfileOrder({
        agentDir: preparedSnapshot.agentDir,
        ...(preparedSnapshot.inheritedAuthDir
          ? { inheritedAuthDir: preparedSnapshot.inheritedAuthDir }
          : {}),
        provider: authProvider,
        order: selection.profileIds,
        authAliasLookupParams,
        membershipGuard: {
          effectiveProfileIds: availableProfileIds,
          localProfileIds: availableProfileIds.filter((profileId) =>
            listRuntimeLocalProfileIds(preparedSnapshot.authStore).includes(profileId),
          ),
        },
      });
      if (!updated) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, "auth profile order is temporarily unavailable"),
        );
        return;
      }
      invalidateModelAuthStatusCache();
      await refreshActiveProviderAuthRuntimeSnapshot();
      // Store publication already invalidates and rebuilds the affected prepared owners. Starting
      // a second config publication here can race hot reload and revive its older config snapshot.
      // Join that owner's publication before acknowledging the write so an immediate selection
      // observes the new order instead of the invalidated generation.
      await loadDeferredCatalog(context, scope.agentId, { readOnly: true });
      void warmCurrentProviderAuthStateOffMainThread(context.getRuntimeConfig()).catch(
        (err: unknown) => {
          log.warn(`provider auth state rewarm after priority update failed: ${formatForLog(err)}`);
        },
      );
      const result: ModelAuthOrderSetResult = {
        provider,
        profileIds: selection.profileIds,
      };
      respond(true, result, undefined);
    } catch (err) {
      if (err instanceof AuthProfileOrderChangedError) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.UNAVAILABLE,
            "provider accounts changed while priority was being saved; refresh and try again",
          ),
        );
        return;
      }
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },
  "models.authLogout": async ({ params, respond, context }) => {
    if (!assertValidParams(params, validateModelsAuthLogoutParams, "models.authLogout", respond)) {
      return;
    }
    const provider = readProviderParam(params);
    if (!provider) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "provider is required"));
      return;
    }
    const selection = readLogoutProfileSelection(params);
    if (!selection.ok) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, selection.message));
      return;
    }
    try {
      const runtimeCfg = context.getRuntimeConfig();
      const scope = resolveModelAuthAgentScope(runtimeCfg, params.agentId);
      if (!scope.ok) {
        respond(false, undefined, modelAuthAgentScopeError(scope));
        return;
      }
      const preparedSnapshot = await readPreparedCatalog(context, scope.agentId);
      if (!preparedSnapshot) {
        throw new Error(`prepared model auth owner is unavailable (${scope.agentId})`);
      }
      const { agentDir, inheritedAuthDir, config: cfg } = preparedSnapshot;
      const authProvider = resolveProviderIdForAuth(provider, { config: cfg });
      const store = inheritedAuthDir
        ? ensureAuthProfileStoreWithoutExternalProfiles(agentDir, { inheritedAuthDir })
        : ensureAuthProfileStoreWithoutExternalProfiles(agentDir);
      const availableProfiles = listProfilesForProvider(store, provider);
      const removedProfiles = selection.profileIds ?? availableProfiles;
      if (
        selection.profileIds &&
        selection.profileIds.some((profileId) => {
          const profile = store.profiles[profileId];
          return (
            !availableProfiles.includes(profileId) ||
            (profile?.type !== "oauth" && profile?.type !== "token")
          );
        })
      ) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "profileIds contain unavailable auth profiles"),
        );
        return;
      }
      const configBoundProfileIds = selection.profileIds
        ? resolveConfigBoundAuthBindings(cfg, store).profileIds
        : null;
      if (selection.profileIds?.some((profileId) => configBoundProfileIds?.has(profileId))) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "profileIds contain config-bound auth profiles"),
        );
        return;
      }
      if (!preparedModelRuntimeConfigsMatch(cfg, context.getRuntimeConfig())) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.UNAVAILABLE,
            "provider accounts changed while signing out; refresh and try again",
          ),
        );
        return;
      }
      const removed = selection.profileIds
        ? await removeAuthProfilesAcrossOwnerStores({
            agentDir,
            ...(inheritedAuthDir ? { inheritedAuthDir } : {}),
            profileIds: removedProfiles,
          })
        : await removeProviderAuthProfilesAcrossOwnerStores({
            provider,
            agentDir,
            ...(inheritedAuthDir ? { inheritedAuthDir } : {}),
            profileIds: removedProfiles,
          });
      if (!removed) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.UNAVAILABLE,
            `failed to remove saved auth profiles for provider ${provider}`,
          ),
        );
        return;
      }
      // Fence auxiliary usage work that captured the removed profiles before
      // logout. Its later completion must not repopulate the cache.
      invalidateModelAuthStatusCache();
      await refreshActiveProviderAuthRuntimeSnapshot();
      void warmCurrentProviderAuthStateOffMainThread(context.getRuntimeConfig()).catch(
        (err: unknown) => {
          log.warn(`provider auth state rewarm after logout failed: ${formatForLog(err)}`);
        },
      );
      // A provider-wide abort would terminate runs using credentials this
      // logout preserved (other profiles, tokens, or the config API key). Abort
      // entries do not carry the profile id, so a targeted logout cannot scope
      // the abort and instead leaves in-flight runs to fail on their next
      // request; only a full-provider logout revokes everything and aborts.
      const { runIds: abortedRunIds } = selection.profileIds
        ? { runIds: [] as string[] }
        : abortChatRunsForProvider(createAuthLogoutAbortOps(context), {
            cfg,
            providerId: authProvider,
            agentId: scope.agentId,
            stopReason: "auth-revoked",
          });
      const result: ModelAuthLogoutResult = {
        provider,
        removedProfiles,
        abortedRunIds,
      };
      respond(true, result, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },
  "models.authStatus": async ({ params, respond, context, client }) => {
    const now = Date.now();
    const refreshRequested = Boolean(params.refresh);
    const includeProfileIdentity =
      Array.isArray(client?.connect?.scopes) && client.connect.scopes.includes(ADMIN_SCOPE);
    const resolveScope = (cfg: OpenClawConfig) =>
      resolveModelAuthAgentScope(
        cfg,
        params.agentId === undefined || params.agentId === ""
          ? tryResolveAmbientOwnerAgentId(cfg)
          : params.agentId,
      );
    try {
      let cfg = context.getRuntimeConfig();
      let scope = resolveScope(cfg);
      if (!scope.ok) {
        respond(false, undefined, modelAuthAgentScopeError(scope));
        return;
      }
      if (refreshRequested) {
        await refreshModelAuthStatusRuntimeState();
        cfg = context.getRuntimeConfig();
        scope = resolveScope(cfg);
        if (!scope.ok) {
          respond(false, undefined, modelAuthAgentScopeError(scope));
          return;
        }
      }
      const preparedSnapshot = refreshRequested
        ? await loadDeferredCatalog(context, scope.agentId, {
            readOnly: true,
            authScope: resolveAuthRefreshScope(cfg),
            refreshAuth: true,
            refreshFullCatalog: false,
          })
        : await readPreparedCatalog(context, scope.agentId);
      if (!preparedSnapshot) {
        // A lifecycle replacement may temporarily withdraw this owner. Status must not
        // rediscover credentials or turn missing preparation into a connection failure.
        const result: ModelAuthStatusResult = {
          ts: now,
          providers: [],
          unavailable: {
            code: "PREPARED_MODEL_AUTH_UNAVAILABLE",
            message:
              "Model authentication status is unavailable. Refresh Models after setup finishes; restart the Gateway if it persists.",
          },
        };
        respond(true, result, undefined);
        return;
      }
      cfg = preparedSnapshot.config;
      const { agentId, agentDir, authStore: store, workspaceDir } = preparedSnapshot;
      // Generic auth helpers may consult provider metadata indirectly. Carry this owner's exact
      // snapshot through them so a global miss cannot rediscover plugins on the event loop.
      const authAliasLookupParams: PreparedAuthMetadataLookupParams = {
        config: cfg,
        workspaceDir,
        metadataSnapshot: preparedSnapshot.metadataSnapshot,
        includeUntrustedWorkspacePlugins: false,
      };
      const apiKeys = resolveProviderApiKeys(cfg, store, authAliasLookupParams);
      const configured = resolveConfiguredProviders(cfg, apiKeys);
      const statusProviderIds = new Set(configured.providers);
      for (const provider of apiKeys.keys()) {
        statusProviderIds.add(provider);
      }
      for (const profile of Object.values(store.profiles)) {
        const provider = normalizeProviderId(profile.provider);
        if (provider) {
          statusProviderIds.add(provider);
        }
      }
      const authHealth: AuthHealthSummary = buildAuthHealthSummary({
        store,
        cfg,
        providers: statusProviderIds.size > 0 ? [...statusProviderIds] : undefined,
        allowKeychainPrompt: false,
        authAliasLookupParams,
      });

      // Usage queries usually need refreshable credentials. Keep API-key status
      // enrichment explicit so static auth providers are not polled by default.
      const usageProviderIds = [
        ...new Set(
          authHealth.profiles
            .filter((p) => {
              if (p.type === "oauth" || p.type === "token") {
                return true;
              }
              const usageProvider = resolveUsageProviderId(p.provider, {
                credentialType: p.type,
              });
              return usageProvider ? apiKeyUsageStatusProviders.has(usageProvider) : false;
            })
            .map((p) => resolveUsageProviderId(p.provider, { credentialType: p.type }))
            .filter((id): id is UsageProviderId => Boolean(id)),
        ),
      ];

      const providerUsageRuntime = getProviderUsageRuntimeSnapshot({
        config: cfg,
        agentId,
        agentDir,
        store,
      });
      const usageByProvider = readProviderUsageStaleWhileRevalidate({
        agentId,
        agentDir,
        authStore: providerUsageRuntime.store,
        configRef: cfg,
        credentialKey: providerUsageRuntime.credentialKey,
        forceRefresh: refreshRequested,
        providerIds: usageProviderIds,
        now,
      });

      const externalProfileIds = new Set(store.runtimeExternalProfileIds ?? []);
      const externalCliProfileIds = new Set(getRuntimeExternalCliProfileIds(store));
      const logoutProfileIds = new Set(
        Object.entries(store.profiles)
          .filter(
            ([profileId, profile]) =>
              !externalProfileIds.has(profileId) &&
              (profile.type === "oauth" || profile.type === "token"),
          )
          .map(([profileId]) => profileId),
      );
      const { profileIds: configBoundProfileIds, authProviders: configBoundAuthProviders } =
        resolveConfigBoundAuthBindings(cfg, store, authAliasLookupParams);
      const providers = authHealth.providers.map((prov) =>
        projectModelAuthStatusProvider({
          provider: prov,
          config: cfg,
          store,
          authAliasLookupParams,
          usageByProvider,
          expectsOAuthProviders: configured.expectsOAuth,
          apiKeys,
          logoutProfileIds,
          configBoundProfileIds,
          configBoundAuthProviders,
          externalProfileIds,
          externalCliProfileIds,
          includeProfileIdentity,
        }),
      );
      const providerCapabilities = buildProviderCapabilities({
        config: cfg,
        workspaceDir,
        metadataSnapshot: preparedSnapshot.metadataSnapshot,
      });
      const result: ModelAuthStatusResult = { ts: now, providers, providerCapabilities };
      respond(true, result, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },
};
