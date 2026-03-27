/**
 * Manage artist merge overrides in Supabase.
 *
 * Usage:
 *   npx tsx scripts/merge-override.ts add "Artist Name" url1 url2 [--exclude url3] [--image url] [--notes "reason"]
 *   npx tsx scripts/merge-override.ts list
 *   npx tsx scripts/merge-override.ts remove "Artist Name"
 *
 * Requires SUPABASE_URL and SUPABASE_SERVICE_KEY env vars (or .env file).
 */

import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
import { resolve } from 'path';

// Load .env from project root
config({ path: resolve(import.meta.dirname ?? '.', '../.env') });

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_KEY;

if (!url || !key) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY. Set them in .env or environment.');
  process.exit(1);
}

const supabase = createClient(url, key);

const [, , command, ...rest] = process.argv;

async function add() {
  const groupName = rest[0];
  if (!groupName) {
    console.error('Usage: add "Artist Name" url1 url2 [--exclude url3 url4] [--image url] [--notes "reason"]');
    process.exit(1);
  }

  const platformUrls: string[] = [];
  const excludedUrls: string[] = [];
  let canonicalImageUrl: string | null = null;
  let notes: string | null = null;

  let i = 1;
  while (i < rest.length) {
    if (rest[i] === '--exclude') {
      i++;
      while (i < rest.length && !rest[i].startsWith('--')) {
        excludedUrls.push(rest[i]);
        i++;
      }
    } else if (rest[i] === '--image') {
      canonicalImageUrl = rest[++i] || null;
      i++;
    } else if (rest[i] === '--notes') {
      notes = rest[++i] || null;
      i++;
    } else {
      platformUrls.push(rest[i]);
      i++;
    }
  }

  if (platformUrls.length < 2) {
    console.error('Need at least 2 platform URLs to create a merge override.');
    process.exit(1);
  }

  const { data, error } = await supabase
    .from('artist_merge_overrides')
    .insert({
      group_name: groupName,
      platform_urls: platformUrls,
      excluded_urls: excludedUrls,
      canonical_image_url: canonicalImageUrl,
      notes,
    })
    .select()
    .single();

  if (error) {
    console.error('Failed to insert:', error.message);
    process.exit(1);
  }

  console.log(`Added merge override for "${groupName}":`);
  console.log(`  Merge URLs: ${platformUrls.join(', ')}`);
  if (excludedUrls.length > 0) console.log(`  Excluded URLs: ${excludedUrls.join(', ')}`);
  if (canonicalImageUrl) console.log(`  Image: ${canonicalImageUrl}`);
  console.log(`  ID: ${data.id}`);
}

async function list() {
  const { data, error } = await supabase
    .from('artist_merge_overrides')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) {
    console.error('Failed to list:', error.message);
    process.exit(1);
  }

  if (!data || data.length === 0) {
    console.log('No merge overrides found.');
    return;
  }

  console.log(`${data.length} merge override(s):\n`);
  for (const row of data) {
    console.log(`  ${row.group_name}`);
    console.log(`    Merge: ${row.platform_urls.join(', ')}`);
    if (row.excluded_urls?.length > 0) console.log(`    Exclude: ${row.excluded_urls.join(', ')}`);
    if (row.canonical_image_url) console.log(`    Image: ${row.canonical_image_url}`);
    if (row.notes) console.log(`    Notes: ${row.notes}`);
    console.log(`    ID: ${row.id} | Created: ${row.created_at}`);
    console.log();
  }
}

async function remove() {
  const groupName = rest[0];
  if (!groupName) {
    console.error('Usage: remove "Artist Name"');
    process.exit(1);
  }

  const { data, error } = await supabase
    .from('artist_merge_overrides')
    .delete()
    .ilike('group_name', groupName)
    .select();

  if (error) {
    console.error('Failed to remove:', error.message);
    process.exit(1);
  }

  if (!data || data.length === 0) {
    console.error(`No override found for "${groupName}".`);
    process.exit(1);
  }

  console.log(`Removed ${data.length} override(s) for "${groupName}".`);
}

switch (command) {
  case 'add':
    await add();
    break;
  case 'list':
    await list();
    break;
  case 'remove':
    await remove();
    break;
  default:
    console.log('Usage: npx tsx scripts/merge-override.ts <add|list|remove> [args]');
    process.exit(1);
}
