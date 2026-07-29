/**
 * One-time migration script: lift latest_release jsonb data from artist_links
 * into the new artist_releases + release_links tables.
 *
 * Run with: npx tsx scripts/migrate-releases.ts
 *
 * Idempotent — safe to run multiple times. Uses upsert with conflict targets
 * so existing rows are updated rather than duplicated.
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { mapReleaseType, releaseSlugWithCollision, isStreamingPlatform, normalizeReleaseTitle } from '../api/functions/release-utils';

// ── Types matching the jsonb shape on artist_links.latest_release ──────────

interface LatestReleaseJsonb {
  title: string;
  type: 'album' | 'track';
  url: string;
  imageUrl?: string;
  releaseDate?: string;
}

interface ArtistLinkRow {
  id: string;
  artist_id: string;
  platform: string;
  url: string;
  latest_release: LatestReleaseJsonb | null;
}

interface ArtistRow {
  id: string;
  slug: string;
  name: string;
}

// ── Slug generation (matches db.ts artistSlug) ────────────────────────────
// Now uses shared releaseSlug from release-utils.ts.

// ── Dedup key: normalized title for matching across platforms ─────────────
// Uses the shared normalizeReleaseTitle (includes .trim()) to avoid
// normalization drift between this migration and the live pipeline in db.ts.

// ── Main migration ────────────────────────────────────────────────────────

async function main() {
  // NOTE: This script requires SUPABASE_SERVICE_KEY, which bypasses RLS.
  // Run it only locally or in CI with the key injected via a secret store.
  // Never pass it via shell arguments or commit it to shell history.
  // Example: `SUPABASE_SERVICE_KEY=... npx tsx scripts/migrate-releases.ts`
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

  if (!supabaseUrl || !supabaseKey) {
    console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY environment variables.');
    process.exit(1);
  }

  const client: SupabaseClient = createClient(supabaseUrl, supabaseKey);

  console.log('Fetching artist_links with latest_release data...');

  // Fetch all artist_links that have a latest_release jsonb
  const { data: links, error } = await client
    .from('artist_links')
    .select('id, artist_id, platform, url, latest_release')
    .not('latest_release', 'is', null);

  if (error) {
    console.error('Failed to fetch artist_links:', error);
    process.exit(1);
  }

  if (!links || links.length === 0) {
    console.log('No artist_links with latest_release data found. Nothing to migrate.');
    return;
  }

  console.log(`Found ${links.length} artist_links with latest_release data.`);

  // Fetch all artists in one go (we need names for slug generation)
  const artistIds = [...new Set(links.map(l => (l as ArtistLinkRow).artist_id))];
  const { data: artists, error: artistError } = await client
    .from('artists')
    .select('id, slug, name')
    .in('id', artistIds);

  if (artistError) {
    console.error('Failed to fetch artists:', artistError);
    process.exit(1);
  }

  const artistMap = new Map<string, ArtistRow>(
    (artists as ArtistRow[]).map(a => [a.id, a])
  );

  // Group links by artist_id so we can deduplicate releases per artist
  const linksByArtist = new Map<string, ArtistLinkRow[]>();
  for (const link of links as ArtistLinkRow[]) {
    const existing = linksByArtist.get(link.artist_id) || [];
    existing.push(link);
    linksByArtist.set(link.artist_id, existing);
  }

  let totalReleases = 0;
  let totalReleaseLinks = 0;
  let conflicts: string[] = [];

  for (const [artistId, artistLinks] of linksByArtist) {
    const artist = artistMap.get(artistId);
    if (!artist) {
      conflicts.push(`Artist ${artistId} not found in artists table — skipping ${artistLinks.length} links`);
      continue;
    }

    // Deduplicate releases within this artist:
    // Multiple platforms may have the same release (e.g. Bandcamp + Mirlo).
    // Match by normalized title. Each unique title → one artist_releases row.
    const releasesByNormTitle = new Map<string, { title: string; type: 'album' | 'track'; links: ArtistLinkRow[] }>();

    for (const link of artistLinks) {
      const lr = link.latest_release;
      if (!lr || !lr.title) continue;

      const normTitle = normalizeReleaseTitle(lr.title);
      if (!normTitle) continue;

      const existing = releasesByNormTitle.get(normTitle);
      if (existing) {
        // Same release on another platform — add the link
        existing.links.push(link);
        // Prefer 'album' type if any platform says album (more specific than 'track')
        if (lr.type === 'album' && existing.type === 'track') {
          existing.type = 'album';
        }
      } else {
        releasesByNormTitle.set(normTitle, {
          title: lr.title,
          type: lr.type,
          links: [link],
        });
      }
    }

    // Insert releases and their links
    // Fetch existing slugs for this artist to detect collisions (issue #3).
    const { data: existingReleases } = await client
      .from('artist_releases')
      .select('slug,title')
      .eq('artist_id', artistId);
    const existingTitlesBySlug = new Map<string, string>(
      (existingReleases || []).map((r: { slug: string; title: string }) => [r.slug, r.title])
    );

    for (const { title, type, links: releaseLinks } of releasesByNormTitle.values()) {
      const slug = releaseSlugWithCollision(title, existingTitlesBySlug);
      const releaseType = mapReleaseType(type);

      // Extract the best artwork URL and release date from the links
      const artworkUrl = releaseLinks.find(l => l.latest_release?.imageUrl)?.latest_release?.imageUrl || null;
      const releaseDate = releaseLinks.find(l => l.latest_release?.releaseDate)?.latest_release?.releaseDate || null;

      // Parse release date to YYYY-MM-DD if possible
      let parsedDate: string | null = null;
      if (releaseDate) {
        // Try ISO format
        if (/^\d{4}-\d{2}-\d{2}/.test(releaseDate)) {
          parsedDate = releaseDate.split('T')[0];
        } else {
          // Try human-readable: "December 6, 2024" or "Dec 6, 2024"
          const match = releaseDate.match(/(\w+)\s+(\d{1,2}),?\s+(\d{4})/);
          if (match) {
            const date = new Date(`${match[1]} ${match[2]}, ${match[3]}`);
            if (!isNaN(date.getTime())) {
              parsedDate = date.toISOString().split('T')[0];
            }
          }
          // Try "DD MMM YYYY" format
          if (!parsedDate) {
            const match2 = releaseDate.match(/(\d{1,2})\s+(\w+)\s+(\d{4})/);
            if (match2) {
              const date = new Date(`${match2[2]} ${match2[1]}, ${match2[3]}`);
              if (!isNaN(date.getTime())) {
                parsedDate = date.toISOString().split('T')[0];
              }
            }
          }
        }
      }

      // Upsert the release
      const { data: release, error: releaseError } = await client
        .from('artist_releases')
        .upsert(
          {
            artist_id: artistId,
            title,
            slug,
            release_type: releaseType,
            release_date: parsedDate,
            artwork_url: artworkUrl,
            source: 'auto',
          },
          { onConflict: 'artist_id,slug' }
        )
        .select('id')
        .single();

      if (releaseError || !release) {
        const msg = `Failed to upsert release "${title}" for artist "${artist.name}": ${releaseError?.message || 'unknown'}`;
        console.error(msg);
        conflicts.push(msg);
        continue;
      }

      totalReleases++;
      const releaseId = release.id;

      // Insert release links for each platform
      for (const link of releaseLinks) {
        const lr = link.latest_release!;
        const platform = link.platform;
        // Skip links where the release-specific URL is missing — a release link
        // pointing to the artist's profile page is worse than no link (issue #5).
        if (!lr.url) continue;
        const url = lr.url;

        const { error: linkError } = await client
          .from('release_links')
          .upsert(
            {
              release_id: releaseId,
              platform,
              url,
              is_streaming: isStreamingPlatform(platform),
              // 'source' is 'auto' vs 'claimed' per spec. Platform name goes in
              // the 'platform' column, not 'source' (issue #4).
              source: 'auto',
            },
            { onConflict: 'release_id,platform' }
          );

        if (linkError) {
          const msg = `Failed to upsert release_link for "${title}" platform "${platform}": ${linkError.message}`;
          console.error(msg);
          conflicts.push(msg);
        } else {
          totalReleaseLinks++;
        }
      }
    }
  }

  console.log('');
  console.log('── Migration complete ──');
  console.log(`Artists processed: ${linksByArtist.size}`);
  console.log(`Releases created/updated: ${totalReleases}`);
  console.log(`Release links created/updated: ${totalReleaseLinks}`);
  if (conflicts.length > 0) {
    console.log('');
    console.log(`Conflicts (${conflicts.length}):`);
    for (const c of conflicts) {
      console.log(`  - ${c}`);
    }
  }
}

main().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});