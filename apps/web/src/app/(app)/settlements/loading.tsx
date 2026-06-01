export default function Loading() {
  return (
    <div className="page-container">
      <div className="page-header">
        <div className="skeleton h-7 w-44 rounded-lg" />
      </div>
      <div className="grid grid-cols-3 gap-4">
        <div className="space-y-2">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="skeleton h-12 w-full rounded-lg" />
          ))}
        </div>
        <div className="col-span-2 skeleton h-96 rounded-xl" />
      </div>
    </div>
  );
}
