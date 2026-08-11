-- Migration: bandcamp_connections, collection_items, listening_signals
--
-- Applied to production ahead of the PR merge (workflow_dispatch, 2026-08-09) so the
-- deploy preview — which shares the production database — could exercise the connect
-- flow. Purely additive, so the early application is the safe side of the
-- migration/deploy race.
--
-- The Support Loop, Step 1 (docs: support-loop-spec.md, collection-spec.md §4–5).
-- Three tables:
--
--   bandcamp_connections  one row per user who connected their Bandcamp collection via
--                         Bandcamp's Subsonic API (open beta, shipped 2026-07-16)
--   collection_items      releases a user actually acquired — the public collection
--   listening_signals     streaming-side play counts (Apple Music, Last.fm, the Mac app's
--                         now-playing monitor). Feeds the private "gap" report. Schema lands
--                         now so Steps 2 and 5 have a landing zone; nothing writes it yet.
--
-- The gap itself (artists you play a lot and never paid) is DERIVED at read time from
-- listening_signals minus collection_items minus supported_artists — deliberately not
-- stored, so it can't go stale.

-- ---------------------------------------------------------------------------
-- bandcamp_connections
-- ---------------------------------------------------------------------------

-- Credential handling: Subsonic auth is username + token, not OAuth, so this table holds
-- the keys to someone's Bandcamp account. What is stored is the salted-token form
-- (t = md5(password + salt), plus the salt) — the plaintext password is derived from and
-- discarded during the connect request and never persisted. The (t, s) pair is encrypted
-- with AES-256-GCM before it reaches this table; the key lives ONLY in the Netlify env var
-- BANDCAMP_CREDENTIAL_KEY (see api/functions/credential-crypto.ts for why app-level
-- encryption was chosen over pgcrypto and Supabase Vault: the key must never appear in SQL
-- text or share a trust domain with the ciphertext). A leak of this table alone reveals
-- nothing usable.

CREATE TABLE IF NOT EXISTS bandcamp_connections (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  bandcamp_username text NOT NULL,

  -- base64(iv) || '.' || base64(authTag) || '.' || base64(ciphertext); ciphertext is the
  -- JSON {"t": ..., "s": ...}. Encrypted/decrypted only in api/functions/credential-crypto.ts.
  credential_ciphertext text NOT NULL,

  sync_status text NOT NULL DEFAULT 'idle'
    CHECK (sync_status IN ('idle', 'syncing', 'error')),

  -- Human-readable failure summary for the settings page. Never contains credentials.
  sync_error text,

  -- Items imported by the last successful sync. NULL until one completes.
  item_count integer CHECK (item_count IS NULL OR item_count >= 0),
  last_synced_at timestamptz,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS trg_bandcamp_connections_updated_at ON bandcamp_connections;
CREATE TRIGGER trg_bandcamp_connections_updated_at
  BEFORE UPDATE ON bandcamp_connections
  FOR EACH ROW
  EXECUTE FUNCTION set_releases_updated_at();

-- Server-only table: RLS enabled with NO policies, deliberately (same shape as
-- bandcamp_slug_probes). Even the owner's own session must not read the ciphertext through
-- PostgREST — all access goes through me-bandcamp.ts / bandcamp-sync-background.ts using
-- the service-role client, which return status fields but never the credential.
ALTER TABLE bandcamp_connections ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE bandcamp_connections IS
  'One row per user with a connected Bandcamp collection (Subsonic beta). Credential is AES-256-GCM-encrypted with a key held only in Netlify env. Server-only: RLS with no policies is deliberate.';

-- ---------------------------------------------------------------------------
-- collection_items
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS collection_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Matched Unstream release where one exists. Nullable on purpose: an unmatched import
  -- still appears in the collection rather than vanishing, rendered from the denormalised
  -- fields below.
  release_id uuid REFERENCES releases(id) ON DELETE SET NULL,

  source text NOT NULL CHECK (source IN ('bandcamp', 'discogs', 'manual')),

  -- The source's own stable id (Subsonic album id for Bandcamp). What makes re-sync
  -- idempotent: upserts key on (user_id, source, external_id) instead of minting duplicates.
  external_id text,

  -- Denormalised so an unmatched item still renders.
  title text NOT NULL,
  artist_name text NOT NULL,
  art_url text,

  acquired_at timestamptz,

  -- The load-bearing distinction (collection-spec.md §5). Only 'purchased' ever appears on
  -- the public collection page; 'owned' and 'listened' feed the private gap report.
  -- Conflating these would make the page lie about support. Everything from the Bandcamp
  -- import is 'purchased' — a Bandcamp collection is proof of purchase.
  provenance text NOT NULL CHECK (provenance IN ('purchased', 'owned', 'listened')),

  -- Paid vs free-download vs unknown. Bandcamp's Subsonic API doesn't say, so imports are
  -- 'unknown' until a source can tell us.
  acquisition text NOT NULL DEFAULT 'unknown'
    CHECK (acquisition IN ('purchased', 'free', 'unknown')),

  -- Per-item hide from the public page. The owner still sees hidden items.
  hidden boolean NOT NULL DEFAULT false,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  -- Re-sync updates rather than duplicates: imports upsert on these three columns.
  -- A plain constraint, not a partial index, because PostgREST's upsert emits
  -- ON CONFLICT (cols) without a WHERE clause and so can't target a partial index.
  -- Manual items (external_id NULL) never collide — Postgres treats NULLs as distinct.
  UNIQUE (user_id, source, external_id)
);

