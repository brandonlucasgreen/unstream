import { Header } from '../components/Header';
import { Footer } from '../components/Footer';

export function DevelopersPage() {
  return (
    <div className="min-h-screen flex flex-col bg-white dark:bg-gray-950">
      <Header />
      <main className="flex-1 max-w-4xl mx-auto px-4 py-12 sm:py-16">
        <div className="prose prose-gray dark:prose-invert max-w-none">
          <h1>Unstream API</h1>
          <p className="text-lg text-gray-600 dark:text-gray-400">
            Find your favorite artists on alternative music platforms. Search across 15+ platforms
            including Bandcamp, Mirlo, Qobuz, Beatport, Faircamp, Patreon, and more.
          </p>
          <p>
            <span className="inline-flex items-center rounded-full bg-amber-100 dark:bg-amber-900/30 px-3 py-1 text-sm font-medium text-amber-800 dark:text-amber-200">
              Beta — Available by invitation
            </span>
          </p>

          <h2>Quick Start</h2>
          <ol>
            <li>Get an API key from your account settings (or <a href="mailto:api@unstream.stream">request access</a>)</li>
            <li>Make your first request:</li>
          </ol>
          <div className="not-prose rounded-lg bg-gray-900 p-4 overflow-x-auto">
            <pre className="text-sm text-gray-100">
{`curl "https://unstream.stream/api/v1/search?query=Radiohead" \\
  -H "X-API-Key: usk_your_api_key_here"`}
            </pre>
          </div>
          <p>The response includes results from all platforms, grouped by artist:</p>
          <div className="not-prose rounded-lg bg-gray-900 p-4 overflow-x-auto">
            <pre className="text-sm text-gray-100">
{`{
  "data": {
    "results": [
      {
        "id": "claimed-radiohead",
        "name": "Radiohead",
        "type": "artist",
        "platforms": [
          { "sourceId": "bandcamp", "url": "https://...", "type": "artist" },
          { "sourceId": "mirlo", "url": "https://...", "type": "artist" }
        ]
      }
    ]
  },
  "meta": {
    "api_version": "1",
    "request_id": "550e8400-e29b-41d4-a716-446655440000"
  }
}`}
            </pre>
          </div>

          <h2>Authentication</h2>
          <p>
            Pass your API key via the <code>X-API-Key</code> header:
          </p>
          <div className="not-prose rounded-lg bg-gray-900 p-4 overflow-x-auto">
            <pre className="text-sm text-gray-100">
{`X-API-Key: usk_a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6`}
            </pre>
          </div>
          <p>
            Anonymous requests (without an API key) are allowed from <code>unstream.stream</code> only
            and are rate-limited more aggressively.
          </p>

          <h2>Rate Limits</h2>
          <div className="not-prose overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 dark:border-gray-700">
                  <th className="py-2 pr-4 text-left font-medium text-gray-900 dark:text-gray-100">Tier</th>
                  <th className="py-2 pr-4 text-right font-medium text-gray-900 dark:text-gray-100">Per Minute</th>
                  <th className="py-2 text-right font-medium text-gray-900 dark:text-gray-100">Daily Quota</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                <tr>
                  <td className="py-2 pr-4 text-gray-700 dark:text-gray-300">Anonymous</td>
                  <td className="py-2 pr-4 text-right text-gray-700 dark:text-gray-300">10</td>
                  <td className="py-2 text-right text-gray-700 dark:text-gray-300">500</td>
                </tr>
                <tr>
                  <td className="py-2 pr-4 text-gray-700 dark:text-gray-300">Free</td>
                  <td className="py-2 pr-4 text-right text-gray-700 dark:text-gray-300">30</td>
                  <td className="py-2 text-right text-gray-700 dark:text-gray-300">100</td>
                </tr>
                <tr>
                  <td className="py-2 pr-4 text-gray-700 dark:text-gray-300">Pro</td>
                  <td className="py-2 pr-4 text-right text-gray-700 dark:text-gray-300">100</td>
                  <td className="py-2 text-right text-gray-700 dark:text-gray-300">10,000</td>
                </tr>
                <tr>
                  <td className="py-2 pr-4 text-gray-700 dark:text-gray-300">Internal</td>
                  <td className="py-2 pr-4 text-right text-gray-700 dark:text-gray-300">300</td>
                  <td className="py-2 text-right text-gray-700 dark:text-gray-300">Unlimited</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p>
            Every response includes rate limit headers:
          </p>
          <ul>
            <li><code>X-RateLimit-Limit</code> — Maximum requests in the current window</li>
            <li><code>X-RateLimit-Remaining</code> — Remaining requests</li>
            <li><code>X-RateLimit-Reset</code> — Unix timestamp when the window resets</li>
          </ul>
          <p>
            When rate limited, the API returns a <code>429</code> status with a <code>Retry-After</code> header.
          </p>

          <h2>Endpoints</h2>

          <h3><code>GET /api/v1/search</code></h3>
          <p>Search for an artist across all platforms.</p>
          <div className="not-prose rounded-lg bg-gray-50 dark:bg-gray-900 p-4 overflow-x-auto">
            <pre className="text-sm text-gray-800 dark:text-gray-200">
{`GET /api/v1/search?query=Radiohead

Parameters:
  query (required) — Artist name, max 200 characters`}
            </pre>
          </div>

          <h3><code>GET /api/v1/artist/{'{slug}'}</code></h3>
          <p>Look up an artist by their URL slug.</p>
          <div className="not-prose rounded-lg bg-gray-50 dark:bg-gray-900 p-4 overflow-x-auto">
            <pre className="text-sm text-gray-800 dark:text-gray-200">
{`GET /api/v1/artist/radiohead

Parameters:
  slug (path, required) — URL-safe artist name`}
            </pre>
          </div>

          <h3><code>GET /api/v1/resolve</code></h3>
          <p>Resolve a Spotify or Apple Music URL to an artist name.</p>
          <div className="not-prose rounded-lg bg-gray-50 dark:bg-gray-900 p-4 overflow-x-auto">
            <pre className="text-sm text-gray-800 dark:text-gray-200">
{`GET /api/v1/resolve?url=https://open.spotify.com/artist/4Z8W4fKeB5YxbusRsdQVPb

Parameters:
  url (required) — Spotify or Apple Music URL`}
            </pre>
          </div>

          <h3><code>GET /api/v1/platforms</code></h3>
          <p>List all supported platforms. No authentication required.</p>

          <h3><code>GET /api/v1/status</code></h3>
          <p>Health check. Returns API status and version. No authentication required.</p>

          <h2>API Key Management</h2>
          <p>
            Manage your API keys via these authenticated endpoints (requires Supabase JWT in the
            <code>Authorization</code> header):
          </p>
          <ul>
            <li><code>POST /api/v1/keys</code> — Generate a new key (max 3 per account)</li>
            <li><code>GET /api/v1/keys</code> — List your keys (masked)</li>
            <li><code>DELETE /api/v1/keys</code> — Revoke a key by ID</li>
          </ul>

          <h2>Error Codes</h2>
          <div className="not-prose overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 dark:border-gray-700">
                  <th className="py-2 pr-4 text-left font-medium text-gray-900 dark:text-gray-100">Status</th>
                  <th className="py-2 text-left font-medium text-gray-900 dark:text-gray-100">Meaning</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                <tr>
                  <td className="py-2 pr-4"><code>400</code></td>
                  <td className="py-2 text-gray-700 dark:text-gray-300">Invalid query or missing required parameter</td>
                </tr>
                <tr>
                  <td className="py-2 pr-4"><code>401</code></td>
                  <td className="py-2 text-gray-700 dark:text-gray-300">Authentication required (for key management)</td>
                </tr>
                <tr>
                  <td className="py-2 pr-4"><code>404</code></td>
                  <td className="py-2 text-gray-700 dark:text-gray-300">Artist or resource not found</td>
                </tr>
                <tr>
                  <td className="py-2 pr-4"><code>405</code></td>
                  <td className="py-2 text-gray-700 dark:text-gray-300">Method not allowed</td>
                </tr>
                <tr>
                  <td className="py-2 pr-4"><code>429</code></td>
                  <td className="py-2 text-gray-700 dark:text-gray-300">Rate limit exceeded</td>
                </tr>
                <tr>
                  <td className="py-2 pr-4"><code>500</code></td>
                  <td className="py-2 text-gray-700 dark:text-gray-300">Internal server error</td>
                </tr>
              </tbody>
            </table>
          </div>

          <h2>Response Format</h2>
          <p>All v1 API responses use a consistent envelope:</p>
          <div className="not-prose rounded-lg bg-gray-900 p-4 overflow-x-auto">
            <pre className="text-sm text-gray-100">
{`{
  "data": { /* response payload */ },
  "meta": {
    "api_version": "1",
    "request_id": "uuid",
    "rate_limit": {       // included when authenticated
      "limit": 100,
      "remaining": 95,
      "reset": 1712678400
    }
  }
}`}
            </pre>
          </div>

          <h2>OpenAPI Specification</h2>
          <p>
            The full OpenAPI 3.0 specification is available at{' '}
            <a href="https://unstream.stream/docs/openapi.yaml">
              /docs/openapi.yaml
            </a>.
          </p>

          <h2>Support</h2>
          <p>
            Questions or issues? Reach us at <a href="mailto:api@unstream.stream">api@unstream.stream</a>.
          </p>
        </div>
      </main>
      <Footer />
    </div>
  );
}