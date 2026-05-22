# STO ERP — Ресьорч технологій

> Дата: 22.05.2026 | Статус: Фінальні рекомендації

---

## 1. Docker Desktop → Rancher Desktop ⚠️ КРИТИЧНО

**Проблема:** Docker Desktop вимагає **платну підписку** для комерційного використання (>250 співробітників АБО >10 млн $ доходу). Оскільки STO ERP буде встановлено у клієнтів як комерційний продукт, це юридичний ризик.

**Рекомендація: Rancher Desktop**
- Ліцензія: Apache 2.0 — безплатно для будь-якого комерційного використання
- Використовує containerd + nerdctl або dockerd (сумісний з Docker API)
- WSL2-бекенд, аналогічний Docker Desktop
- Активно підтримується SUSE

**Що змінити в проекті:**
```bash
# Замість Docker Desktop — встановлювати Rancher Desktop
# В інсталяторі: winget install SUSE.RancherDesktop
# docker-compose команди залишаються ідентичними
```

**Альтернатива:** Podman Desktop (Red Hat, безплатний) — але менша сумісність з docker-compose.

---

## 2. Turborepo — залишаємо ✅

**Результат ресьорчу:** Turborepo залишається правильним вибором для STO ERP.

| Критерій | Turborepo | Nx |
|---|---|---|
| Складність налаштування | Мінімальна | Висока |
| Для невеликих команд | ✅ Ідеально | Надлишково |
| Distributed CI | ❌ | ✅ |
| Розуміння кодобази | Task runner | Full framework |
| Продуктивність (CI) | 25 хв | 22 хв (-16%) |

**Висновок:** Nx швидший на великих монорепо з розподіленим CI — нерелевантно для нашого випадку. Turborepo + pnpm workspaces — оптимальний стек для команди 1-5 розробників.

---

## 3. Prisma — залишаємо ✅

**Результат ресьорчу:** Prisma 7 суттєво скоротив розрив з Drizzle у продуктивності.

- Prisma: кращий DX, зрілий екосистем, schema-first, автоматичні міграції
- Drizzle: швидший, менший bundle, SQL-first TypeScript, актуальний для Edge/serverless

**Для STO ERP (локальний сервер, не serverless)** різниця у продуктивності несуттєва. Prisma виграє за зручністю роботи та кількістю матеріалів/прикладів.

---

## 4. WatermelonDB — залишаємо ✅

**Підтверджено:** WatermelonDB — правильний вибір для офлайн-планшетів механіків:
- Дані залишаються в інфраструктурі клієнта (data residency)
- Не залежить від зовнішніх сервісів
- Повністю offline-first
- PowerSync потребує хмарного сервісу → несумісно з вимогою "без інтернету"

---

## 5. Inno Setup — залишаємо ✅

**Результат ресьорчу:** Inno Setup у 2026 залишається актуальним для standalone desktop додатків.

- Інтегрується з CI/CD (GitHub Actions, Jenkins) через CLI
- Генерує .exe installer — простіше для кінцевих користувачів
- MSIX актуальний для enterprise-розгортання через Microsoft Store / Intune — не наш кейс
- Безплатний, зрілий, широко підтримуваний

---

## 6. Checkbox ПРРО — залишаємо ✅

**Підтверджено:** Checkbox.ua — провідний ПРРО №1 в Україні.
- Має REST API для інтеграції
- SDK доступні для різних мов (PHP, Laravel та ін.)
- Офіційний партнер ДПС України
- Зміни у формі чеків: Наказ МФУ від 22.11.2024 — потрібно враховувати при реалізації

**Стратегія інтеграції (вже в ADR-005):**
```typescript
// BullMQ черга FISCAL: 288 спроб × 5 хв = 24 години
// Dead Letter Queue → сповіщення адміна
// Офлайн-чеки зберігаються локально → відправляються при появі мережі
```

---

## 7. TurboSMS — підтверджено, додати fallback

**Результат ресьорчу:** TurboSMS — активний провайдер в Україні.
- REST API + SMPP + Viber
- Офіційний партнер Rakuten Viber
- Понад 60 готових інтеграцій

**Рекомендація:** Реалізувати абстракцію `SmsProvider` з можливістю зміни провайдера через `.env`, щоб не залежати від одного постачальника:

```typescript
// packages/shared/src/types/notifications.ts
interface SmsProvider {
  sendSms(phone: string, text: string): Promise<void>;
  sendViber(phone: string, text: string): Promise<void>;
}

// SMS_PROVIDER=turbosms | alphsms | kyivstar
// Провайдер читається з конфігу, всі йдуть через BullMQ
```

**Альтернативи:** AlphaSMS (UA), SMS-club (UA), Kyivstar Business SMS.

---

## Підсумкова таблиця технологічних рішень

| Компонент | Рішення | Статус | Примітка |
|---|---|---|---|
| Container runtime | **Rancher Desktop** | 🔄 Замінити | Docker Desktop → ліцензійний ризик |
| Monorepo tooling | **Turborepo** | ✅ Залишити | |
| ORM | **Prisma 5** | ✅ Залишити | |
| Mobile offline | **WatermelonDB** | ✅ Залишити | |
| Windows installer | **Inno Setup** | ✅ Залишити | |
| ПРРО | **Checkbox API** | ✅ Залишити | |
| SMS | **TurboSMS** | ✅ + абстракція | Додати fallback провайдер |
| Local TLS | **Caddy** | ✅ Залишити | Автоматичний self-signed |
| File storage | **MinIO** | ✅ Залишити | S3-сумісний, локальний |
| Queue | **BullMQ + Redis** | ✅ Залишити | AOF persistence |
