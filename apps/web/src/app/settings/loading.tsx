export default function Loading() {
  return (
    <div className="page-container max-w-3xl">
      <div className="skeleton h-7 w-36 rounded-lg mb-6" />
      <div className="flex gap-1 border-b border-border mb-6">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="skeleton h-9 w-24 rounded-t-lg" />
        ))}
      </div>
      <div className="space-y-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="skeleton h-12 w-full rounded-lg" />
        ))}
      </div>
    </div>
  );
}