DROP TRIGGER IF EXISTS trg_collection_items_updated_at ON collection_items;
CREATE TRIGGER trg_collection_items_updated_at
  BEFORE UPDATE ON collection_items
  FOR EACH ROW
  EXECUTE FUNCTION set_releases_updated_at();

-- The page read: one user's collection, most recently acquired first.
CREATE INDEX IF NOT EXISTS idx_collection_items_user_chrono
  ON collection_items (user_id, acquired_at DESC NULLS LAST, created_at DESC);

ALTER TABLE collection_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own collection items" ON collection_items;
DROP POLICY IF EXISTS "Users can update own collection items" ON collection_items;
DROP POLICY IF EXISTS "Users can delete own collection items" ON collection_items;

CREATE POLICY "Users can view own collection items"
  ON collection_items FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can update own collection items"
  ON collection_items FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own collection items"
  ON collection_items FOR DELETE
  USING (auth.uid() = user_id);

-- No INSERT policy, deliberately: rows are written only by server code (imports, and later
-- a manual-add endpoint) through the service-role client, which is what keeps provenance
-- honest — a client that could insert its own rows could mark anything 'purchased'.

COMMENT ON TABLE collection_items IS
  'Releases a user actually acquired. provenance gates the public page: only purchased is ever public. Inserts are service-role only so provenance stays honest.';

-- ---------------------------------------------------------------------------
-- listening_signals
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS listening_signals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  artist_name text NOT NULL,

  source text NOT NULL CHECK (source IN ('apple_music', 'lastfm', 'mac_app')),

  play_count integer NOT NULL DEFAULT 0 CHECK (play_count >= 0),
  last_played timestamptz,
  synced_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (user_id, source, artist_name)
);

CREATE INDEX IF NOT EXISTS idx_listening_signals_user
  ON listening_signals (user_id, play_count DESC);

ALTER TABLE listening_signals ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own listening signals" ON listening_signals;
DROP POLICY IF EXISTS "Users can delete own listening signals" ON listening_signals;

CREATE POLICY "Users can view own listening signals"
  ON listening_signals FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own listening signals"
  ON listening_signals FOR DELETE
  USING (auth.uid() = user_id);

-- No INSERT/UPDATE policies: writes come from server sync endpoints via the service-role
-- client. The gap report derived from this table is private to the owner — nothing here is
-- ever rendered publicly.

COMMENT ON TABLE listening_signals IS
  'Streaming-side play counts per (user, source, artist). Feeds the private gap report; never public. Written by server sync code only.';
