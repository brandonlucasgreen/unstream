// Which Bandcamp account an artist is: shared by the search backend and the web client,
// which both have to tell two same-name artists apart when merging MusicBrainz data in.
// Pure, no imports, so it runs in Node and in the browser alike.


/**
 * The subdomain of a `*.bandcamp.com` URL, or null for anything else.
 *
 * Custom domains deliberately return null: `artist.com` may well be a Bandcamp site,
 * but we cannot tell from the URL, and guessing would make the identity comparison
 * below produce false conflicts.
 */
export function bandcampSubdomainOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const { hostname } = new URL(url);
    if (!hostname.endsWith('.bandcamp.com')) return null;
    return hostname.slice(0, -'.bandcamp.com'.length).toLowerCase() || null;
  } catch {
    return null;
  }
}

/**
 * Whether MusicBrainz and the subdomain probe disagree about which Bandcamp account
 * belongs to an artist.
 *
 * The probe matches on name, so a homonym passes it: searching "Honeycrush" accepts
 * `honeycrush.bandcamp.com`, a real and unrelated Orlando band called "Honey Crush",
 * because the names normalize identically and the account has releases. Both of the
 * probe's checks did their job; neither can see that this is someone else.
 *
 * MusicBrainz can. When MB names a specific Bandcamp subdomain for the artist and the
 * probe matched a different one, they are two different accounts, and the MB artist's
 * location, socials and Wikipedia entry do not belong on the probe's result. This holds
 * even when MB's own link is retired — the claim identifies the artist, the HTTP status
 * only says whether the page still loads.
 *
 * Returns false unless both sides actually named a subdomain. Absence is not conflict.
 */
export function bandcampSubdomainConflicts(
  mbSubdomain: string | null | undefined,
  resultUrl: string | null | undefined,
): boolean {
  const probed = bandcampSubdomainOf(resultUrl);
  if (!mbSubdomain || !probed) return false;
  return mbSubdomain.toLowerCase() !== probed;
}

/**
 * Whether a card with an artist's name is that artist, given the Bandcamp account we know
 * them by (`knownSubdomain`: MusicBrainz's, or a stored or claimed profile's).
 *
 * Usually a name match is enough, unless the two sides name different Bandcamp accounts
 * (bandcampSubdomainConflicts). But when several artists go by this exact name, the name
 * says nothing about which of them a card is: Paracosm is a hyperpop artist in Los Angeles,
 * a punk band in Orlando and a rock band in Sofia, and every "Paracosm" card matches all
 * three. Merging by name put Orlando's site, socials and city on the Sofia band's Bandcamp
 * card. So when the name is shared, only the same Bandcamp account on both sides is
 * evidence; without it, the artist gets a card of their own instead of someone else's.
 */
export function nameMatchIsSameArtist(
  knownSubdomain: string | null | undefined,
  nameIsShared: boolean,
  resultUrl: string | null | undefined,
): boolean {
  if (bandcampSubdomainConflicts(knownSubdomain, resultUrl)) return false;
  if (!nameIsShared) return true;
  const probed = bandcampSubdomainOf(resultUrl);
  return !!knownSubdomain && probed === knownSubdomain.toLowerCase();
}
