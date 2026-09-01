import { asDateTimestampMs } from "@openclaw/normalization-core/number-coercion";
import {
  type AuthProfileHealthStatus,
  type AuthProviderHealth,
  type AuthProviderHealthStatus,
  formatRemainingShort,
} from "../../agents/auth-health.js";
import type { ModelAuthExpiry } from "./models-auth-status.types.js";

type ModelAuthStatusRollup = {
  status: AuthProviderHealthStatus;
  expiresAt?: number;
  remainingMs?: number;
};

export function buildModelAuthExpiry(
  remainingMs: number | undefined,
  expiresAt: number | undefined,
): ModelAuthExpiry | undefined {
  const normalizedExpiresAt = asDateTimestampMs(expiresAt);
  if (normalizedExpiresAt === undefined || typeof remainingMs !== "number") {
    return undefined;
  }
  return { at: normalizedExpiresAt, remainingMs, label: formatRemainingShort(remainingMs) };
}

function aggregateProfileStatus(
  profiles: AuthProviderHealth["profiles"],
  now: number,
): ModelAuthStatusRollup {
  const statuses = new Set<AuthProfileHealthStatus>(profiles.map((profile) => profile.status));
  const status = (["expired", "missing", "expiring", "ok", "static"] as const).find((candidate) =>
    statuses.has(candidate),
  );
  const expirable = profiles
    .map((profile) => profile.expiresAt)
    .filter((value): value is number => asDateTimestampMs(value) !== undefined);
  const expiresAt = expirable.length > 0 ? Math.min(...expirable) : undefined;
  const remainingMs = expiresAt !== undefined ? expiresAt - now : undefined;
  return { status: status ?? "static", expiresAt, remainingMs };
}

/** Aggregate the effective refreshable credential status for the dashboard. */
export function aggregateRefreshableAuthStatus(
  provider: AuthProviderHealth,
  now: number = Date.now(),
  expectsOAuth = false,
): ModelAuthStatusRollup {
  const profiles = provider.effectiveProfiles ?? provider.profiles;
  const oauth = profiles.filter((profile) => profile.type === "oauth");
  if (oauth.length > 0) {
    return aggregateProfileStatus(oauth, now);
  }
  const tokens = profiles.filter((profile) => profile.type === "token");
  if (tokens.length > 0) {
    return aggregateProfileStatus(tokens, now);
  }
  if (expectsOAuth) {
    return { status: "missing" };
  }
  return {
    status: provider.status,
    expiresAt: provider.expiresAt,
    remainingMs: provider.remainingMs,
  };
}
