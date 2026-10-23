#!/usr/bin/env node
/**
 * Fills in the secrets the Cloudflare cutover needs, as far as that can be done without anyone
 * pasting a value. Nothing is ever printed but names.
 *
 *   node scripts/copy-worker-secrets.mjs github      [--dry-run]   GitHub repository secrets
 *   node scripts/copy-worker-secrets.mjs staging     [--dry-run]   the unstream-staging Worker
 *   node scripts/copy-worker-secrets.mjs production  [--dry-run]   the unstream Worker
 *
 * --dry-run reads and checks every value and writes nothing. Run it first.
 *
 * Three kinds of value:
 *   - **Copied from Netlify** with `netlify env:get`, then handed to `gh secret set` or
 *     `wrangler secret bulk` on stdin.
 *   - **Generated fresh**, for the two values only this Worker uses (see GENERATED).
 *   - **By hand**, listed at the end with where to find each. Netlify stores anything marked
 *     secret write-only: `env:get` answers with sixteen asterisks and the last four characters,
 *     and its dashboard can't reveal it either. Those values have to come from where they were
 *     made (Supabase, Stripe, 1Password...). The masked form is detected and never copied.
 *
 * Each list mirrors the secrets table in docs/specs/infrastructure-independence-plan.md.
 * SCHEDULED_JOBS_ENABLED is never here: it is set by hand at the cutover (step 12).
 */

import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

// The Netlify CLI is linked in the main checkout (.netlify/state.json and .env are gitignored and
// live only there), so read from that checkout even when this runs from a worktree.
const mainCheckout = dirname(
  execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: repoRoot, encoding: 'utf8' }).trim(),
);

const MASK = '****************';

/**
 * Values only the Worker itself checks, so a new one is as good as Netlify's.
 * - INTERNAL_FUNCTION_SECRET: on the Worker, the only caller is the Worker's own queue consumer
 *   (runBackgroundFunction in workers/index.ts). The GitHub workflows that send Netlify's value are
 *   deleted at the cutover; the paused weekly-analytics-recap.yml would need the GitHub secret
 *   updated if it is ever restored.
 * - SESSION_HASH_SECRET: keys the daily anonymous session hash. A new key only means visitors on
 *   cutover day can be counted twice.
 */
const GENERATED = new Set(['INTERNAL_FUNCTION_SECRET', 'SESSION_HASH_SECRET']);

/** Where to get each value Netlify won't reveal. */
const WHERE = {
  SUPABASE_SERVICE_KEY: 'Supabase → Project Settings → API Keys → service_role (secret)',
  SUPABASE_JWT_SECRET: 'Supabase → Project Settings → JWT Keys → Legacy JWT secret',
  UPSTASH_REDIS_REST_TOKEN: 'Upstash console → your database → REST API → UPSTASH_REDIS_REST_TOKEN',
  BANDCAMP_CREDENTIAL_KEY: '1Password (or wherever it was saved). MUST be the same value Netlify has: it decrypts the stored Bandcamp connections',
  MIRLO_API_KEY: 'your Mirlo account (the key Unstream was issued)',
  RESEND_API_KEY: 'Resend → API Keys → create a new key (old keys can\'t be viewed again)',
  SENTRY_AUTH_TOKEN: 'Sentry → Settings → Auth Tokens → create an organization token',
  STRIPE_SECRET_KEY: 'Stripe → Developers → API keys',
  STRIPE_CONNECT_WEBHOOK_SECRET: 'Stripe → Developers → Webhooks → the Connect endpoint for this site → Signing secret',
  CLOUDFLARE_ZONE_ID: 'Cloudflare → unstream.stream → Overview → API → Zone ID',
  CLOUDFLARE_PURGE_TOKEN: 'the cache-purge token you made in step 2',
  CLOUDFLARE_API_TOKEN: 'Cloudflare → My Profile → API Tokens → create from the "Edit Cloudflare Workers" template',
  CLOUDFLARE_ACCOUNT_ID: '`npx wrangler whoami` prints it',
  NTFY_TOKEN: 'your ntfy account (Netlify has none, so the tips notifier can\'t push today)',
};

// Both Workers. `from` names the Netlify variable when it differs from the secret's name.
const WORKER_COMMON = [
  'SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_KEY', 'SUPABASE_JWT_SECRET',
  'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN',
  'INTERNAL_FUNCTION_SECRET', 'SESSION_HASH_SECRET', 'BANDCAMP_CREDENTIAL_KEY',
  'SENTRY_DSN', 'ADMIN_EMAIL', 'ALLOWED_API_EMAILS', 'MIRLO_API_KEY',
  // Netlify holds this one misspelled, so the code (which reads ALGOLIA_API_KEY) never sees it there.
  { name: 'ALGOLIA_API_KEY', from: 'ALGOLAI_API_KEY' },
  'RESEND_API_KEY', 'BUTTONDOWN_API_KEY', 'NETLIFY_API_TOKEN', 'NETLIFY_SITE_ID',
  'CLOUDFLARE_ZONE_ID', 'CLOUDFLARE_PURGE_TOKEN',
];

