import { describe, it, expect } from 'vitest';

import { decodePathSegment } from '../../shared/path-segments';
import { parsePath } from '../feed-releases';

/**
 * `decodeURIComponent` throws URIError on a malformed escape, and these decodes happen in code
 * that runs *before* anything is looked up — so an unhandled one turns a crafted URL into a 500
 * from an endpoint that never reached the database. `/u/bad%zz/releases.xml` did exactly that.
 *
 * A segment that can't be decoded can't be a slug we minted, so the right answer is "no such
 * thing" and the caller's 404.
 */
describe('decodePathSegment', () => {
  it('decodes a well-formed segment', () => {
    expect(decodePathSegment('caf%C3%A9')).toBe('café');
    expect(decodePathSegment('mono')).toBe('mono');
  });

  it.each(['bad%zz', '%', '%E0%A4%A', 'a%'])('returns null for the malformed segment %s', (segment) => {
    expect(decodePathSegment(segment)).toBeNull();
  });

  it('returns null for nothing at all', () => {
    expect(decodePathSegment(undefined)).toBeNull();
    expect(decodePathSegment(null)).toBeNull();
    expect(decodePathSegment('')).toBeNull();
  });

  it('never throws, whatever it is handed', () => {
    for (const segment of ['%%%', '%1', '%G0', '100%', '%C0%80']) {
      expect(() => decodePathSegment(segment)).not.toThrow();
    }
  });
});

describe('feed paths with a malformed escape are no feed, not an error', () => {
  it.each([
    '/u/bad%zz/releases.xml',
    '/u/%/releases.ics',
    '/a/bad%zz/releases.xml',
    '/a/%E0%A4%A/releases.ics',
  ])('%s parses as no route instead of throwing', (path) => {
    expect(() => parsePath(path)).not.toThrow();
    expect(parsePath(path)).toBeNull();
  });

  it('still parses the handle and artist feeds it is there for', () => {
    expect(parsePath('/u/brandon/releases.xml')).toEqual({ kind: 'handle', handle: 'brandon', format: 'xml' });
    expect(parsePath('/a/mono/releases.ics')).toEqual({ kind: 'artist', slug: 'mono', format: 'ics' });
  });

  it('still decodes an accented handle, which is why the decode is there at all', () => {
    expect(parsePath('/u/caf%C3%A9/releases.xml')).toEqual({ kind: 'handle', handle: 'café', format: 'xml' });
  });

  it('leaves the private token path alone — it is not percent-decoded', () => {
    expect(parsePath('/feed/f/abc123.ics')).toEqual({ kind: 'token', token: 'abc123', format: 'ics' });
  });
});
