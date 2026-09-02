import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { formatErrorMessage } from "../infra/errors.js";
import type { GatewayCloseOptions } from "./server-public.js";

/** Shutdown is published before ingress closes; absent restart metadata stays absent. */
export function resolveGatewayShutdownNotice(options?: GatewayCloseOptions) {
  const restartExpectedMs = options?.restartExpectedMs;
  return {
    reason: normalizeOptionalString(options?.reason) || "gateway stopping",
    ...(typeof restartExpectedMs === "number" && Number.isFinite(restartExpectedMs)
      ? { restartExpectedMs: Math.max(0, Math.floor(restartExpectedMs)) }
      : {}),
  };
}

type GatewayShutdownStep = {
  name: string;
  run: () => Promise<void> | void;
};

/** Run every shutdown step even when one owner fails, with the failed owner named. */
export async function runGatewayShutdownSteps(params: {
  steps: readonly GatewayShutdownStep[];
  onError: (message: string) => void;
}): Promise<void> {
  const errors: Error[] = [];
  for (const step of params.steps) {
    try {
      await step.run();
    } catch (error) {
      const message = `shutdown step failed (${step.name}): ${formatErrorMessage(error)}`;
      params.onError(message);
      errors.push(new Error(message, { cause: error }));
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, "Gateway shutdown did not complete cleanly");
  }
}
