// @vitest-environment jsdom
// Audit 2026-10-25 #7: when /api/me/settings failed, the page rendered its forms from defaults —
// an empty username, no email, and "Set password" (hasPassword=false) for someone who has one.
// Those sections are now withheld behind a retry; the sections that load their own data stay.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { SettingsPage } from 'src/pages/SettingsPage';

// One session object, as the real AuthContext holds: a fresh object per render would re-run the
// page's load effect on every render and race the retry this test drives.
const session = { access_token: 't', user: { email: 'fan@example.com' } };
vi.mock('src/contexts/AuthContext', () => ({
  useAuth: () => ({ session, isLoading: false }),
}));
vi.mock('@sentry/react', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('src/components/Header', () => ({ Header: () => null }));
vi.mock('src/components/Footer', () => ({ Footer: () => null }));
vi.mock('src/components/SharingControls', () => ({ SharingControls: () => <p>sharing</p> }));
vi.mock('src/components/BandcampConnect', () => ({ BandcampConnect: () => null }));
vi.mock('src/components/ReleaseFeedOffSwitch', () => ({ ReleaseFeedOffSwitch: () => null }));
vi.mock('src/components/NewsletterPrompt', () => ({ NewsletterPrompt: () => null }));
vi.mock('src/components/NotificationPreferences', () => ({ NotificationPreferences: () => null }));
vi.mock('src/components/UsernameField', () => ({ UsernameField: () => <p>username field</p> }));
vi.mock('src/components/LocationField', () => ({ LocationField: () => null }));
vi.mock('src/components/EmailChangeForm', () => ({ EmailChangeForm: ({ currentEmail }: { currentEmail: string }) => <p>email {currentEmail}</p> }));
vi.mock('src/components/PasswordChangeForm', () => ({
  PasswordChangeForm: ({ hasPassword }: { hasPassword: boolean }) => <p>{hasPassword ? 'Change password' : 'Set password'}</p>,
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const settings = { username: 'fan', location: null, email: 'fan@example.com', hasPassword: true };

describe('SettingsPage when settings fail to load', () => {
  it('withholds the account forms behind a retry instead of showing defaults', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 500 }))
      .mockResolvedValue(new Response(JSON.stringify(settings), { status: 200 })));
    render(<MemoryRouter><SettingsPage /></MemoryRouter>);

    expect(await screen.findByText(/couldn't be loaded/)).toBeTruthy();
    expect(screen.queryByText('Set password')).toBeNull();
    expect(screen.queryByText('username field')).toBeNull();
    // Sections with their own data still render.
    expect(screen.getByText('sharing')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Change password')).toBeTruthy();
    expect(screen.getByText('email fan@example.com')).toBeTruthy();
  });
});
