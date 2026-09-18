'use client';

import { useRouter } from 'next/navigation';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';

export default function ForbiddenPage() {
  const router = useRouter();
  const { t } = useTranslation('errorPages');
  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-4">
      <h1 className="text-4xl font-bold text-foreground">403</h1>
      <p className="text-muted-foreground">{t('forbidden.message')}</p>
      <Button onClick={() => router.back()}>{t('forbidden.back')}</Button>
    </div>
  );
}
