/**
 * Provider registry: look up provider instances by id.
 *
 * Reads PROVIDERS_ENABLED from env (comma-separated). Defaults to "baseline".
 *
 *   PROVIDERS_ENABLED=baseline                # default: one direct LLM call
 *   PROVIDERS_ENABLED=baseline,qodo           # head-to-head vs qodo pr-agent
 */
import { createBaselineProvider } from "./baseline.js";
import { createQodoProvider } from "./qodo.js";
import type { Provider } from "./index.js";

const FACTORIES: Record<string, () => Provider> = {
  baseline: createBaselineProvider,
  qodo: createQodoProvider,
};

export function listAllProviderIds(): string[] {
  return Object.keys(FACTORIES);
}

export function getProvider(id: string): Provider {
  const factory = FACTORIES[id];
  if (!factory) {
    throw new Error(`Unknown provider id "${id}". Known: ${listAllProviderIds().join(", ")}`);
  }
  return factory();
}

/**
 * Resolve enabled providers from env. Unknown ids fail loudly so a typo in
 * PROVIDERS_ENABLED doesn't silently drop a column from the comparison.
 */
export function resolveEnabledProviders(envValue?: string): Provider[] {
  const raw = (envValue ?? "baseline").trim();
  if (raw === "") return [createBaselineProvider()];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map(getProvider);
}
