import type { AutopostKind } from '../../../../api/shared/autopost-templates';

/** What each kind of autopost is called, and when it goes out, as the Promote page words it. */
export const KIND_COPY: Record<AutopostKind, { label: string; when: string }> = {
  bandcamp_friday: { label: 'Bandcamp Friday', when: 'On Bandcamp Fridays, about your newest release there.' },
  release_day: { label: 'Release day', when: 'On the day a new release comes out, if Unstream finds it before then.' },
  preorder: { label: 'Pre-order', when: 'Once, when a new release is announced at least three days ahead.' },
  out_now: { label: 'Out now', when: 'For a new release Unstream only finds after its release day.' },
  still_new: { label: 'Still new', when: 'A release in its first six weeks, at most every other post.' },
  catalogue: { label: 'From the archives', when: 'Everything else: your releases in turn, so nothing repeats too soon.' },
  support: { label: 'Ways to support you', when: 'About once a month, or one post in four at three or more a week. Uses your asset library’s images.' },
};
