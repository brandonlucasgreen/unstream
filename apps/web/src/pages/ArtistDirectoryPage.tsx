import { ArtistIndexPage } from '../components/ArtistIndexPage';

export function ArtistDirectoryPage() {
  return (
    <ArtistIndexPage
      title="Indie Artist Index"
      subtitle={(n) => `${n} verified artist${n !== 1 ? 's' : ''} on platforms that pay fairly`}
      fetchUrl="/api/artist-directory"
      loadingLabel="Loading the artist index"
      linkPrefix="/a"
    />
  );
}
