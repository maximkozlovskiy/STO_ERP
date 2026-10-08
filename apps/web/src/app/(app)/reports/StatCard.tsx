export function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="bg-surface rounded-xl border border-border p-5">
      <div className="text-[13px] text-muted-foreground">{label}</div>
      <div className="text-2xl font-bold text-foreground mt-1 tabular-nums">{value}</div>
      {sub && <div className="text-[12px] text-muted-foreground mt-1">{sub}</div>}
    </div>
  );
}
