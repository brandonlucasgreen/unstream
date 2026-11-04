// @vitest-environment jsdom
// The campaign editor (components/CampaignEditor.tsx): what its calendar shows, and what moving
// release day does, for a campaign counting down to release and for one planned once it was out.
// The second kind once showed a year of empty weeks and no posts, and moved every post when its
// release date was corrected (code review, 2026-11-03).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { CampaignEditor } from 'src/components/CampaignEditor';
import type { CampaignPostDraft } from 'src/services/promote';

const release = {
  id: 'r1', title: 'Luminaires', slug: 'luminaires', releaseType: 'album', releaseDate: '2025-10-23',
  datePrecision: 'day', status: 'released' as const, artworkUrl: null, onBandcamp: true,
  template: { title: 'Luminaires', slug: 'luminaires', releaseType: 'album', releaseDate: '2025-10-23', datePrecision: 'day', sources: [{ platform: 'bandcamp', offers: [] }] },
};
const post = (date: string, over: Partial<CampaignPostDraft> = {}): CampaignPostDraft => ({ step: 'custom', date, text: '{title}', imageKey: null, ...over });

function renderEditor(props: { releaseDate: string; anchoredToRelease: boolean; posts: CampaignPostDraft[]; today?: string }) {
  const onChange = vi.fn();
  render(
    <CampaignEditor
      release={release}
      releaseDate={props.releaseDate}
      anchoredToRelease={props.anchoredToRelease}
      posts={props.posts}
      autopost={[]}
      today={props.today ?? '2026-11-03'}
      services={['bluesky']}
      images={[]}
      artist={{ name: 'Kid Lightbulbs', slug: 'kid-lightbulbs' }}
      onChange={onChange}
    />,
  );
  return onChange;
}

/** The calendar's days that are campaign posts, by their accessible names. */
const campaignDays = () => screen.getAllByRole('listitem').filter(li => /campaign post/.test(li.getAttribute('aria-label') ?? ''));

afterEach(cleanup);

describe('CampaignEditor, for a release already out', () => {
  const out = { releaseDate: '2025-10-23', anchoredToRelease: false, posts: [post('2026-11-04'), post('2026-11-13'), post('2026-11-21'), post('2026-11-30')] };

  it('draws the posts’ own weeks, not the weeks since a release a year ago', () => {
    renderEditor(out);
    expect(campaignDays()).toHaveLength(4);
    expect(screen.queryByText('Release day')).toBeNull();
  });

  it('keeps every post’s date when the release date is corrected', () => {
    const onChange = renderEditor(out);
    fireEvent.change(screen.getByLabelText(/^Release date/), { target: { value: '2024-10-23' } });
    expect(onChange).toHaveBeenCalledWith({ releaseDate: '2024-10-23', posts: out.posts });
  });
});

describe('CampaignEditor, for a campaign counting down to release', () => {
  const countdown = {
    releaseDate: '2026-12-04',
    anchoredToRelease: true,
    posts: [post('2026-11-06'), post('2026-12-04'), post('2026-11-10', { id: 'sent', status: 'pushed' })],
  };

  it('marks release day among the posts', () => {
    renderEditor(countdown);
    expect(campaignDays()).toHaveLength(3);
    expect(screen.getByText('Release day')).toBeTruthy();
  });

  it('moves the posts not yet in Buffer with release day, and leaves a sent one', () => {
    const onChange = renderEditor(countdown);
    fireEvent.change(screen.getByLabelText(/^Release date/), { target: { value: '2026-12-11' } });
    const { posts } = onChange.mock.calls[0][0] as { posts: CampaignPostDraft[] };
    expect(posts.map(p => p.date)).toEqual(['2026-11-13', '2026-12-11', '2026-11-10']);
  });
});

describe('CampaignEditor, adding a post', () => {
  it('never offers a day that has passed, even after a post sent long ago', () => {
    const onChange = renderEditor({
      releaseDate: '2026-09-04', anchoredToRelease: true, today: '2026-11-03',
      posts: [post('2026-09-04', { id: 'sent', status: 'pushed' })],
    });
    fireEvent.click(screen.getByRole('button', { name: '+ Add a post' }));
    const { posts } = onChange.mock.calls[0][0] as { posts: CampaignPostDraft[] };
    expect(posts.at(-1)!.date).toBe('2026-11-04');
  });
});
