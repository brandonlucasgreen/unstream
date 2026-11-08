// The release page's view count runs as an inline script built from the URL's artist slug, so
// nothing in a slug may be able to end the script element.
import { describe, it, expect } from 'vitest';
import { releaseViewBeaconHtml } from '../../shared/release-view-beacon';

describe('releaseViewBeaconHtml', () => {
  it('posts a release view for the artist', () => {
    const html = releaseViewBeaconHtml('kid-lightbulbs', '11111111-1111-4111-8111-111111111111');
    expect(html).toContain('/api/analytics/event');
    expect(html).toContain('"slug":"kid-lightbulbs"');
    expect(html).toContain('"metric":"release_view:11111111-1111-4111-8111-111111111111"');
    expect(html).toContain('navigator.webdriver');
  });

  it('cannot be closed early by a hostile slug', () => {
    const html = releaseViewBeaconHtml('</script><script>alert(1)</script>', 'x');
    // Exactly one closing tag: the beacon's own.
    expect(html.match(/<\/script>/g)).toHaveLength(1);
    expect(html).not.toContain('<script>alert');
  });
});
