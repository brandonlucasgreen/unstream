import { describe, it, expect } from 'vitest';
import { handler } from '../../../../api/functions/search-sources';
import type { SearchResponse, AggregatedResult } from '../../../../api/functions/search-utils';
import fixtures from '../fixtures/expected-results.json';

interface ResultAssertion {
  name?: string;
  nameContains?: string;
  requiredPlatforms?: string[];
  urlPatterns?: Record<string, string>;
}

interface DisambiguationAssertion {
  description: string;
  minDistinctBandcampUrls?: number;
}

interface TestFixture {
  query: string;
  assertions: {
    minResults?: number;
    maxResults?: number;
    expectError?: boolean;
    statusCode?: number;
    results?: ResultAssertion[];
    disambiguation?: DisambiguationAssertion;
  };
}

async function search(query: string): Promise<{ statusCode: number; body: SearchResponse | { error: string } }> {
  const response = await handler({ queryStringParameters: { query } });
  return {
    statusCode: response.statusCode,
    body: JSON.parse(response.body),
  };
}

function findResult(results: AggregatedResult[], assertion: ResultAssertion): AggregatedResult | undefined {
  return results.find(r => {
    if (assertion.name && r.name !== assertion.name) return false;
    if (assertion.nameContains && !r.name.toLowerCase().includes(assertion.nameContains.toLowerCase())) return false;
    return true;
  });
}

describe('Search accuracy (live API)', () => {
  const testFixtures = fixtures as TestFixture[];

  for (const fixture of testFixtures) {
    const label = fixture.query || '(empty query)';

    describe(`"${label}"`, () => {
      if (fixture.assertions.expectError) {
        it(`returns status ${fixture.assertions.statusCode}`, async () => {
          const { statusCode } = await search(fixture.query);
          expect(statusCode).toBe(fixture.assertions.statusCode);
        });
        return;
      }

      it('returns results within expected range', async () => {
        const { statusCode, body } = await search(fixture.query);
        expect(statusCode).toBe(200);

        const results = (body as SearchResponse).results;

        if (fixture.assertions.minResults !== undefined) {
          expect(results.length).toBeGreaterThanOrEqual(fixture.assertions.minResults);
        }
        if (fixture.assertions.maxResults !== undefined) {
          expect(results.length).toBeLessThanOrEqual(fixture.assertions.maxResults);
        }
      });

      if (fixture.assertions.results) {
        for (const resultAssertion of fixture.assertions.results) {
          const resultLabel = resultAssertion.name || resultAssertion.nameContains || 'result';

          it(`finds "${resultLabel}" with required platforms`, async () => {
            const { body } = await search(fixture.query);
            const results = (body as SearchResponse).results;
            const result = findResult(results, resultAssertion);

            expect(result, `Expected to find result matching "${resultLabel}"`).toBeDefined();

            if (resultAssertion.requiredPlatforms) {
              const platformIds = result!.platforms.map(p => p.sourceId);
              for (const platform of resultAssertion.requiredPlatforms) {
                expect(platformIds, `Expected "${resultLabel}" to have platform "${platform}"`).toContain(platform);
              }
            }

            if (resultAssertion.urlPatterns) {
              for (const [platform, pattern] of Object.entries(resultAssertion.urlPatterns)) {
                const platformLink = result!.platforms.find(p => p.sourceId === platform);
                expect(platformLink, `Expected "${resultLabel}" to have "${platform}" link`).toBeDefined();
                expect(platformLink!.url).toContain(pattern);
              }
            }
          });
        }
      }

      if (fixture.assertions.disambiguation) {
        const disambig = fixture.assertions.disambiguation;

        it(`disambiguates: ${disambig.description}`, async () => {
          const { body } = await search(fixture.query);
          const results = (body as SearchResponse).results;

          if (disambig.minDistinctBandcampUrls) {
            const bandcampUrls = new Set<string>();
            for (const result of results) {
              for (const p of result.platforms) {
                if (p.sourceId === 'bandcamp') bandcampUrls.add(p.url);
              }
            }
            expect(
              bandcampUrls.size,
              `Expected at least ${disambig.minDistinctBandcampUrls} distinct Bandcamp URLs, got ${bandcampUrls.size}: ${[...bandcampUrls].join(', ')}`
            ).toBeGreaterThanOrEqual(disambig.minDistinctBandcampUrls);
          }
        });
      }
    });
  }
});
