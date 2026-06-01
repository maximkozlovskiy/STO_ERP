export default function Loading() {
  return (
    <div className="page-container">
      <div className="flex items-center gap-3 mb-6">
        <div className="skeleton h-5 w-5 rounded" />
        <div className="skeleton h-7 w-48 rounded-lg" />
        <div className="skeleton h-6 w-20 rounded-full ml-auto" />
      </div>
      <div className="grid grid-cols-3 gap-4 mb-6">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="skeleton h-24 rounded-xl" />
        ))}
      </div>
      <div className="space-y-3">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="skeleton h-14 w-full rounded-lg" />
        ))}
      </div>
    </div>
  );
}
