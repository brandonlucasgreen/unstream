import { createClient } from '@supabase/supabase-js';

export async function handler() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

  if (!supabaseUrl || !supabaseKey) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Server configuration error' }) };
  }

  const supabase = createClient(supabaseUrl, supabaseKey);

  // Fetch all verified (claimed) artist profiles
  const { data: profiles, error: profileError } = await supabase
    .from('artist_profiles')
    .select('artist_id')
    .not('verified_at', 'is', null);

  if (profileError || !profiles || profiles.length === 0) {
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300, s-maxage=300' },
      body: JSON.stringify({ artists: [] }),
    };
  }

  // Fetch artist details
  const artistIds = profiles.map(p => p.artist_id);
  const { data: artistRows, error: artistError } = await supabase
    .from('artists')
    .select('id, name, slug, image_url')
    .in('id', artistIds);

  if (artistError) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Failed to fetch artists' }) };
  }

  const artists = (artistRows || [])
    .map(a => ({
      slug: a.slug,
      name: a.name,
      imageUrl: a.image_url || null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=300, s-maxage=300',
    },
    body: JSON.stringify({ artists }),
  };
}
