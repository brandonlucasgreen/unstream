import { describe, it, expect } from 'vitest';
import { safeNextPath } from 'src/utils/safeNextPath';

const ORIGIN = 'https://unstream.stream';

describe('safeNextPath', () => {
  it('keeps a path on this site, with its query', () => {
    expect(safeNextPath('/tip/thanks?artist=a&session_id=cs_test_x', ORIGIN)).toBe('/tip/thanks?artist=a&session_id=cs_test_x');
  });

  it.each([
    ['//evil.example/path'],
    ['/\\evil.example'],
    ['https://evil.example/'],
    ['javascript:alert(1)'],
    ['tip/thanks'],
    [''],
    [null],
  ])('refuses %s', raw => {
    expect(safeNextPath(raw, ORIGIN)).toBeNull();
  });
});
