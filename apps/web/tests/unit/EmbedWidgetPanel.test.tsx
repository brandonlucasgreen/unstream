// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { EmbedWidgetPanel, EMBED_THEMES, embeddablePlatforms } from '../../src/components/EmbedWidgetPanel';

const widgetSource = readFileSync(path.resolve(__dirname, '../../public/widget.js'), 'utf8');

const links = [
  { platform: 'bandcamp' },
  { platform: 'subvert' },
  { platform: 'other' },
  { platform: 'bandcamp' },
  { platform: 'instagram' },
];

const snippet = () => document.querySelector('pre')!.textContent!;
const preview = () => document.querySelector('.unstream-widget')!;

describe('EmbedWidgetPanel', () => {
  afterEach(cleanup);

  it('starts from the dark theme', () => {
    render(<EmbedWidgetPanel artistName="Kid Lightbulbs" slug="kid-lightbulbs" links={links} />);
    expect(snippet()).toContain('data-theme="dark"');
    expect(preview().getAttribute('data-theme')).toBe('dark');
    expect(screen.queryByLabelText('Background colour')).toBeNull();
  });

  it('switches to custom colours seeded from the theme on screen, in both snippet and preview', () => {
    render(<EmbedWidgetPanel artistName="Kid Lightbulbs" slug="kid-lightbulbs" links={links} />);
    fireEvent.click(screen.getByRole('button', { name: 'Light' }));
    fireEvent.click(screen.getByRole('button', { name: 'Custom' }));

    const bg = screen.getByLabelText('Background colour') as HTMLInputElement;
    const text = screen.getByLabelText('Text colour') as HTMLInputElement;
    expect(bg.value).toBe(EMBED_THEMES.light.bg);
    expect(text.value).toBe(EMBED_THEMES.light.text);

    fireEvent.input(bg, { target: { value: '#123456' } });
    fireEvent.input(text, { target: { value: '#fedcba' } });

    expect(snippet()).toContain('data-bg="#123456" data-text="#fedcba"');
    expect(snippet()).not.toContain('data-theme');
    expect(preview().getAttribute('data-bg')).toBe('#123456');
    expect(preview().getAttribute('data-text')).toBe('#fedcba');
    expect(preview().hasAttribute('data-theme')).toBe(false);
  });

  it('warns when the custom colours are too close to read', () => {
    render(<EmbedWidgetPanel artistName="Kid Lightbulbs" slug="kid-lightbulbs" links={links} />);
    fireEvent.click(screen.getByRole('button', { name: 'Custom' }));
    expect(screen.queryByRole('status')).toBeNull();

    fireEvent.input(screen.getByLabelText('Text colour'), { target: { value: '#333333' } });
    expect(screen.getByRole('status').textContent).toMatch(/hard to read/);
  });

  it('goes back to a theme without leaving colours in the snippet', () => {
    render(<EmbedWidgetPanel artistName="Kid Lightbulbs" slug="kid-lightbulbs" links={links} />);
    fireEvent.click(screen.getByRole('button', { name: 'Custom' }));
    fireEvent.click(screen.getByRole('button', { name: 'Dark' }));
    expect(snippet()).toContain('data-theme="dark"');
    expect(snippet()).not.toContain('data-bg');
  });

  it('offers each platform the widget can draw once, in page order', () => {
    expect(embeddablePlatforms(links)).toEqual(['bandcamp', 'subvert', 'instagram']);
    render(<EmbedWidgetPanel artistName="Kid Lightbulbs" slug="kid-lightbulbs" links={links} />);
    expect(screen.getAllByRole('checkbox').map((box) => box.closest('label')!.textContent)).toEqual([
      'Bandcamp',
      'Subvert',
      'Instagram',
    ]);
  });

  it('embeds every platform as "all" until one is unticked, then lists the rest', () => {
    render(<EmbedWidgetPanel artistName="Kid Lightbulbs" slug="kid-lightbulbs" links={links} />);
    expect(snippet()).toContain('data-platforms="all"');
    expect(screen.getByText(/including any you add later/)).toBeTruthy();

    fireEvent.click(screen.getByRole('checkbox', { name: 'Subvert' }));
    expect(snippet()).toContain('data-platforms="bandcamp,instagram"');
    expect(preview().getAttribute('data-platforms')).toBe('bandcamp,instagram');
    expect(screen.getByText(/won't appear until you copy a new snippet/)).toBeTruthy();

    fireEvent.click(screen.getByRole('checkbox', { name: 'Subvert' }));
    expect(snippet()).toContain('data-platforms="all"');
  });

  it('will not copy an embed with no platforms in it', () => {
    render(<EmbedWidgetPanel artistName="Kid Lightbulbs" slug="kid-lightbulbs" links={links} />);
    for (const name of ['Bandcamp', 'Subvert', 'Instagram']) {
      fireEvent.click(screen.getByRole('checkbox', { name }));
    }
    expect(screen.getByText('Pick at least one platform to embed.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Copy' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('sets the link style', () => {
    render(<EmbedWidgetPanel artistName="Kid Lightbulbs" slug="kid-lightbulbs" links={links} />);
    expect(snippet()).toContain('data-layout="flexible"');
    fireEvent.click(screen.getByRole('button', { name: 'Icons only' }));
    expect(snippet()).toContain('data-layout="icons"');
    expect(preview().getAttribute('data-layout')).toBe('icons');
  });

  it.each(Object.entries(EMBED_THEMES))('seeds %s with the colours widget.js draws it in', (name, colours) => {
    expect(widgetSource).toContain(`    ${name}: { bg: '${colours.bg}', text: '${colours.text}' },`);
  });
});
