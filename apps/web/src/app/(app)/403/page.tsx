'use client';

import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';

export default function ForbiddenPage() {
  const router = useRouter();
  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-4">
      <h1 className="text-4xl font-bold text-foreground">403</h1>
      <p className="text-muted-foreground">Недостатньо прав для доступу до цієї сторінки</p>
      <Button onClick={() => router.back()}>Назад</Button>
    </div>
  );
}
