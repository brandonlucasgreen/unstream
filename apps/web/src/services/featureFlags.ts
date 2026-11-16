// Client for /api/admin/flags — the admin Feature Flags page's only server call.
//
// The flag names are deliberately NOT listed here. The server's registry
// (api/functions/feature-flags.ts) decides what exists, and the GET response carries exactly those
// names, so the page renders whatever comes back and this file never has to be kept in step. The
// page supplies labels only.

import { ApiError, apiRequest, type ApiRequestOptions } from './api';

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

async function call(token: string, options: ApiRequestOptions = {}): Promise<FeatureFlagMap> {
  try {
    const body = await apiRequest<{ flags?: FeatureFlagMap }>(token, '/api/admin/flags', options);
    return body.flags ?? {};
  } catch (err) {
    if (!(err instanceof ApiError)) throw err;
    const { error } = err.body as { error?: string };
    throw new FeatureFlagsApiError(error ?? `HTTP ${err.status}`, err.status);
  }
}

export function getFeatureFlags(token: string): Promise<FeatureFlagMap> {
  return call(token);
}

/** Toggle one flag, resolving with the map the server now holds. */
export function updateFeatureFlag(token: string, flag: string, enabled: boolean): Promise<FeatureFlagMap> {
  return call(token, { method: 'POST', body: { flag, enabled } });
}
