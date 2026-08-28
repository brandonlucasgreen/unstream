import { Link } from 'react-router-dom';

import { Header } from '../components/Header';
import { Footer } from '../components/Footer';

/**
 * Terms of Use for the hosted service at unstream.stream, plus the apps that sign into it.
 *
 * Two things to keep true when editing:
 *
 * 1. Unstream is described here as an independent project with no incorporated entity behind
 *    it. If that ever changes, the entity's legal name belongs in §2 and §20, and nowhere else.
 * 2. The factual sections (§5–§14) describe what the product actually does. When a feature
 *    changes what it collects, publishes, or emails, this page changes with it — a terms page
 *    that describes a product you no longer ship is worse than no terms page at all.
 */
export function TermsOfUsePage() {
  return (
    <div className="min-h-screen">

      <Header />

      <main className="pt-8 px-4 pb-16">
        <div className="max-w-3xl mx-auto">
          <article className="prose prose-lg dark:prose-invert max-w-none prose-a:text-accent-primary text-text-primary">
            <h2 className="font-display text-3xl font-semibold text-text-primary mb-6">Terms of Use</h2>
            <p className="text-text-muted text-sm mb-8">Last updated: August 8, 2026</p>

            <div className="mb-10 p-5 rounded-lg bg-bg-secondary border border-border not-prose">
              <h3 className="font-display text-xl font-semibold text-text-primary mb-3">The short version</h3>
              <p className="text-text-primary/90 leading-relaxed mb-3 text-base">
                This summary is here to be read. It isn't a substitute for the full terms below, and where the two
                disagree, the full terms win.
              </p>
              <ul className="list-disc ml-5 text-text-primary/90 space-y-2 text-base">
                <li>
                  Unstream is a free search tool that points you to places to buy music and support artists directly.
                  We don't host music, sell it, or take a cut of anything you spend — those purchases happen on other
                  platforms, under their terms.
                </li>
                <li>
                  You only need an account to save artists, sync them across devices, or run an artist profile. You're
                  responsible for what happens under your account.
                </li>
                <li>
                  If you switch on public sharing, your username, your saved artists, and your location (if you set
                  one) become visible to anyone with the link. Switching it off stops that going forward, but copies
                  other people or search engines already made are out of our hands.
                </li>
                <li>
                  Claiming an artist profile is you telling us that you are that artist, or that you're authorized to
                  act for them. Claiming one you have no right to gets it taken away.
                </li>
                <li>
                  Everything here is provided as-is. Search results, platform links, and payout percentages are a
                  careful best effort, not a guarantee.
                </li>
                <li>
                  If something looks wrong, email{' '}
                  <a href="mailto:support@unstream.stream" className="text-accent-primary hover:text-accent-secondary transition-colors underline">
                    support@unstream.stream
                  </a>
                  . We would much rather fix it than argue about it.
                </li>
              </ul>
            </div>

            <Section n={1} title="Agreement to these terms">
              <P>
                These Terms of Use ("Terms") are an agreement between you and Unstream. They cover the website at
                unstream.stream, the Unstream browser extension, the Unstream apps for macOS and iOS, the Unstream
                Discord bot, our public API, and any other service we offer that links to this page (together, the
                "Service").
              </P>
              <P>
                By using the Service — searching, creating an account, claiming an artist profile, or calling the API —
                you agree to these Terms. If you don't agree, please don't use the Service.
              </P>
              <P>
                Our{' '}
                <Link to="/privacy-policy" className="text-accent-primary hover:text-accent-secondary transition-colors underline">
                  Privacy Policy
                </Link>{' '}
                explains what data we collect and why. It's part of this agreement.
              </P>
            </Section>

            <Section n={2} title="Who we are">
              <P>
                Unstream is an independent project, run and paid for by one person rather than a company. "Unstream",
                "we", and "us" in these Terms mean that project and whoever operates it. "You" means whoever is using
                the Service.
              </P>
              <P>
                The Service is free to use. There is no paid tier, no subscription, and nothing you have to buy to get
                the whole product. Donations and in-app tips are covered in section 13.
              </P>
            </Section>

            <Section n={3} title="Eligibility and age">
              <P>
                You must be at least 13 years old to create an Unstream account. If you're in the European Economic
                Area, the United Kingdom, or anywhere else that sets a higher minimum age for consenting to online
                services on your own, you must meet that age instead, or have your parent or guardian agree to these
                Terms for you.
              </P>
              <P>
                Unstream isn't directed at children under 13, and we don't knowingly keep accounts for them. If you
                believe a child under 13 has an account, tell us at support@unstream.stream and we'll remove it.
              </P>
              <P>
                If you're using the Service on behalf of an organization — a label, a management company, a band's
                shared account — you're confirming you're authorized to accept these Terms for that organization.
              </P>
            </Section>

            <Section n={4} title="Your account">
              <P>
                You can sign in with a one-time link sent to your email, or with a password. Either way, your email
                address is your account. Keep it secure: anyone who can read your inbox can sign in as you.
              </P>
              <ul className="list-disc ml-5 text-text-primary/90 mb-3 space-y-1">
                <li>Give us an email address you actually control, and keep it current.</li>
                <li>Don't share your account, your password, or your sign-in links with anyone else.</li>
                <li>
                  You're responsible for everything done through your account, except activity that happens after you
                  tell us it's been compromised.
                </li>
                <li>Tell us promptly at support@unstream.stream if you think someone else has access to it.</li>
                <li>One person, one account. Don't create accounts to evade a suspension or a rate limit.</li>
              </ul>
              <P>
                You can delete your account and the data attached to it at any time by emailing
                support@unstream.stream.
              </P>
            </Section>

            <Section n={5} title="What Unstream does — and what it doesn't">
              <P>
                Unstream searches music platforms for an artist you name and shows you where to find them, grouped by
                category, with an estimate of how much of your money reaches the artist on each one.
              </P>
              <P>
                <strong>We are a directory and a search tool.</strong> We don't host, sell, stream, or license music.
                We aren't a party to anything you buy. Every purchase, subscription, download, and refund is between
                you and the platform you buy from, under that platform's terms.
              </P>
              <P>Some specific limits worth being blunt about:</P>
              <ul className="list-disc ml-5 text-text-primary/90 mb-3 space-y-1">
                <li>
                  <strong>Results can be wrong.</strong> Matching an artist name across platforms is genuinely hard.
                  Two artists share a name; a page turns out to be a fan account; a platform's search misses somebody
                  who's plainly there. We work at this constantly and we still get it wrong. Check before you buy.
                </li>
                <li>
                  <strong>Payout percentages are estimates.</strong> They come from each platform's own published fees
                  and don't account for payment processing, currency conversion, label or distributor splits, or deals
                  we can't see. Treat them as a guide to the shape of the ecosystem, not as an accounting of a specific
                  sale.
                </li>
                <li>
                  <strong>A listing isn't an endorsement</strong> — of a platform, an artist, or a release. A missing
                  listing isn't a judgment either; it usually means we didn't find one.
                </li>
                <li>
                  <strong>Release information may be stale or incomplete.</strong> We catalogue releases from artists'
                  own pages on a schedule, so new releases can take a while to appear and removed ones can linger.
                </li>
              </ul>
            </Section>

            <Section n={6} title="Saved artists, sharing, and public pages">
              <P>
                A signed-in account lets you save artists, mark artists you've supported, and sync that list between
                the website, the browser extension, and the Apple apps. By default, that list is private to you.
              </P>
              <P>
                You can also claim a username and switch on public sharing, which publishes your list at
                unstream.stream/u/your-username. <strong>Before you do, understand what becomes public:</strong>
              </P>
              <ul className="list-disc ml-5 text-text-primary/90 mb-3 space-y-1">
                <li>Your username.</li>
                <li>The artists you've saved, and which ones you've marked as supported.</li>
                <li>Your location, if you've set one in your settings.</li>
              </ul>
              <P>
                Your email address is never published. The page is open to anyone with the link — no account needed —
                and it can be indexed by search engines, archived, screenshotted, and shared onward.
              </P>
              <P>
                You can turn sharing off, change your username, or clear your location at any time in your settings.
                That takes the page down going forward, and we'll ask search engines to drop it, but{' '}
                <strong>we can't retrieve copies that already exist</strong> in caches, archives, or someone else's
                screenshot. Please share deliberately.
              </P>
              <P>
                Usernames are first come, first served, and a set of names are reserved for the Service itself. We may
                reclaim a username that impersonates someone, infringes a trademark, or is chosen to abuse or mislead.
              </P>
              <P>
                Your personal release feed has a secret token in its URL. Anyone with that URL can read the feed, so
                treat it like a password — and rotate or revoke it from your settings if it gets out.
              </P>
            </Section>

            <Section n={7} title="Artist profiles and claims">
              <P>
                Unstream generates a page for artists we find, whether or not they've ever heard of us. Artists can
                claim their page to correct it, add a bio and photo, fix links, and see how their page is performing.
              </P>
              <P>When you claim a profile, you're telling us — and you need it to be true — that:</P>
              <ul className="list-disc ml-5 text-text-primary/90 mb-3 space-y-1">
                <li>You are that artist, or you're authorized by them to manage their presence.</li>
                <li>The information you add is accurate and not misleading.</li>
                <li>You have the rights to any bio, photo, artwork, or embed you upload or link.</li>
              </ul>
              <P>
                Claiming a profile you have no right to is a serious misuse of the Service. We'll remove the claim, we
                may suspend the account, and we may hand the profile to the rightful artist.
              </P>
              <P>
                Verification is our best-effort check that a claim is genuine, using the evidence available to us. A
                verified badge means we checked; it isn't a guarantee of identity, and it isn't an endorsement,
                affiliation, or partnership. We may re-review or revoke verification if new information comes to light.
              </P>
              <P>
                An artist can ask us to correct or remove their page whether or not they've claimed it. Email
                support@unstream.stream from an address we can connect to the artist, and we'll sort it out.
              </P>
            </Section>

            <Section n={8} title="Your content and the permissions you give us">
              <P>
                "Your Content" means anything you put into the Service: your bio, photo, links, location, username,
                featured release, saved list, corrections, and anything you send us. You keep every right you already
                had in it. We don't claim ownership.
              </P>
              <P>
                To actually run the Service, we need your permission to handle it. By submitting Your Content, you give
                us a worldwide, non-exclusive, royalty-free licence to host, store, reproduce, adapt for formatting and
                display, and publish it — but only to operate, secure, and improve the Service, and only in the places
                you've chosen to publish it. We don't sell Your Content, and we don't license it to anyone else for
                their own purposes.
              </P>
              <P>
                This licence ends when you delete the content or your account, apart from two ordinary exceptions:
                backups take a short while to age out, and we may keep a record where the law requires it or where we
                need it to resolve a dispute.
              </P>
              <P>
                You're responsible for Your Content. Don't post anything unlawful, infringing, deceptive, hateful, or
                designed to harass someone. We may remove content that breaks these Terms, and we may keep a copy for
                the record when we do.
              </P>
              <P>
                If you send us a suggestion or feature idea, we can use it freely and without obligation to you. That's
                not us claiming your work — it's so we don't have to refuse good ideas out of caution.
              </P>
            </Section>

            <Section n={9} title="Acceptable use">
              <P>Please don't:</P>
              <ul className="list-disc ml-5 text-text-primary/90 mb-3 space-y-1">
                <li>Break the law with the Service, or use it to help anyone else do so.</li>
                <li>
                  Impersonate an artist, a label, another user, or us — including by claiming a profile that isn't
                  yours, or picking a username designed to be mistaken for someone else.
                </li>
                <li>
                  Scrape, crawl, or bulk-download the Service outside the public API and what our robots.txt allows.
                  The API exists precisely so you don't have to; ask us if you need more than it gives you.
                </li>
                <li>
                  Get around rate limits, quotas, or access controls — including by rotating accounts, keys, or IP
                  addresses.
                </li>
                <li>
                  Probe, scan, or test the security of the Service without asking first. If you find a vulnerability,
                  please report it to support@unstream.stream; we'll take it seriously and we won't come after you for
                  reporting it in good faith.
                </li>
                <li>
                  Overload the Service, or aim automated traffic at it in a way that degrades it for other people.
                </li>
                <li>Upload malware, or use the Service to distribute it.</li>
                <li>
                  Use the Service to train a machine learning model on our content, or to build a substantially similar
                  competing directory from our data. Many of the platforms we index have explicit policies against
                  AI-generated music, and we're not going to be the pipe that undermines them.
                </li>
                <li>
                  Misrepresent the payout percentages, verification status, or artist data you get from us when you
                  republish it.
                </li>
              </ul>
            </Section>

            <Section n={10} title="API, apps, extension, and bot">
              <P>
                <strong>Public API.</strong> We offer a versioned REST API, documented on our{' '}
                <Link to="/developers" className="text-accent-primary hover:text-accent-secondary transition-colors underline">
                  developers page
                </Link>
                . API keys are issued to you, tied to your account, and not to be shared or resold. Requests are rate
                limited. We may change, deprecate, or withdraw endpoints, and we may revoke a key that's being abused
                or that's driving load we can't carry. Please don't present data from the API as if it were your own
                research, and don't use it to rebuild the directory itself.
              </P>
              <P>
                <strong>Browser extension.</strong> The extension reads the artist and track currently showing on the
                streaming sites it supports, so it can search for alternatives. It doesn't read your credentials, your
                listening history, or anything on other pages. Your browser's extension store adds its own terms on
                top of these.
              </P>
              <P>
                <strong>macOS and iOS apps.</strong> The apps read now-playing information from your device to do the
                same thing, and sync your saved artists if you sign in. Apple's App Store terms apply alongside these
                Terms, and Apple isn't responsible for the apps — we are. Optional scrobbling to ListenBrainz only
                happens if you connect it, and is governed by ListenBrainz's own terms.
              </P>
              <P>
                <strong>Discord bot.</strong> Adding the bot to a server means these Terms apply to that use too, along
                with Discord's terms. Server admins are responsible for what happens in their server.
              </P>
              <P>
                Where a component of the Service is also published as open source, the licence on that source code
                governs the code. These Terms govern the hosted Service — running your own copy of the code doesn't put
                you under these Terms, and using ours does.
              </P>
            </Section>

            <Section n={11} title="Third-party platforms and links">
              <P>
                Almost everything Unstream shows you is a link somewhere else: Bandcamp, Mirlo, Ampwall, Subvert,
                Faircamp sites, Jam.coop, Patreon, Qobuz, libraries, artists' own stores, and more. We also pull
                metadata from sources like MusicBrainz, Wikidata, and Discogs.
              </P>
              <P>
                Those platforms are not ours and we don't control them. We're not responsible for their content, their
                pricing, their availability, their privacy practices, or how they treat you. When you follow a link,
                you're leaving Unstream and entering someone else's agreement.
              </P>
              <P>
                If a purchase goes wrong — the download fails, the artist never sees the money, the refund never
                arrives — that's between you and that platform. We'll help you figure out who to talk to, but we can't
                resolve it for you.
              </P>
            </Section>

            <Section n={12} title="Copyright and takedowns">
              <P>
                We respect copyright, and we expect the same. If you believe something on Unstream infringes your
                copyright, email support@unstream.stream with:
              </P>
              <ul className="list-disc ml-5 text-text-primary/90 mb-3 space-y-1">
                <li>Enough detail to identify the work you say is infringed.</li>
                <li>The URL of the material you want removed.</li>
                <li>Your name, address, and email.</li>
                <li>
                  A statement that you believe in good faith the use isn't authorized by the rights holder, their
                  agent, or the law.
                </li>
                <li>
                  A statement, under penalty of perjury, that your notice is accurate and that you are the rights
                  holder or authorized to act for them.
                </li>
                <li>Your physical or electronic signature.</li>
              </ul>
              <P>
                We'll review it promptly and remove or disable material where the notice is valid. If your material was
                removed and you think that was a mistake, send a counter-notice to the same address with the equivalent
                detail, and we'll handle it under the same process.
              </P>
              <P>
                We terminate the accounts of repeat infringers. Bear in mind we mostly host links and metadata rather
                than recordings, so the fastest fix for infringing audio is usually a notice to the platform actually
                hosting it — but tell us either way and we'll take our listing down.
              </P>
            </Section>

            <Section n={13} title="Donations and support purchases">
              <P>
                Unstream is free. If you choose to support it, you can do so through Buy Me a Coffee or make an in-app
                support purchase in the Apple apps. Both are voluntary, and neither buys you a feature, a service
                level, priority support, or influence over what we build.
              </P>
              <P>
                We don't handle your payment details. Buy Me a Coffee and Apple process those payments under their own terms,
                and refunds go through them, not us. Donations are generally non-refundable, and Unstream is not a
                charity — donations aren't tax-deductible.
              </P>
            </Section>

            <Section n={14} title="Emails we send you">
              <P>
                We send transactional email you can't opt out of while you have an account: sign-in links, password
                resets, and notices about your account or these Terms.
              </P>
              <P>
                Everything else is opt-in. Our newsletter is double opt-in — you'll get a confirmation email before
                you're subscribed to anything — and every issue has an unsubscribe link. Release alerts and feeds are
                things you switch on yourself and can switch off the same way.
              </P>
            </Section>

            <Section n={15} title="Availability and changes to the Service">
              <P>
                The Service is offered on a best-effort basis by a small independent project. There's no uptime
                commitment and no support-response guarantee. Things break, upstream platforms change their pages, and
                sometimes searches fail.
              </P>
              <P>
                We may add, change, or remove features at any time. If we're removing something you rely on, we'll try
                to give reasonable notice through the site or by email, and where a change materially reduces what your
                account can do, we'll say so plainly rather than let you find out by accident.
              </P>
            </Section>

            <Section n={16} title="Suspension and termination">
              <P>
                You can stop using the Service whenever you like, and delete your account by emailing
                support@unstream.stream.
              </P>
              <P>
                We may suspend or terminate your account, or remove content, if you break these Terms, if your use
                puts the Service or other users at risk, or if we're required to by law. Where it's reasonable and
                lawful to do so, we'll tell you why and give you a chance to put it right — an account is somebody's
                music library, and we don't intend to delete one over a misunderstanding.
              </P>
              <P>
                On termination, your public sharing page comes down and your account data is deleted, subject to the
                backup and legal-record exceptions in section 8. Sections 8, 11, 17, 18, 19, 20, and 22 survive
                termination.
              </P>
            </Section>

            <Section n={17} title="Disclaimers">
              <P>
                The Service is provided "as is" and "as available", without warranties of any kind, whether express,
                implied, or statutory. To the fullest extent the law allows, we disclaim the implied warranties of
                merchantability, fitness for a particular purpose, title, and non-infringement.
              </P>
              <P>
                We don't warrant that the Service will be uninterrupted, secure, or error-free; that search results,
                artist matches, links, release information, or payout percentages are accurate, complete, or current;
                or that any third-party platform will remain available or behave as described.
              </P>
              <P>
                Some jurisdictions don't allow certain warranty exclusions, so parts of this section may not apply to
                you. Nothing here limits rights you have as a consumer under mandatory local law.
              </P>
            </Section>

            <Section n={18} title="Limitation of liability">
              <P>
                To the fullest extent permitted by law, Unstream and anyone operating it won't be liable for indirect,
                incidental, special, consequential, exemplary, or punitive damages, or for lost profits, lost data,
                lost goodwill, or the cost of substitute services, arising from or relating to your use of the Service
                — even if we were told such damages were possible.
              </P>
              <P>
                Our total liability for all claims relating to the Service is limited to the greater of (a) the total
                amount you paid us in the twelve months before the claim, which for nearly everyone is zero, and (b)
                fifty US dollars (US$50).
              </P>
              <P>
                These limits don't apply to liability that can't be excluded by law — including, in many places,
                liability for fraud, for death or personal injury caused by negligence, and consumer rights that can't
                be waived. If you're a consumer in the EU, UK, or another jurisdiction with mandatory protections, you
                keep those rights in full.
              </P>
              <P>
                We're a free service run by one person. These limits are what make offering it at all reasonable, and
                they're part of the basis on which we do.
              </P>
            </Section>

            <Section n={19} title="Your responsibility for claims you cause">
              <P>
                If someone brings a claim against us because of Your Content, your use of the Service, or your breach
                of these Terms — for example, a claim that a bio or photo you uploaded infringes their rights, or that
                you claimed an artist profile you had no right to — you agree to defend us against it and to cover the
                resulting damages, losses, and reasonable legal costs. We'll tell you promptly about any such claim and
                won't settle it without talking to you.
              </P>
            </Section>

            <Section n={20} title="Disputes and governing law">
              <P>
                <strong>Talk to us first.</strong> Before starting any formal proceeding, email
                support@unstream.stream describing the problem and what you'd like done about it. Most things get
                resolved this way. Please give us 30 days to respond.
              </P>
              <P>
                These Terms are governed by the laws of the Commonwealth of Massachusetts, USA, without regard to its
                conflict-of-laws rules. Any dispute that informal resolution doesn't settle will be brought in the
                state or federal courts located in Massachusetts, and we each consent to that jurisdiction — except
                that either of us can bring a qualifying claim in small claims court instead.
              </P>
              <P>
                There's no mandatory arbitration here and no class-action waiver. If you're a consumer resident in the
                EU, UK, or another jurisdiction whose law entitles you to the protection of your local courts, this
                section doesn't take that away.
              </P>
            </Section>

            <Section n={21} title="Changes to these Terms">
              <P>
                We may update these Terms as the Service changes. When we do, we'll update the "Last updated" date at
                the top of this page.
              </P>
              <P>
                For changes that materially affect your rights, we'll give notice before they take effect — through the
                site and, if you have an account, by email — and we'll aim for at least 30 days' notice unless a
                shorter period is needed for legal or security reasons. Continuing to use the Service after a change
                takes effect means you accept it. If you'd rather not, you can delete your account.
              </P>
            </Section>

            <Section n={22} title="Everything else">
              <ul className="list-disc ml-5 text-text-primary/90 mb-3 space-y-1">
                <li>
                  <strong>Whole agreement.</strong> These Terms and the Privacy Policy are the entire agreement between
                  us about the Service, and replace anything said earlier about it.
                </li>
                <li>
                  <strong>If a clause fails.</strong> If any part of these Terms turns out to be unenforceable, the
                  rest stays in force and the unenforceable part is narrowed only as far as needed.
                </li>
                <li>
                  <strong>No waiver.</strong> If we don't enforce something straight away, we haven't given up the
                  right to enforce it later.
                </li>
                <li>
                  <strong>Assignment.</strong> You can't transfer your rights under these Terms without our consent. We
                  may transfer ours to a successor who takes over the Service, and we'll tell you if that happens.
                </li>
                <li>
                  <strong>Things outside our control.</strong> We're not liable for failures caused by events beyond
                  our reasonable control, including outages at the platforms and infrastructure providers we depend on.
                </li>
                <li>
                  <strong>No agency.</strong> These Terms don't make either of us the other's partner, employee, or
                  agent, and they don't make us an agent of any artist or platform we list.
                </li>
              </ul>
            </Section>

            <Section n={23} title="Contact">
              <P>
                Questions, corrections, takedown notices, account deletion, or anything else about these Terms:{' '}
                <a href="mailto:support@unstream.stream" className="text-accent-primary hover:text-accent-secondary transition-colors underline">
                  support@unstream.stream
                </a>
                .
              </P>
            </Section>
          </article>
        </div>
      </main>

      <Footer />
    </div>
  );
}

/** A numbered section, so support and email can point at "section 12" and mean it. */
function Section({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <section className="mb-8">
      <h3 id={`section-${n}`} className="font-display text-xl font-semibold text-text-primary mb-3">
        {n}. {title}
      </h3>
      {children}
    </section>
  );
}

function P({ children }: { children: React.ReactNode }) {
  return <p className="text-text-primary/90 leading-relaxed mb-3">{children}</p>;
}
