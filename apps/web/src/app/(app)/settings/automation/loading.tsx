export default function Loading() {
  return (
    <div className="page-fill p-4 md:p-6">
      <div className="skeleton h-7 w-48 rounded-lg mb-4" />
      <div className="flex gap-2 mb-4">
        <div className="skeleton h-9 w-24 rounded-lg" />
        <div className="skeleton h-9 w-24 rounded-lg" />
      </div>
      <div className="flex flex-wrap gap-3 mb-4">
        <div className="skeleton h-8 w-72 rounded-lg" />
        <div className="skeleton h-8 w-56 rounded-lg" />
        <div className="skeleton h-8 w-28 rounded-lg ml-auto" />
      </div>
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="skeleton h-12 w-full rounded-lg mb-1" />
      ))}
    </div>
  );
}
