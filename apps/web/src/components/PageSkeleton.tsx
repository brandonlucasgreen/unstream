import { Header } from './Header';
import { Footer } from './Footer';
import { SkeletonScreen } from './Skeleton';

/**
 * Full-page loading shell. Renders the real header and footer — they need no
 * data — and puts a content skeleton where the page body will land, so a
 * loading page still looks like the app instead of a blank screen.
 */
export function PageSkeleton({
  label,
  maxWidth = 'max-w-2xl',
  children,
}: {
  label: string;
  maxWidth?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-bg-primary text-text-primary flex flex-col">
      <Header />
      <main className="flex-1 p-6">
        <div className={`${maxWidth} mx-auto`}>
          <SkeletonScreen label={label}>{children}</SkeletonScreen>
        </div>
      </main>
      <Footer />
    </div>
  );
}
