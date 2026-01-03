import { useEffect } from 'react';

export function RoadmapPage() {
  useEffect(() => {
    window.location.href = 'https://unstream.featurebase.app/roadmap';
  }, []);

  return (
    <div className="min-h-screen flex items-center justify-center">
      <p className="text-text-muted">Redirecting to roadmap...</p>
    </div>
  );
}
