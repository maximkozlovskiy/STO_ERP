export default function Loading() {
  return (
    <div className="page-container">
      <div className="page-header">
        <div className="skeleton h-7 w-36 rounded-lg" />
        <div className="skeleton h-9 w-40 rounded-lg" />
      </div>
      <div className="skeleton h-72 w-full rounded-xl mb-4" />
      <div className="space-y-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="skeleton h-12 w-full rounded-lg" />
        ))}
      </div>
    </div>
  );
}
