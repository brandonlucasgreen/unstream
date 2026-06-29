#!/usr/bin/env node
// One-shot probe for UNS-151.
// Requires SUPABASE_SERVICE_KEY in env or keychain at secrets/supabase_service_role_key.
// Queries prod auth.users by email and public.usernames by user_id.

const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || null;
const SUPABASE_URL = 'https://bwogclqzpsbvqbyhhqbz.supabase.co';
const EMAILS = [
  'brandonlucasgreen@gmail.com',
  'brandonlucasgreen',
  'brandon@unstream.stream',
];

async function rest(path, init = {}) {
  const url = `${SUPABASE_URL}/rest/v1${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data };
}

async function main() {
  if (!SERVICE_KEY) {
    console.error('❌ Could not probe: SUPABASE_SERVICE_KEY is not set and secrets/supabase_service_role_key was not found in keychain.');
    console.error('To run: export SUPABASE_SERVICE_KEY=<key> && node scripts/probe-brandon-usernames.js');
    process.exit(1);
  }

  console.log('Probing production Supabase with service-role key...\n');

  let userId = null;
  for (const email of EMAILS) {
    const q = new URLSearchParams();
    q.set('email', `eq.${email}`);
    q.set('select', 'id,email,raw_user_meta_data');
    const { status, data } = await rest(`/auth/users?${q.toString()}`);
    console.log(`auth.users lookup for "${email}": HTTP ${status}`);
    if (Array.isArray(data) && data.length > 0) {
      const u = data[0];
      userId = u.id;
      console.log('  → found user:', { id: u.id, email: u.email, raw_user_meta_data: u.raw_user_meta_data });
      break;
    } else {
      console.log('  → no match');
    }
  }

  if (!userId) {
    console.error('\n❌ Could not find Brandon\'s auth.users row in production. Tried:', EMAILS.join(', '));
    console.error('Diagnosis inconclusive — need another path to verify the usernames row.');
    process.exit(1);
  }

  const q = new URLSearchParams();
  q.set('user_id', `eq.${userId}`);
  q.set('select', 'user_id,username,location,saved_artists_public,created_at,updated_at');
  const { status, data } = await rest(`/usernames?${q.toString()}`);
  console.log(`\npublic.usernames lookup for user_id=${userId}: HTTP ${status}`);

  if (Array.isArray(data)) {
    if (data.length === 0) {
      console.log('  → ROW MISSING. This is the bug: no usernames row for Brandon. The NOT NULL username constraint causes the upsert INSERT to fail with 23502.');
      console.log('\nDiagnosis: (A) usernames row is missing entirely.');
      process.exit(0);
    }
    const row = data[0];
    console.log('  → row exists:', row);
    if (row.user_id === userId) {
      console.log('\nDiagnosis: row exists with matching user_id. Investigate fix path (C): onConflict / write path.');
    } else {
      console.log('\n⚠️ Row user_id does not match auth.users id — possible auth/replication glitch (fix path B).');
    }
  } else {
    console.log('  → unexpected response:', data);
  }
}

main().catch(err => {
  console.error('Probe failed:', err);
  process.exit(1);
});
