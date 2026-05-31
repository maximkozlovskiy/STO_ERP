export default function Loading() {
  return (
    <div className="page-container">
      <div className="skeleton h-7 w-36 rounded-lg mb-6" />
      <div className="grid grid-cols-2 gap-4 mb-6 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="skeleton h-28 rounded-xl" />
        ))}
      </div>
      <div className="skeleton h-64 w-full rounded-xl" />
    </div>
  );
}
