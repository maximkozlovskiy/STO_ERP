'use client';

import { useTranslation } from 'react-i18next';
import { QRCodeSVG } from 'qrcode.react';
import { Copy, ExternalLink } from 'lucide-react';
import { fmtDateTime } from '@/lib/format';
import { toast } from '@/lib/toast';
import { Button } from './button';
import { Modal, ModalFooter } from './modal';

export interface TelegramLink {
  url: string;
  expiresAt: string;
}

interface TelegramLinkModalProps {
  open: boolean;
  link: TelegramLink | null;
  onClose: () => void;
}

/**
 * Посилання підписки на Telegram-бот і його QR (BR-AUT-041): клієнт сканує телефоном прямо з
 * екрана приймальника. Окремий chunk — QR-бібліотека не входить у бандл сторінки, доки вікно не
 * відкрили (бюджет сторінки контрагентів).
 */
export default function TelegramLinkModal({ open, link, onClose }: TelegramLinkModalProps) {
  const { t } = useTranslation('automation');

  const copy = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link.url);
      toast.success(t('telegram.copied'));
    } catch {
      /* буфер обміну недоступний (http, політика браузера) — посилання видно й так */
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('telegram.linkTitle')}
      size="sm"
      footer={
        <ModalFooter>
          <Button variant="outline" onClick={onClose}>
            {t('card.close')}
          </Button>
        </ModalFooter>
      }
    >
      {link && (
        <div className="flex flex-col items-center gap-3 text-center" data-testid="telegram-link">
          <p className="text-[13px] text-muted-foreground">{t('telegram.linkHint')}</p>
          <div className="rounded-lg bg-white p-3">
            <QRCodeSVG value={link.url} size={200} title={t('telegram.qrAlt')} />
          </div>
          <code
            className="w-full rounded bg-secondary px-2 py-1 text-[12px] text-foreground break-all"
            data-testid="telegram-link-url"
          >
            {link.url}
          </code>
          <div className="flex flex-wrap justify-center gap-2">
            <Button variant="outline" size="sm" onClick={() => void copy()}>
              <Copy className="h-3.5 w-3.5" aria-hidden="true" />
              {t('telegram.copy')}
            </Button>
            <a
              href={link.url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex h-8 items-center gap-1.5 rounded border border-border px-3 text-[13px] font-medium text-foreground hover:bg-secondary"
            >
              <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
              {t('telegram.open')}
            </a>
          </div>
          <p className="text-[12px] text-muted-foreground">
            {t('telegram.linkExpires', { date: fmtDateTime(link.expiresAt) })}
          </p>
        </div>
      )}
    </Modal>
  );
}
