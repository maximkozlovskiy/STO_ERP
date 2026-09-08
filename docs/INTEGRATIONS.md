# INTEGRATIONS — зовнішні провайдери (звірка shape + тестові креди)

> Аудит 2026-09-08: звірка mock-first коду з живою офіційною докою + пошук ПУБЛІЧНИХ
> sandbox/тест-кредів. Усі провайдери дають **безкоштовний self-service тест-доступ**
> (реєстрація акаунта), **без податкових договорів/верифікацій**. Zero-signup публічного
> токена немає в жодного — тестовий токен генерується у власному кабінеті.
>
> Правило офлайн-незалежності (ADR-005): усі зовнішні виклики — через BullMQ чергу, ніколи
> прямий синхронний виклик у request-шляху.

---

## Зведена таблиця

| Провайдер   | Файл                                                          | Тест-доступ                                                                           | Shape vs код                                       | Статус                                 |
| ----------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------- | -------------------------------------- |
| LiqPay      | `payments/gateways/liqpay.gateway.ts`                         | ключі `sandbox_*` після реєстрації                                                    | ✅ підпис/status точні; checkout GET vs POST-форма | звірити QR на живому                   |
| Checkbox    | `payments/fiscal/checkbox.provider.ts` + `checkbox.client.ts` | my.checkbox.ua → тест-акаунт + тест-сертифікат; sandbox-хост `dev-api.checkbox.in.ua` | ✅ endpoint/auth точні                             | косметика (хост, X-Client-\*)          |
| Вчасно.Каса | `payments/fiscal/vchasno.provider.ts`                         | реєстрація кабінету → авто тест-каса, токен per-каса                                  | ✅ **переписано під v3** (74fa2254)                | звірити імена полів чека на живій касі |
| Нова Пошта  | `purchase-orders/delivery/nova-poshta.*`                      | `new.novaposhta.ua → Безпека → Створити ключ` (бойовий ключ, тест-статус `0000`)      | ✅ транспорт; mapStatus **виправлено** (8e6c8f78)  | —                                      |
| monobank    | `payments/monobank.client.ts`                                 | тест-токен у кабінеті api.monobank.ua; тест-картки за Luhn                            | ✅ endpoint/status точні                           | звірити на живому                      |

---

## LiqPay

- **Тест-доступ:** реєстрація акаунта → ключі з префіксом `sandbox_` (тест-режим неявний), або
  `sandbox: 1` у payload. Без верифікації мерчанта/банку. Тест-картки: `4242424242424242` (успіх),
  `4000000000000002` (відмова), `sandbox_token`.
- **Підтверджено:** база `https://www.liqpay.ua`; `data=base64(JSON)`,
  `signature=base64(SHA1(private+data+private))` — байт-точно (SDK); версія `3`; status POST
  `/api/request` action=status.
- **Звірити на живому:** checkout ми будуємо GET-URL `/api/3/checkout?data=..&signature=..`; дока/SDK
  використовують POST-форму `/api/3/checkout/` (працює обома, але контрактно — POST-форма). `result_url`/
  `server_url` не шлемо (свідомо — polling status, offline-first). `sandbox`-поле не задаємо (працює лише
  з `sandbox_`-ключами; для force-sandbox з prod-ключами — додати конфіг).
- Джерела: liqpay.ua/en/doc/api/testing · /documentation/en/data_signature · github.com/liqpay/sdk-python

## Checkbox (ПРРО)

- **Тест-доступ:** my.checkbox.ua → тест-акаунт + тест-сертифікат; тест-чеки НЕ йдуть у ДПС. Без договору.
  Sandbox-хост: `https://dev-api.checkbox.in.ua`.
- **Підтверджено (OpenAPI api.checkbox.in.ua/api/openapi.json):** `POST /api/v1/cashier/signinPinCode`
  (`X-License-Key` + `{pin_code}` → JWT), `POST /api/v1/shifts`, `/api/v1/shifts/close`,
  `/api/v1/receipts/sell` (Bearer JWT) — збігається з нашим `checkbox.client.ts`.
