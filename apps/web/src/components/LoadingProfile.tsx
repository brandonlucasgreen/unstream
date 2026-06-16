export function LoadingProfile() {
  return (
    <div className="flex flex-col items-center justify-center py-16">
      <div className="animate-spin rounded-full h-12 w-12 border-2 border-accent-primary border-t-transparent mb-4" />
      <p className="text-text-muted">Loading profile…</p>
    </div>
  );
}