export default function Loading() {
  return (
    <div className="page-container">
      <div className="flex items-center gap-3 mb-6">
        <div className="skeleton h-5 w-5 rounded" />
        <div className="skeleton h-7 w-64 rounded-lg" />
      </div>
      <div className="grid grid-cols-2 gap-4 mb-6">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="skeleton h-10 rounded-lg" />
        ))}
      </div>
      <div className="space-y-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="skeleton h-12 w-full rounded-lg" />
        ))}
      </div>
    </div>
  );
}