const TARGETS = {
  github: [
    'VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY', 'VITE_SENTRY_DSN', 'SUPABASE_URL', 'SUPABASE_SERVICE_KEY',
    'SENTRY_AUTH_TOKEN', 'SENTRY_ORG', 'SENTRY_PROJECT', 'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID',
  ],
  // Staging takes Stripe's TEST key, and the signing secret of a test-mode endpoint at
  // https://next.unstream.stream/api/tips/webhook, so both are by hand and never copied.
  staging: [...WORKER_COMMON, { name: 'STRIPE_SECRET_KEY', byHand: true }, { name: 'STRIPE_CONNECT_WEBHOOK_SECRET', byHand: true }],
  production: [
    ...WORKER_COMMON, 'STRIPE_SECRET_KEY', 'STRIPE_CONNECT_WEBHOOK_SECRET',
    'RELEASE_CATALOG_ENABLED', 'NTFY_SERVER_URL', 'NTFY_TOPIC', 'NTFY_TOKEN',
  ],
};

const [targetName, flag] = process.argv.slice(2);
const dryRun = flag === '--dry-run';
if (!TARGETS[targetName] || (flag && !dryRun)) {
  console.error('Usage: node scripts/copy-worker-secrets.mjs github|staging|production [--dry-run]');
  process.exit(2);
}
const envFlag = targetName === 'staging' ? ' --env staging' : '';

function netlifyValue(variable) {
  try {
    return execFileSync('npx', ['--no-install', 'netlify', 'env:get', variable, '--context', 'production'], {
      cwd: mainCheckout, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).replace(/\n$/, '');
  } catch {
    return '';
  }
}

/** The main checkout's .env, which `npm run dev` uses and which holds a few real values. */
function dotEnvValue(variable) {
  const file = join(mainCheckout, '.env');
  if (!existsSync(file)) return '';
  const line = readFileSync(file, 'utf8').split('\n').find((l) => l.startsWith(`${variable}=`));
  return line ? line.slice(variable.length + 1).trim() : '';
}

const values = {};
const byHand = [];
for (const entry of TARGETS[targetName]) {
  const { name, from = name, byHand: forced } = typeof entry === 'string' ? { name: entry } : entry;
  let value = '';
  let source = '';

  if (forced) {
    // left empty: by hand
  } else if (GENERATED.has(name) && targetName !== 'github') {
    value = randomBytes(32).toString('hex');
    source = 'generated fresh';
  } else if (name === 'NETLIFY_SITE_ID') {
    value = JSON.parse(readFileSync(join(mainCheckout, '.netlify', 'state.json'), 'utf8')).siteId ?? '';
    source = '.netlify/state.json';
  } else if (!(name in WHERE) || name === 'SUPABASE_SERVICE_KEY') {
    value = netlifyValue(from);
    source = `Netlify ${from}`;
    if (value.startsWith(MASK)) {
      // Write-only in Netlify. The service key is also in the main checkout's .env.
      value = name === 'SUPABASE_SERVICE_KEY' ? dotEnvValue(name) : '';
      source = value ? '.env (Netlify keeps it write-only)' : source;
    }
  }

  if (value) {
    values[name] = value;
    console.log(`  copy     ${name}  <- ${source}`);
  } else {
    byHand.push(name);
    console.log(`  by hand  ${name}`);
  }
}

if (dryRun) {
  console.log(`\nDry run: ${Object.keys(values).length} would be set, ${byHand.length} by hand. Nothing written.`);
} else if (targetName === 'github') {
  for (const [name, value] of Object.entries(values)) {
    execFileSync('gh', ['secret', 'set', name], { cwd: repoRoot, input: value, stdio: ['pipe', 'ignore', 'inherit'] });
  }
  console.log(`\nSet ${Object.keys(values).length} GitHub repository secrets.`);
} else {
  const args = ['wrangler', 'secret', 'bulk', ...(targetName === 'staging' ? ['--env', 'staging'] : [])];
  execFileSync('npx', args, { cwd: repoRoot, input: JSON.stringify(values), stdio: ['pipe', 'inherit', 'inherit'] });
}

if (byHand.length > 0) {
  console.log('\nSet these by hand. Each command asks for the value and doesn\'t show it as you paste:');
  for (const name of byHand) {
    const command = targetName === 'github' ? `gh secret set ${name}` : `npx wrangler secret put ${name}${envFlag}`;
    const hint = targetName === 'staging' && name.startsWith('STRIPE_')
      ? (name === 'STRIPE_SECRET_KEY'
        ? 'Stripe in TEST mode → Developers → API keys (sk_test_…)'
        : 'Stripe in TEST mode → Webhooks → add a Connect endpoint for https://next.unstream.stream/api/tips/webhook (events: see the top of api/functions/tips-webhook.ts) → Signing secret')
      : WHERE[name];
    console.log(`\n  ${command}\n      ${hint}`);
  }
}
