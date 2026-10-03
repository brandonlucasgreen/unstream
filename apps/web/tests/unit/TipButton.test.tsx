// @vitest-environment jsdom
// The Tip button and the tip window it opens.
//
// What's worth locking: a plain click opens the window over the page (no navigation), while
// Cmd/Ctrl-click keeps the link's normal meaning; the window loads the artist's tip data and shows
// the form, with a goal preselected when one was clicked; clicks inside it don't reach the clickable
// UI the button sits in; and closing it removes it.
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { TipButton, TipLink } from 'src/components/TipButton';

vi.mock('src/contexts/AuthContext', () => ({ useAuth: () => ({ session: null }) }));
vi.mock('@sentry/react', () => ({ captureException: vi.fn() }));

// jsdom has <dialog> but not its modal methods.
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  };
});

const fetchMock = vi.fn();
const tipPage = {
  artist: { id: 'a1', slug: 'kid-lightbulbs', name: 'Kid Lightbulbs', imageUrl: null },
  takingTips: true, feeBasisPoints: 0, presetsCents: [500, 1000, 2000], minCents: 300, maxCents: 50000,
  goals: [{ id: 'g1', title: 'Vinyl', targetCents: 240000, raisedCents: 500, status: 'open' }],
};

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(() => Promise.resolve(new Response(JSON.stringify(tipPage))));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('TipButton', () => {
  it('opens the tip window on a plain click, without leaving the page', async () => {
    const parentClick = vi.fn();
    render(
      <MemoryRouter>
        <div onClick={parentClick}><TipButton slug="kid-lightbulbs" artistName="Kid Lightbulbs" /></div>
      </MemoryRouter>
    );
    const link = screen.getByRole('link', { name: /Tip Kid Lightbulbs/ });
    expect(link.getAttribute('href')).toBe('/tip/kid-lightbulbs');

    const click = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    fireEvent(link, click);
    expect(click.defaultPrevented).toBe(true);

    expect(await screen.findByRole('button', { name: /Pay \$10\.\d\d with Stripe/ })).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith('/api/tips/checkout?slug=kid-lightbulbs');
    expect(screen.getByRole('dialog').hasAttribute('open')).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: '$5' }));
    expect(parentClick).not.toHaveBeenCalled();
  });

  it('leaves Cmd-click to the browser, so the tip page opens in a new tab', () => {
    render(<MemoryRouter><TipButton slug="kid-lightbulbs" artistName="Kid Lightbulbs" /></MemoryRouter>);
    const click = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, metaKey: true });
    fireEvent(screen.getByRole('link', { name: /Tip Kid Lightbulbs/ }), click);
    expect(click.defaultPrevented).toBe(false);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('closes, and is gone afterwards', async () => {
    render(<MemoryRouter><TipButton slug="kid-lightbulbs" artistName="Kid Lightbulbs" /></MemoryRouter>);
    fireEvent.click(screen.getByRole('link', { name: /Tip Kid Lightbulbs/ }));
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});

describe('TipLink with a goal', () => {
  it('opens the window with that goal chosen', async () => {
    render(
      <MemoryRouter>
        <TipLink slug="kid-lightbulbs" artistName="Kid Lightbulbs" goalId="g1">Vinyl</TipLink>
      </MemoryRouter>
    );
    expect(screen.getByRole('link', { name: 'Vinyl' }).getAttribute('href')).toBe('/tip/kid-lightbulbs?goal=g1');
    fireEvent.click(screen.getByRole('link', { name: 'Vinyl' }));
    const radio = await screen.findByRole('radio');
    expect((radio as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText(/whether or not the goal is met/)).toBeTruthy();
  });
});
