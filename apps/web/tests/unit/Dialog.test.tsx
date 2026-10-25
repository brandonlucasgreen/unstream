// @vitest-environment jsdom
// The shared modal primitive (audit 2026-10-25 #9). The browser supplies inertness, Tab
// containment and Escape for a showModal() dialog; these pin what Dialog adds: one close path
// that always calls onClose, focus back to the trigger, and a way to refuse dismissal mid-request.
// jsdom's missing <dialog> methods are stood in for in tests/setup.ts.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { useState } from 'react';
import { Dialog } from 'src/components/Dialog';

afterEach(cleanup);

function Harness({ dismissible = true, onClose = () => {} }: { dismissible?: boolean; onClose?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>Open</button>
      {open && (
        <Dialog labelledBy="t" dismissible={dismissible} onClose={() => { setOpen(false); onClose(); }}>
          {close => (
            <>
              <h2 id="t">Title</h2>
              <button onClick={close}>Done</button>
            </>
          )}
        </Dialog>
      )}
    </>
  );
}

function open() {
  const trigger = screen.getByText('Open');
  trigger.focus();
  fireEvent.click(trigger);
  return trigger;
}

describe('Dialog', () => {
  it('opens modally, named by its heading, with focus inside', () => {
    render(<Harness />);
    open();

    const dialog = screen.getByRole('dialog', { name: 'Title' });
    expect(dialog.hasAttribute('open')).toBe(true);
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it('closes through the caller\'s button, calls onClose and refocuses the trigger', () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    const trigger = open();

    fireEvent.click(screen.getByText('Done'));

    expect(onClose).toHaveBeenCalledOnce();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('closes on a backdrop click (a click on the dialog element itself)', () => {
    render(<Harness />);
    open();

    fireEvent.click(screen.getByRole('dialog'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('ignores Escape and backdrop clicks while not dismissible', () => {
    render(<Harness dismissible={false} />);
    open();
    const dialog = screen.getByRole('dialog');

    const cancel = new Event('cancel', { cancelable: true });
    fireEvent(dialog, cancel);
    expect(cancel.defaultPrevented).toBe(true);

    fireEvent.click(dialog);
    expect(screen.getByRole('dialog')).toBeTruthy();

    // The caller's own buttons still work.
    fireEvent.click(screen.getByText('Done'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('keeps clicks inside from reaching a clickable parent', () => {
    const parentClick = vi.fn();
    render(
      <div onClick={parentClick}>
        <Dialog labelledBy="t" onClose={() => {}}>
          <h2 id="t">Title</h2>
        </Dialog>
      </div>
    );

    fireEvent.click(screen.getByText('Title'));
    expect(parentClick).not.toHaveBeenCalled();
  });
});
