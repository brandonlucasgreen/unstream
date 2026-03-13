import { createClient } from '@supabase/supabase-js';

export async function handler() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

  if (!supabaseUrl || !supabaseKey) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Server configuration error' }) };
  }

  const supabase = createClient(supabaseUrl, supabaseKey);

  // Fetch all verified (claimed) artists
  const { data: profiles, error } = await supabase
    .from('artist_profiles')
    .select('slug, artists!inner(name, image_url)')
    .not('verified_at', 'is', null);

  if (error) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Failed to fetch artists' }) };
  }

  const artists = (profiles || []).map((p: Record<string, unknown>) => {
    const artist = p.artists as Record<string, unknown>;
    return {
      slug: p.slug,
      name: artist?.name || p.slug,
      imageUrl: artist?.image_url || null,
    };
  }).sort((a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name));

  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=300, s-maxage=300',
    },
    body: JSON.stringify({ artists }),
  };
}
