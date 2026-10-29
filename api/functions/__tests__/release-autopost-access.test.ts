// Release autopost is the admin's alone until the `releaseAutopost` flag is switched on
// (Brandon, 2026-10-29). These pin that gate, which every autopost endpoint goes through.

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

const mocks = vi.hoisted(() => ({ getFeatureFlag: vi.fn() }));
vi.mock('../feature-flags', () => ({ getFeatureFlag: mocks.getFeatureFlag }));

const { canUseReleaseAutopost } = await import('../release-autopost-access');

const savedAdmin = process.env.ADMIN_EMAIL;
afterAll(() => {
  if (savedAdmin === undefined) delete process.env.ADMIN_EMAIL;
  else process.env.ADMIN_EMAIL = savedAdmin;
});

describe('canUseReleaseAutopost', () => {
  beforeEach(() => {
    process.env.ADMIN_EMAIL = 'admin@example.com';
    mocks.getFeatureFlag.mockReset();
    mocks.getFeatureFlag.mockResolvedValue(false);
  });

  it('lets the admin in while the flag is off, whatever the case of the address', async () => {
    expect(await canUseReleaseAutopost('admin@example.com')).toBe(true);
    expect(await canUseReleaseAutopost('Admin@Example.com')).toBe(true);
  });

  it('keeps everyone else out while the flag is off', async () => {
    expect(await canUseReleaseAutopost('artist@example.com')).toBe(false);
    expect(mocks.getFeatureFlag).toHaveBeenCalledWith('releaseAutopost');
  });

  it('lets everyone in once the flag is on', async () => {
    mocks.getFeatureFlag.mockResolvedValue(true);
    expect(await canUseReleaseAutopost('artist@example.com')).toBe(true);
  });

  it('never treats a missing email or a missing ADMIN_EMAIL as the admin', async () => {
    expect(await canUseReleaseAutopost(null)).toBe(false);
    expect(await canUseReleaseAutopost('')).toBe(false);
    delete process.env.ADMIN_EMAIL;
    expect(await canUseReleaseAutopost('admin@example.com')).toBe(false);
  });
});
