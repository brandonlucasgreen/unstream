// @vitest-environment jsdom
//
// The extension's fallback playback signal for sites that publish Media Session metadata but
// never set playbackState and play through audio that isn't in the DOM (xpn.org's live radio
// player). Content scripts are plain IIFEs, not modules, so the real common.js is evaluated
// into the jsdom window and read back from window.Unstream.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

const COMMON_JS = readFileSync(
  resolve(__dirname, '../../../../apps/extension/content/common.js'),
  'utf8'
);

type Track = { artist?: string; title?: string } | null;

interface UnstreamGlobal {
  createMetadataPlaybackSignal: () => { isPlaying: () => boolean; noteElementPlaying: () => void };
}

const mediaSession = {
  metadata: null as Track,
  playbackState: 'none' as 'none' | 'paused' | 'playing',
};

function setTrack(track: Track) {
  mediaSession.metadata = track;
}

function loadUnstream(): UnstreamGlobal {
  new Function(COMMON_JS).call(window);
  return (window as unknown as { Unstream: UnstreamGlobal }).Unstream;
}

beforeEach(() => {
  mediaSession.metadata = null;
  mediaSession.playbackState = 'none';
  Object.defineProperty(navigator, 'mediaSession', { value: mediaSession, configurable: true });
});

describe('createMetadataPlaybackSignal', () => {
  it('treats the first track published after load as playing', () => {
    const signal = loadUnstream().createMetadataPlaybackSignal();
    expect(signal.isPlaying()).toBe(false);

    setTrack({ artist: 'Gorillaz', title: 'Clint Eastwood' });
    expect(signal.isPlaying()).toBe(true);
  });

  it('ignores metadata already present at load until the track changes', () => {
    // Some players fill metadata from the on-air feed before the listener presses play.
    setTrack({ artist: 'Gorillaz', title: 'Clint Eastwood' });
    const signal = loadUnstream().createMetadataPlaybackSignal();
    expect(signal.isPlaying()).toBe(false);

    setTrack({ artist: 'Wet Leg', title: 'Chaise Longue' });
    expect(signal.isPlaying()).toBe(true);
  });

  it('stays latched across later tracks, and stops when metadata is cleared', () => {
    const signal = loadUnstream().createMetadataPlaybackSignal();
    setTrack({ artist: 'Gorillaz', title: 'Clint Eastwood' });
    expect(signal.isPlaying()).toBe(true);

    setTrack({ artist: 'Wet Leg', title: 'Chaise Longue' });
    expect(signal.isPlaying()).toBe(true);

    setTrack(null);
    expect(signal.isPlaying()).toBe(false);
  });

  it('never fires for sites that set playbackState themselves', () => {
    const signal = loadUnstream().createMetadataPlaybackSignal();
    mediaSession.playbackState = 'paused';
    setTrack({ artist: 'Gorillaz', title: 'Clint Eastwood' });
    expect(signal.isPlaying()).toBe(false);
  });

  it('turns off once a DOM media element has been seen playing', () => {
    const signal = loadUnstream().createMetadataPlaybackSignal();
    signal.noteElementPlaying();
    setTrack({ artist: 'Gorillaz', title: 'Clint Eastwood' });
    expect(signal.isPlaying()).toBe(false);
  });

  it('requires both artist and title', () => {
    const signal = loadUnstream().createMetadataPlaybackSignal();
    setTrack({ title: 'Clint Eastwood' });
    expect(signal.isPlaying()).toBe(false);
  });
});
