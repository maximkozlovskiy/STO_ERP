export default function Loading() {
  return (
    <div className="page-container">
      <div className="skeleton h-7 w-24 rounded-lg mb-6" />
      <div className="flex gap-1 mb-6">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="skeleton h-9 w-32 rounded-lg" />
        ))}
      </div>
      <div className="flex gap-3 mb-4">
        <div className="skeleton h-9 flex-1 rounded-lg" />
        <div className="skeleton h-9 w-40 rounded-lg" />
      </div>
      <div className="space-y-1">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="skeleton h-11 w-full rounded-lg" />
        ))}
      </div>
    </div>
  );
}
