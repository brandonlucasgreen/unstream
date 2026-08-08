
import { Link } from 'react-router-dom';

import { Header } from '../components/Header';
import { Footer } from '../components/Footer';

/**
 * Privacy Policy for the hosted service and the clients that sign into it.
 *
 * Every claim on this page was checked against the code and the migrations, because the previous
 * version had drifted: it still said saved artists lived only on your device, which stopped
 * being true when sync shipped, and it predated public sharing, the newsletter, the release
 * feeds and the public API.
 *
 * The rule for editing: if a feature changes what is collected, where it goes, or how long it's
 * kept, this page changes in the same PR. A privacy policy that describes last year's product
 * is a liability, not a protection. `docs/specs/data-collection-audit.md` is the working
 * inventory this page is written from — update it alongside.
 */
export function PrivacyPolicyPage() {
  return (
    <div className="min-h-screen">

      <Header />

      <main className="pt-8 px-4 pb-16">
        <div className="max-w-3xl mx-auto">
          <article className="prose prose-lg dark:prose-invert max-w-none prose-a:text-accent-primary text-text-primary">
            <h2 className="font-display text-3xl font-semibold text-text-primary mb-6">Privacy Policy</h2>
            <p className="text-text-muted text-sm mb-8">Last updated: August 8, 2026</p>

            <div className="mb-10 p-5 rounded-lg bg-bg-secondary border border-border not-prose">
              <h3 className="font-display text-xl font-semibold text-text-primary mb-3">The short version</h3>
              <ul className="list-disc ml-5 text-text-primary/90 space-y-2 text-base">
                <li>
                  You can use Unstream without an account, and we'd rather you didn't have to make one.
                </li>
                <li>
                  We don't sell your data, we don't run ad trackers, and we don't follow you around
                  the web.
                </li>
                <li>
                  <strong>We don't record who searched for what.</strong> We do keep the search
                  terms themselves — cached so the next person's search is fast — with nothing
                  attached that says it was you.
                </li>
                <li>
                  Your saved artists are stored on our servers, tied to your account, so they can
                  sync between your devices. They're private unless you deliberately publish them.
                </li>
                <li>
                  Your username, your location, and public sharing are all optional and all off
                  until you turn them on.
                </li>
                <li>
                  Ask us for your data or ask us to delete it at{' '}
                  <a href="mailto:support@unstream.stream" className="text-accent-primary hover:text-accent-secondary transition-colors underline">
                    support@unstream.stream
                  </a>
                  , and we'll do it.
                </li>
              </ul>
            </div>

            <Section title="How much we know about you, honestly">
              <P>
                "Anonymous" is a word that gets used loosely, so here's the real breakdown. Three
                categories, and we've been strict about which is which.
              </P>

              <h4 className="font-semibold text-text-primary mt-5 mb-2">Genuinely anonymous</h4>
              <P>
                Nothing identifies you, not even indirectly, and there's no way for us to work
                backwards to a person.
              </P>
              <ul className="list-disc ml-5 text-text-primary/90 mb-3 space-y-1">
                <li>
                  <strong>Artist performance stats.</strong> The numbers on an artist's dashboard
                  are daily totals per artist: how many searches they appeared in, how many times
                  their page was viewed, how many times each platform link was clicked. A counter
                  goes up by one. No user ID, no session, no IP address, nothing about who did it
                  or what else they did.
                </li>
              </ul>

              <h4 className="font-semibold text-text-primary mt-5 mb-2">Pseudonymous — not linked to you, but not nothing</h4>
              <P>
                No name or email is attached, but there's some kind of identifier involved. We call
                this out rather than filing it under "anonymous", because that would be a stretch.
              </P>
              <ul className="list-disc ml-5 text-text-primary/90 mb-3 space-y-1">
                <li>
                  <strong>Product usage events.</strong> Things like "a search happened and
                  returned 12 results" or "somebody clicked a Bandcamp link", so we can tell
                  whether a feature works. Each carries a session token that is a one-way keyed
                  hash of your IP address, your browser's user agent, and today's date. It changes
                  every day, we can't reverse it into an IP, and it can't follow you from one day
                  to the next. We never store the raw IP.
                </li>
                <li>
                  <strong>Rate-limiting records.</strong> To stop abuse we count requests per IP
                  address in a temporary store. This one is a raw IP address, held for at most 24
                  hours, and used for nothing else.
                </li>
                <li>
                  <strong>Website analytics.</strong> GoatCounter, which is privacy-focused and
                  cookie-free, records page views using its own daily-rotating visitor hash. It's
                  configured to receive the page you visited and not the query string, so a search
                  reaches it as a visit to the home page rather than as an artist name.
                </li>
              </ul>

              <h4 className="font-semibold text-text-primary mt-5 mb-2">Linked to your account</h4>
              <P>Once you create an account, this is tied to you and we can look it up:</P>
              <ul className="list-disc ml-5 text-text-primary/90 mb-3 space-y-1">
                <li>Your email address, and a securely hashed password if you set one.</li>
                <li>
                  The artists you've saved, any notes you attached, which ones you've marked as
                  supported, and when.
                </li>
                <li>
                  A device identifier for each device you sync from — a random ID generated on
                  install, used to work out which device made which change. It isn't a hardware
                  identifier and it tells us nothing about your device.
                </li>
                <li>Your username and location, if you set them.</li>
                <li>The secret token behind your personal release feed, if you've created one.</li>
                <li>
                  For artists: your claimed profile — bio, photo, links, featured release — and
                  anything you wrote in a manual verification request.
                </li>
                <li>For API users: your email, a label for each key, and a hash of the key itself.</li>
              </ul>
            </Section>

            <Section title="About your searches">
              <P>
                People assume searches are the sensitive part, so this gets its own section rather
                than a footnote.
              </P>
              <P>
                <strong>We do not record who searched for what.</strong> No search is ever written
                against your account, and signing in doesn't change that — your search history
                isn't something we hold, because we never build one.
              </P>
              <P>
                <strong>We do store the search terms themselves</strong>, detached from any person,
                in three places:
              </P>
              <ul className="list-disc ml-5 text-text-primary/90 mb-3 space-y-1">
                <li>
                  A results cache, so a popular artist doesn't cost every visitor a fresh round of
                  requests to a dozen platforms. Entries are keyed by the artist name and normally
                  expire within 30 minutes.
                </li>
                <li>
                  A permanent record of which artist names we've already checked on Bandcamp, and
                  what we found. This is what stops us hammering Bandcamp with the same lookups
                  forever. It stores the normalized artist name and the result — nothing about who
                  asked.
                </li>
                <li>
                  Short-lived server logs, which include the artist name being looked up, kept
                  briefly by our hosting provider for debugging.
                </li>
              </ul>
              <P>
                A search does put the artist name in the page address
                (<code>unstream.stream/?q=artist+name</code>), so it's worth saying where that
                address does and doesn't go. Our website analytics is deliberately configured to
                drop the query string, so it records a visit to the home page and never the search
                term. The one exception is an error report: if a search fails, the report sent to
                Sentry includes the page address, artist name and all, because that's usually the
                only way to work out what broke.
              </P>
            </Section>

            <Section title="What's public, and only if you choose">
              <P>
                Everything in your account is private by default. There are exactly two ways
                something becomes publicly visible, and both are things you have to switch on.
              </P>
              <P>
                <strong>Sharing your saved artists.</strong> Setting a username doesn't publish
                anything on its own. Turning on sharing publishes a page at{' '}
                <code>unstream.stream/u/your-username</code> showing your username, the artists
                you've saved, which ones you've marked as supported, and your location if you've
                set one. Anyone can open it without an account, and search engines can index it.
                Your email address is never published, and neither are your notes.
              </P>
              <P>
                You can turn sharing off, change your username, or clear your location at any time
                in your settings. The page goes down, but copies already made by caches, archives
                or other people are beyond our reach. There's more on this in section 6 of the{' '}
                <Link to="/terms#section-6" className="text-accent-primary hover:text-accent-secondary transition-colors underline">
                  Terms of Use
                </Link>
                .
              </P>
              <P>
                <strong>Claiming an artist profile.</strong> Once verified, your bio, photo, links,
                location and featured release are shown publicly on your artist page. That's the
                point of claiming it. The email address you claimed with is not shown.
              </P>
            </Section>

            <Section title="Where your data goes">
              <P>
                We use a small number of providers to run the Service. They process data on our
                behalf, and none of them get your data to use for their own purposes.
              </P>
              <ul className="list-disc ml-5 text-text-primary/90 mb-3 space-y-1">
                <li><strong>Netlify</strong> — hosting and serverless functions.</li>
                <li><strong>Supabase</strong> — the database and authentication.</li>
                <li><strong>Upstash</strong> — the temporary cache and rate-limiting store.</li>
                <li><strong>GoatCounter</strong> — cookie-free website analytics.</li>
                <li><strong>Sentry</strong> — error reports, configured not to send IP addresses, cookies or request headers. An error report does include the address of the page it happened on.</li>
                <li><strong>Buttondown</strong> — the newsletter, if you subscribe.</li>
                <li><strong>Liberapay</strong> and <strong>Apple</strong> — donations and in-app support purchases. We never see your payment details.</li>
                <li><strong>Discord</strong> — if you use the Unstream bot in a Discord server.</li>
              </ul>
              <P>
                Separately, we read from public music and metadata sources — MusicBrainz, Wikidata,
                Wikipedia, Discogs, Bandcamp, Mirlo and the other platforms we list. We send them
                an artist name to search for. We never send them anything about you.
              </P>
              <P>
                These providers are based in the United States, and that's where your data is
                stored and processed. If you're in the UK or EEA, that means your data is
                transferred outside your home region.
              </P>
            </Section>

            <Section title="The apps and the extension">
              <P>
                <strong>Browser extension.</strong> It reads the artist and track showing on the
                streaming sites it supports, so it can look them up. That reading happens in your
                browser; the artist name is sent to our search API the same way a search on the
                website is. It never reads your credentials, your listening history, your playlists,
                or anything on other sites. Saved artists live in your browser's local storage, and
                sync to your account only if you sign in.
              </P>
              <P>
                <strong>macOS and iOS apps.</strong> They read now-playing information from your
                device for the same purpose. Saved artists are stored on your device, and sync to
                your account only if you sign in. Optional extras stay on your device: if you
                connect ListenBrainz, your listening data goes from your device to ListenBrainz
                under their privacy policy and never through us, and if you connect Plex, your
                token and server address stay in your device's keychain and talk only to your own
                server.
              </P>
            </Section>

            <Section title="What we don't collect">
              <ul className="list-disc ml-5 text-text-primary/90 mb-3 space-y-1">
                <li>A history of your searches, tied to you.</li>
                <li>Credentials for any streaming service.</li>
                <li>Your listening history or playlists, except where you've explicitly connected ListenBrainz, which we don't see.</li>
                <li>Advertising or cross-site tracking cookies. We don't run ads.</li>
                <li>Your payment details.</li>
                <li>Anything from web pages other than the streaming player pages the extension supports.</li>
                <li>Precise or device-derived location. The only location we hold is one you typed in yourself.</li>
                <li>Special-category data — health, politics, religion, biometrics. We have no use for it and don't ask.</li>
              </ul>
              <P>We also don't sell personal data, and we don't share it for advertising. There's no version of this where that changes without us telling you first.</P>
            </Section>

            <Section title="Why we're allowed to hold it">
              <P>
                If you're in the UK or EEA, the legal bases we rely on are: <strong>contract</strong>{' '}
                for the things your account needs in order to work (your email, your saved artists,
                sync); <strong>consent</strong> for anything optional you switched on (the
                newsletter, public sharing, a location); and <strong>legitimate interests</strong>{' '}
                for keeping the Service running, secure, and not overwhelmed by abuse — the
                rate-limiting records, the error reports, and the anonymous and pseudonymous usage
                counts. Where we rely on consent, you can withdraw it at any time without affecting
                what came before.
              </P>
            </Section>

            <Section title="How long we keep it">
              <ul className="list-disc ml-5 text-text-primary/90 mb-3 space-y-1">
                <li><strong>Account data</strong> — until you delete your account.</li>
                <li><strong>Removed saved artists</strong> — a deletion marker is kept for 30 days so your other devices learn about the removal, then permanently erased.</li>
                <li><strong>Search results cache</strong> — usually 30 minutes.</li>
                <li><strong>Rate-limiting records</strong> — at most 24 hours.</li>
                <li><strong>The record of which artist names we've checked on Bandcamp</strong> — kept indefinitely. It contains no personal data.</li>
                <li><strong>Artist performance stats and product usage events</strong> — kept indefinitely as historical trends. Neither is linked to an account.</li>
                <li><strong>Newsletter subscription</strong> — until you unsubscribe.</li>
                <li><strong>Backups</strong> — deleted data can persist in backups for a short period after deletion before ageing out.</li>
              </ul>
            </Section>

            <Section title="Your rights">
              <P>
                Depending on where you live you may have the right to access your data, correct it,
                delete it, take a copy elsewhere, object to or restrict how we use it, and withdraw
                consent. We extend all of these to everyone, wherever you are, because running two
                standards would be worse for everybody.
              </P>
              <P>
                Some you can exercise yourself, right now: your saved artists, username, location
                and sharing setting are all editable in{' '}
                <Link to="/settings" className="text-accent-primary hover:text-accent-secondary transition-colors underline">
                  your settings
                </Link>
                , your newsletter subscription has an unsubscribe link on every issue, and your
                release feed token can be rotated or revoked.
              </P>
              <P>
                For anything else — a copy of everything we hold on you, or deletion of your
                account and its data — email{' '}
                <a href="mailto:support@unstream.stream" className="text-accent-primary hover:text-accent-secondary transition-colors underline">
                  support@unstream.stream
                </a>
                . We'll respond within 30 days and we won't make you justify the request. If you're
                in the UK or EEA you also have the right to complain to your data protection
                authority.
              </P>
              <P>
                You can clear local data without involving us at all: remove the browser extension
                or clear its storage, or delete the app from your device.
              </P>
            </Section>

            <Section title="Security">
              <P>
                Your account data — your saved artists, your username and location, your feed
                token — is protected by database policies that scope every row to its owner. API
                keys are stored as hashes, never in plaintext. Passwords are handled by Supabase
                Auth and we never see them. Traffic is encrypted in transit.
              </P>
              <P>
                No system is perfectly secure, and we won't pretend otherwise. If you find a
                vulnerability, please tell us at support@unstream.stream — we'll take it seriously
                and we won't come after you for reporting it in good faith. If a breach affects
                your personal data, we'll tell you and the relevant regulator as the law requires.
              </P>
            </Section>

            <Section title="Children">
              <P>
                Unstream isn't directed at children under 13, and we don't knowingly collect their
                data. You must be at least 13 to create an account, or older where your country
                requires it. If you believe a child under 13 has an account, tell us and we'll
                remove it.
              </P>
            </Section>

            <Section title="Changes to this policy">
              <P>
                We'll update this page as the Service changes, and update the "Last updated" date
                when we do. For changes that materially affect how we handle your data, we'll give
                notice on the site and, if you have an account, by email — before the change takes
                effect where we reasonably can.
              </P>
            </Section>

            <Section title="Contact">
              <P>
                Questions, requests, or corrections:{' '}
                <a href="mailto:support@unstream.stream" className="text-accent-primary hover:text-accent-secondary transition-colors underline">
                  support@unstream.stream
                </a>
                . The{' '}
                <Link to="/terms" className="text-accent-primary hover:text-accent-secondary transition-colors underline">
                  Terms of Use
                </Link>{' '}
                cover the rest of the relationship.
              </P>
            </Section>
          </article>
        </div>
      </main>

      <Footer />
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-8">
      <h3 className="font-display text-xl font-semibold text-text-primary mb-3">{title}</h3>
      {children}
    </section>
  );
}

function P({ children }: { children: React.ReactNode }) {
  return <p className="text-text-primary/90 leading-relaxed mb-3">{children}</p>;
}
