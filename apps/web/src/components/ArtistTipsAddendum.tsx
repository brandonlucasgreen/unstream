// The artist addendum (docs/specs/artist-patronage-spec.md §6, gate 2), accepted when an artist
// connects Stripe. Its version is ARTIST_ADDENDUM_VERSION in api/shared/tips.ts: change the words,
// bump the version.

export function ArtistTipsAddendum() {
  return (
    <div className="text-xs text-text-secondary space-y-1.5 p-3 rounded-lg bg-bg-primary border border-border">
      <p className="font-medium text-text-primary">Taking tips through Unstream</p>
      <ul className="list-disc ml-4 space-y-1">
        <li>Fans pay you directly, into your own Stripe account. You're the seller of record, and tips are for your music.</li>
        <li>Stripe's processing fees come out of your Stripe balance. Unstream's fee is 0% unless you choose to share up to 5%.</li>
        <li>Refunds and disputes are yours to handle, in your Stripe dashboard. Refunding a tip also refunds any Unstream fee on it.</li>
        <li>Goals are trackers, not pledges: say so honestly, and don't promise fans a refund if a goal isn't met.</li>
        <li>You're responsible for any taxes on what you receive.</li>
        <li>Unstream reviews each artist's first setup, and can switch tips off for abuse or for a profile that misrepresents who runs it.</li>
      </ul>
      <p>
        These add to the <a href="/terms#section-14" className="underline" target="_blank" rel="noopener noreferrer">Terms of Use</a>.
      </p>
    </div>
  );
}
