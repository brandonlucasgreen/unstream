import { useEffect } from 'react';

export function RoadmapPage() {
  useEffect(() => {
    window.location.href = 'https://github.com/users/brandonlucasgreen/projects/4';
  }, []);

  return (
    <div className="min-h-screen flex items-center justify-center">
      <p className="text-text-muted">Redirecting to roadmap...</p>
    </div>
  );
}
