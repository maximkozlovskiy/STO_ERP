export default function Loading() {
  return (
    <div className="page-container">
      <div className="flex items-center justify-between mb-6">
        <div className="skeleton h-7 w-44 rounded-lg" />
        <div className="skeleton h-9 w-36 rounded-lg" />
      </div>
      <div className="flex gap-3 mb-4">
        <div className="skeleton h-9 w-36 rounded-lg" />
        <div className="skeleton h-9 w-36 rounded-lg" />
      </div>
      <div className="space-y-1">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="skeleton h-11 w-full rounded-lg" />
        ))}
      </div>
    </div>
  );
}
