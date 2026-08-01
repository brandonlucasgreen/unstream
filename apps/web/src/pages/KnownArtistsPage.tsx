import { ArtistIndexPage } from '../components/ArtistIndexPage';

export function KnownArtistsPage() {
  return (
    <ArtistIndexPage
      title="Artists You Know"
      subtitle={(n) => `${n} artist${n !== 1 ? 's' : ''} you know ${n !== 1 ? 'have' : 'has'} music available for direct purchase`}
      fetchUrl="/api/artist-directory?scope=known"
      loadingLabel="Loading artists you know"
      linkPrefix="/artist"
    />
  );
}
