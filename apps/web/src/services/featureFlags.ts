// Client for /api/admin/flags — the admin Feature Flags page's only server call.
//
// The flag names are deliberately NOT listed here. The server's registry
// (api/functions/feature-flags.ts) decides what exists, and the GET response carries exactly those
// names, so the page renders whatever comes back and this file never has to be kept in step. The
// page supplies labels only.

/** Flag name → live to everyone. Every known flag is present, so a missing key means "unknown". */
export type FeatureFlagMap = Record<string, boolean>;

export class FeatureFlagsApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'FeatureFlagsApiError';
    this.status = status;
  }
}

async function call(token: string, init: RequestInit = {}): Promise<FeatureFlagMap> {
  const response = await fetch('/api/admin/flags', {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
  });
  const body = (await response.json().catch(() => ({}))) as { flags?: FeatureFlagMap; error?: string };
  if (!response.ok) {
    throw new FeatureFlagsApiError(body.error ?? `HTTP ${response.status}`, response.status);
  }
  return body.flags ?? {};
}

export function getFeatureFlags(token: string): Promise<FeatureFlagMap> {
  return call(token);
}

/** Toggle one flag, resolving with the map the server now holds. */
export function updateFeatureFlag(token: string, flag: string, enabled: boolean): Promise<FeatureFlagMap> {
  return call(token, { method: 'POST', body: JSON.stringify({ flag, enabled }) });
}
