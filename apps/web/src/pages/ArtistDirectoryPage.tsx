import { ArtistIndexPage } from '../components/ArtistIndexPage';

export function ArtistDirectoryPage() {
  return (
    <ArtistIndexPage
      title="Indie Artist Index"
      subtitle={(n) => `${n} verified artist${n !== 1 ? 's' : ''} on platforms that pay fairly`}
      fetchUrl="/api/artist-directory"
      loadingLabel="Loading the artist index"
      linkPrefix="/a"
      cta={
        <>
          <strong className="font-semibold text-text-primary">
            Are you an independent human artist?
          </strong>{' '}
          Claim your Unstream page by searching for it above, then clicking the
          “Claim your artist page” link.
        </>
      }
    />
  );
}
