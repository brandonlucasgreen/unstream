// @vitest-environment jsdom
// The asset library's drop zone: dropping images uploads them, anything that isn't an image is set
// aside with a reason, and a full library takes nothing.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { PromoteAssets } from 'src/services/promote';

const auth = vi.hoisted(() => ({ value: { session: { access_token: 'tok', user: { id: 'u1' } }, isLoading: false } }));
const promote = vi.hoisted(() => ({ getPromoteAssets: vi.fn(), uploadPromoteAsset: vi.fn(), removePromoteAsset: vi.fn() }));

vi.mock('src/contexts/AuthContext', () => ({ useAuth: () => auth.value }));
vi.mock('@sentry/react', () => ({ captureException: vi.fn() }));
vi.mock('src/services/promoteImages', () => ({
  ACCEPTED_TYPES: 'image/jpeg,image/png,image/webp,image/gif,image/avif',
  prepareUpload: (file: File) => Promise.resolve(`b64:${file.name}`),
}));
vi.mock('src/services/promote', async (importOriginal) => ({
  ...(await importOriginal<typeof import('src/services/promote')>()),
  getPromoteAssets: promote.getPromoteAssets,
  uploadPromoteAsset: promote.uploadPromoteAsset,
  removePromoteAsset: promote.removePromoteAsset,
}));

import { PromoteAssetsPage } from 'src/pages/PromoteAssetsPage';

const library = (count: number, max = 12): PromoteAssets => ({
  available: true,
  max,
  assets: Array.from({ length: count }, (_, i) => ({ id: `a${i}`, url: `https://img.test/${i}.jpg`, width: 1080, height: 1080, instagramOk: true })),
});

const file = (name: string, type: string) => new File(['x'], name, { type });

const renderPage = () => render(
  <MemoryRouter initialEntries={['/promote/kid-lightbulbs/assets']}>
    <Routes><Route path="/promote/:slug/assets" element={<PromoteAssetsPage />} /></Routes>
  </MemoryRouter>,
);

const zone = async () => (await screen.findByRole('heading', { name: 'Images' })).closest('section')!;

const drag = (target: Element, type: 'dragEnter' | 'drop', files: File[] = []) =>
  fireEvent[type](target, { dataTransfer: { types: ['Files'], files, dropEffect: 'none' } });

describe('PromoteAssetsPage drag and drop', () => {
  beforeEach(() => {
    promote.getPromoteAssets.mockReset();
    promote.uploadPromoteAsset.mockReset();
  });
  afterEach(cleanup);

  it('uploads dropped images, one at a time', async () => {
    promote.getPromoteAssets.mockResolvedValue(library(1));
    promote.uploadPromoteAsset.mockResolvedValueOnce(library(2)).mockResolvedValueOnce(library(3));
    renderPage();
    const section = await zone();

    drag(section, 'dragEnter');
    expect(screen.getByText('Drop images to add them')).toBeTruthy();

    drag(section, 'drop', [file('a.jpg', 'image/jpeg'), file('b.png', 'image/png')]);
    await waitFor(() => expect(promote.uploadPromoteAsset).toHaveBeenCalledTimes(2));
    expect(promote.uploadPromoteAsset.mock.calls.map(c => c[2])).toEqual(['b64:a.jpg', 'b64:b.png']);
    expect(screen.queryByText('Drop images to add them')).toBeNull();
    await waitFor(() => expect(screen.getByText('3 of 12')).toBeTruthy());
  });

  it('sets aside a dropped file that isn’t an image without spending a place on it', async () => {
    promote.getPromoteAssets.mockResolvedValue(library(11));
    promote.uploadPromoteAsset.mockResolvedValue(library(12));
    renderPage();
    const section = await zone();

    drag(section, 'drop', [file('notes.pdf', 'application/pdf'), file('a.jpg', 'image/jpeg')]);
    await waitFor(() => expect(promote.uploadPromoteAsset).toHaveBeenCalledTimes(1));
    expect(promote.uploadPromoteAsset.mock.calls[0][2]).toBe('b64:a.jpg');
    expect((await screen.findByRole('alert')).textContent).toContain('notes.pdf isn’t an image');
  });

  it('takes nothing into a full library and says why', async () => {
    promote.getPromoteAssets.mockResolvedValue(library(12));
    renderPage();
    const section = await zone();

    drag(section, 'dragEnter');
    expect(screen.getByText(/Your library is full/)).toBeTruthy();
    drag(section, 'drop', [file('a.jpg', 'image/jpeg')]);
    expect(promote.uploadPromoteAsset).not.toHaveBeenCalled();
  });
});
