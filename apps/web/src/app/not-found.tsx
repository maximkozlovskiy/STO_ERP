import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-6">
      <div className="max-w-md w-full text-center space-y-4">
        <p className="text-6xl font-bold text-primary">404</p>
        <h2 className="text-xl font-semibold text-foreground">Сторінку не знайдено</h2>
        <p className="text-muted-foreground text-[14px]">
          Вказаної сторінки не існує або вона була переміщена.
        </p>
        <Link
          href="/dashboard"
          className="inline-block px-4 py-2 rounded-lg bg-primary text-white text-[14px] font-medium hover:bg-primary-dark transition-colors"
        >
          На головну
        </Link>
      </div>
    </div>
  );
}
