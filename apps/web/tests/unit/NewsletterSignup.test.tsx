// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';

vi.mock('@sentry/react', () => ({ captureException: vi.fn() }));

const mockFetch = vi.fn();
global.fetch = mockFetch;

import { NewsletterSignup } from '../../src/components/NewsletterSignup';

function renderSignup(props: Partial<Parameters<typeof NewsletterSignup>[0]> = {}) {
  return render(
    <NewsletterSignup source="changelog" blurb="Get updates." {...props} />
  );
}

function submit(email: string) {
  fireEvent.change(screen.getByLabelText('Email address'), { target: { value: email } });
  fireEvent.submit(screen.getByRole('button', { name: 'Subscribe' }).closest('form')!);
}

describe('NewsletterSignup', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it('posts the email and the source to our own API', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ status: 'pending' }) });

    renderSignup({ source: 'guides' });
    submit('fan@example.com');

    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('/api/newsletter/subscribe');
    expect(JSON.parse(init.body)).toEqual({ email: 'fan@example.com', source: 'guides' });
  });

  it('asks the subscriber to confirm rather than claiming they are subscribed', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ status: 'pending' }) });

    renderSignup();
    submit('fan@example.com');

    // Signup is double opt-in — saying "you're subscribed" while a confirmation email sits
    // unread is how people conclude the newsletter is broken.
    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toMatch(/check your inbox/i);
    });
  });

  it('tells an existing subscriber they are already on the list', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ status: 'already_subscribed' }),
    });

    renderSignup();
    submit('fan@example.com');

    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toMatch(/already on the list/i);
    });
  });

  it("surfaces the API's error and keeps the form up to retry", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      json: () => Promise.resolve({ error: "That doesn't look like an email address." }),
    });

    renderSignup();
    submit('nope');

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toBe("That doesn't look like an email address.");
    });
    expect(screen.getByRole('button', { name: 'Subscribe' })).not.toBeNull();
  });

  it('does not report success when the request throws', async () => {
    mockFetch.mockRejectedValue(new Error('offline'));

    renderSignup();
    submit('fan@example.com');

    await waitFor(() => expect(screen.getByRole('alert')).not.toBeNull());
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('offers the feed as the no-email option when a feedUrl is given', () => {
    renderSignup({ feedUrl: '/changelog.xml' });

    expect(screen.getByRole('link', { name: /RSS feed/ }).getAttribute('href')).toBe('/changelog.xml');
  });
});
