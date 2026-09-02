import { HEARTBEAT_TASK_DECLARATION_PREFIX } from "./heartbeat-task.js";

export const HEARTBEAT_DECLARATION_PREFIX = "heartbeat:";
export const SKILL_COLLECTION_REVIEW_DECLARATION_PREFIX = "skill-collection-review:";

/** Declaration-key namespaces reserved for jobs the gateway converges itself. */
const SYSTEM_OWNED_DECLARATION_PREFIXES = [
  HEARTBEAT_TASK_DECLARATION_PREFIX,
  HEARTBEAT_DECLARATION_PREFIX,
  SKILL_COLLECTION_REVIEW_DECLARATION_PREFIX,
];

export function systemOwnedDeclarationKeyNamespace(
  declarationKey: string | undefined,
): string | undefined {
  return SYSTEM_OWNED_DECLARATION_PREFIXES.find((prefix) => declarationKey?.startsWith(prefix));
}

export function isSystemOwnedCronDeclaration(declarationKey: string | undefined): boolean {
  return systemOwnedDeclarationKeyNamespace(declarationKey) !== undefined;
}
