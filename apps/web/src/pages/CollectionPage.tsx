import { AccountLayout } from '../components/AccountLayout';
import { CollectionSection } from '../components/CollectionSection';
import { BandcampConnect } from '../components/BandcampConnect';

/**
 * The records a fan actually bought.
 *
 * The Bandcamp connect panel lives here rather than on /settings, where it shipped. Connecting
 * is the one action that fills this page in, and the empty state used to have to send people to
 * a different page to find it — a dead end for anyone who arrived expecting a collection. It
 * keeps a stable `#bandcamp-connect` id because that empty state links straight to it.
 */
export function CollectionPage() {
  return (
    <AccountLayout
      title="My Collection"
      description="Releases you've bought, and what you choose to show on your public page."
    >
      <div className="space-y-10">
        <CollectionSection />

        <section
          id="bandcamp-connect"
          className="scroll-mt-24 p-6 rounded-lg bg-bg-secondary border border-border space-y-4"
        >
          <h2 className="text-lg font-semibold">Bandcamp collection</h2>
          <BandcampConnect />
        </section>
      </div>
    </AccountLayout>
  );
}
