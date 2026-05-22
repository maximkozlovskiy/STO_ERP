---
name: feedback-commit-after-phase
description: Після кожної завершеної фази STO ERP обов'язково робити git commit з усіма змінами фази
metadata:
  type: feedback
---

Після завершення кожної фази (всі задачі `[x]` в PHASES.md) — одразу робити git commit.

**Why:** Користувач явно попросив: "роби коміт після кожної фази".

**How to apply:** Як тільки остання задача фази відмічена `[x]` в PHASES.md — без додаткового запиту виконати `/sto-git` flow: `git status` → `git add` → `git commit` з повідомленням у форматі `feat(phaseN): <назва фази>`. Не чекати підтвердження від користувача.
