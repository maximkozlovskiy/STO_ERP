export default function Loading() {
  return (
    <div className="page-container max-w-4xl">
      <div className="flex items-center gap-3 mb-6">
        <div className="skeleton h-5 w-16 rounded" />
        <div className="skeleton h-7 w-48 rounded-lg" />
        <div className="skeleton h-6 w-20 rounded-full ml-auto" />
      </div>
      <div className="skeleton h-56 w-full rounded-xl mb-6" />
      <div className="flex gap-2">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="skeleton h-9 w-28 rounded-lg" />
        ))}
      </div>
    </div>
  );
}
