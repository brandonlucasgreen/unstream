// @vitest-environment jsdom
//
// The extension's YouTube detection. On youtube.com, Media Session metadata publishes the
// channel name as `artist` for every video, so taking it as-is sent podcasts, weather reports
// and gaming channels to search as artists, and topic/VEVO channels with their suffix still on.
// The content script is a plain IIFE, so it is evaluated into the jsdom window against a stub
// of window.Unstream that hands back its getNowPlaying.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

const YOUTUBE_JS = readFileSync(
  resolve(__dirname, '../../../../apps/extension/content/youtube.js'),
  'utf8'
);

type Track = { artist: string; title: string } | null;

let mediaSessionTrack: Track = null;

function loadGetNowPlaying(): () => Track {
  let getNowPlaying: (() => Track) | null = null;
  (window as unknown as { Unstream: unknown }).Unstream = {
    getFromMediaSession: () => mediaSessionTrack,
    createPoller: (opts: { getNowPlaying: () => Track }) => {
      getNowPlaying = opts.getNowPlaying;
      return { reset() {}, poll() {}, stop() {} };
    },
  };
  new Function(YOUTUBE_JS).call(window);
  if (!getNowPlaying) throw new Error('youtube.js did not create a poller');
  return getNowPlaying;
}

function setMusicCategory(on: boolean) {
  document.head.innerHTML = on ? '<meta itemprop="genre" content="Music">' : '';
}

beforeEach(() => {
  mediaSessionTrack = null;
  document.head.innerHTML = '';
  document.body.innerHTML = '';
});

describe('YouTube detection from Media Session metadata', () => {
  it('ignores a video that is not music', () => {
    mediaSessionTrack = { artist: 'Met Office - UK Weather', title: 'UK weather forecast for the week ahead' };
    expect(loadGetNowPlaying()()).toBeNull();
  });

  it('takes the artist from a music video title rather than the uploading channel', () => {
    mediaSessionTrack = { artist: 'Roadrunner Records', title: 'Gojira - Silvera (Official Music Video)' };
    expect(loadGetNowPlaying()()).toEqual({ artist: 'Gojira', title: 'Silvera' });
  });

  it('uses a topic channel as the artist, without its suffix', () => {
    mediaSessionTrack = { artist: 'Anthrax - Topic', title: 'Madhouse' };
    expect(loadGetNowPlaying()()).toEqual({ artist: 'Anthrax', title: 'Madhouse' });
  });

  it('drops VEVO from the channel name of a music-category video', () => {
    setMusicCategory(true);
    mediaSessionTrack = { artist: 'FaithlessVEVO', title: 'Insomnia' };
    expect(loadGetNowPlaying()()).toEqual({ artist: 'Faithless', title: 'Insomnia' });
  });
});
