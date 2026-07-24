import { SkeletonScreen } from './Skeleton';
import { ArtistProfileSkeleton } from './LoadingSkeletons';

export function LoadingProfile() {
  return (
    <SkeletonScreen label="Loading profile">
      <ArtistProfileSkeleton />
    </SkeletonScreen>
  );
}