- **Косметика:** канонічний хост `api.checkbox.**in.**ua` (наш дефолт `api.checkbox.ua`); sandbox-хост
  зробити конфігурованим; додати `X-Client-Name`/`X-Client-Version` заголовки.
- Джерела: checkbox.ua/api-integration · wiki.checkbox.ua/api · api.checkbox.in.ua/api/docs

## Вчасно.Каса (ПРРО) — переписано 2026-09-08

- **Тест-доступ:** реєстрація кабінету (з ЕЦП) → авто тест-точка + тест-каса. Токен per-каса:
  Торгові точки → каса → Налаштування → Токен → Згенерувати. Без договору.
- **Реальний контракт (v3, звірено з wiki + Postman):** ЄДИНИЙ dispatcher `POST /api/v3/fiscal/execute`,
  операція = `task` у `{fiscal:{task,...}}` (0=відкрити зміну, 1=чек, 11=Z-звіт, 18=статус).
  Auth: `Authorization: <token>` **БЕЗ `Bearer`**.
- **⚠️ Було хибно (виправлено):** наш попередній shape був v1 REST (`/api/v1/shifts/open`,
  `/receipts/sell`) + Bearer → 401/404. Переписано під v3 (коміт 74fa2254).
- **Звірити на живій касі:** точні ІМЕНА ПОЛІВ payload чека (task:1 goods/payment) та id у відповідях
  (extractId толерантний до варіантів shift_id/fisn/…). Транспорт/task/auth зафіксовані.
- Джерела: wiki-kasa.vchasno.ua/uk/cloud/CloudAPI · Postman documenter.getpostman.com/view/26351974/2s93shy9To
  · kasa.vchasno.com.ua/formuvannia-tokena

## Нова Пошта (доставка) — mapStatus виправлено 2026-09-08

- **Тест-доступ:** `new.novaposhta.ua → Налаштування → Безпека → Створити ключ` (безкоштовно). Ключ
  **бойовий** (окремого sandbox нема); тест-статус `0000`; невідомий ЕН → `success:true`, `data:[]`.
- **Підтверджено:** ЄДИНИЙ `POST https://api.novaposhta.ua/v2.0/json/`,
  `{apiKey, modelName:'TrackingDocument', calledMethod:'getStatusDocuments', methodProperties}`,
  **apiKey у ТІЛІ** (не заголовок).
- **StatusCode → DeliveryStatus (звірено, коміт 8e6c8f78):** 1→PENDING; 2→RETURNED(видалено);
  3→NOT_FOUND; 7/8→ARRIVED; 9/10/11→DELIVERED; **102/103/105/106→RETURNED (термінальні)**;
  4/5/6/12/41/101/104/111/112→IN_TRANSIT. Термінальні коди зупиняють nova-poshta-polling
  (`TERMINAL={DELIVERED,RETURNED,NOT_FOUND}`). Раніше 102/106 падали в IN_TRANSIT → нескінченний polling.
- Джерела: devcenter.novaposhta.ua (getStatusDocuments) · api-portal.novapost.com (API-ключі)

## monobank (еквайринг)

- **Тест-доступ:** тест-токен вмикається у кабінеті `api.monobank.ua` (свій акаунт), без acquiring-договору.
  Тест-картки — будь-які за Luhn, без реальної авторизації; Apple/Google Pay сховані.
- **Підтверджено:** `POST /api/merchant/invoice/create` (→ `invoiceId`+`pageUrl`),
  `GET /api/merchant/invoice/status?invoiceId=` , auth `X-Token`. Status enum:
  created/processing/hold/success/failure/reversed/expired — усі 7 покриті нашим мапінгом
  (success→paid, failure/reversed→failed, expired→expired, решта→pending).
- **Примітка:** `hold` (дворівнева оплата) виникає лише при `paymentType:'hold'`; ми шлемо default
  `debit` → `hold` не з'явиться, мапінг у pending безпечний.
- Джерела: monobank.ua/en/api-docs/acquiring · api.monobank.ua/docs/acquiring.html
