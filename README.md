# github-productivity-utilities

> [!NOTE]
> Этот репозиторий развивается в формате **LLM-assisted development**.
> Это не мой основной стек, и у меня не будет достаточно времени на глубокую ручную долгосрочную поддержку, поэтому проект намеренно опирается на автоматизацию, воспроизводимые workflow и изменения, которые можно проверять тестами.

## Workflow-файлы

| Workflow-файл | Описание |
| --- | --- |
| [`./.github/workflows/ensure-next-iteration-reminder.yml`](./.github/workflows/ensure-next-iteration-reminder.yml) | Гарантирует, что в целевой итерации есть reminder draft, чтобы lane следующего спринта оставался видимым. |
| [`./.github/workflows/ai-label-issue.yml`](./.github/workflows/ai-label-issue.yml) | **Deprecated.** Сохранён только для совместимости с `Dreddbook/scrum-dreddbook-backlog`; новые подключения не поддерживаются. |
| [`./.github/workflows/ai-scrum-review-issue.yml`](./.github/workflows/ai-scrum-review-issue.yml) | **Deprecated.** Сохранён только для совместимости с `Dreddbook/scrum-dreddbook-backlog`; новые подключения не поддерживаются. |
| [`./.github/workflows/link-pr-to-project.yml`](./.github/workflows/link-pr-to-project.yml) | Добавляет PR в Project V2, копирует sprint и assignee из связанной issue и ставит статус Done при закрытии. Когда все открытые связанные PR уже в статусе ревью, переводит и backlog issue в этот статус, не меняя её ответственных. После запроса изменений человеком возвращает PR и связанную issue в Todo. Для синхронизации assignee токену нужны права на запись в issues PR-репозитория. |
| [`./.github/workflows/reopen-issue-if-pr-open.yml`](./.github/workflows/reopen-issue-if-pr-open.yml) | Переоткрывает issue автоматически, если связанные PR, которые должны её закрыть, всё ещё открыты. |
| [`./.github/workflows/safe-dependabot-pr-link.yml`](./.github/workflows/safe-dependabot-pr-link.yml) | Безопасно синхронизирует PR от Dependabot по списку репозиториев: принимает многострочный `repositories`, открытым ставит стартовый статус, закрытым — финальный. |
| [`./.github/workflows/sync-sub-issue-sprint.yml`](./.github/workflows/sync-sub-issue-sprint.yml) | Наследует sprint/iteration-метаданные из родительской issue в её sub-issue. `action: reconcile` сверяет уже существующие sub-issues после изменения Sprint родителя; поддерживает `dry_run`. |
| [`./.github/workflows/collect-linked-context.yml`](./.github/workflows/collect-linked-context.yml) | Собирает контекст по ссылкам на issue, PR, releases и commits. |
| [`./.github/workflows/gemini-generate-text.yml`](./.github/workflows/gemini-generate-text.yml) | Генерирует текст через Gemini API с проверкой пустого ответа и переключением на резервную модель. |
| [`./.github/workflows/copilot-generate-text.yml`](./.github/workflows/copilot-generate-text.yml) | **Deprecated.** GitHub убрал бесплатные модели из Copilot API; используйте `gemini-generate-text.yml`. |

## TypeScript-реализации

Публичным интерфейсом автоматизаций остаются reusable workflow в `.github/workflows`. Каждый workflow загружает исходный TypeScript из `src/scripts` и запускает его через `actions/github-script@v8` с авторизованным GitHub-клиентом. Сборки `dist` и установки npm-зависимостей при запуске нет. В YAML остаются события, permissions, secrets, авторизация и оркестрация jobs.

Все прежние inputs, secrets, defaults и правила обработки сохранены. В каждом reusable workflow checkout реализации использует `job.workflow_sha`: тесты выполняют исходный код из проверяемого коммита, а вызов workflow через `@tag` — код из коммита этого тега. Внешним репозиториям не нужно отдельно выбирать ref реализации.

Новые правила не включаются в репозиториях-потребителях автоматически. Для периодической сверки Sprint caller вызывает `sync-sub-issue-sprint.yml` с `action: reconcile`. Ревью-назначения в `link-pr-to-project.yml` требуют добавить в caller события `pull_request: review_request_removed` и `pull_request_review: [submitted, dismissed]`. При обычном комментарии без решения assignee не меняются.

Локальные проверки TypeScript:

```bash
npm ci
npm run check
```

TypeScript используется в форме, которую Node.js 24 запускает напрямую. `npm` нужен только для проверки типов и локальных unit-тестов, не для запуска автоматизаций.

## Локальный прогон test workflow через act

Для локального прогона integration test workflow в этом репозитории настроен `act`.

Что уже лежит в репозитории:

- `.actrc` — базовая конфигурация `act`
- `.secrets.example` — шаблон локальных секретов для режимов `pat` и `app`
- `scripts/run-act-test.js` — кроссплатформенный Node.js-раннер для test workflow

### Что нужно сделать один раз

1. Убедиться, что запущен Docker Desktop.
2. Скопировать `.secrets.example` в `.secrets`.
3. Для режима `pat` заменить placeholder в `.secrets` на реальный `ORG_PROJECT_TOKEN`.
4. Для режима `app` заполнить `ORG_AUTOMATION_APP_ID` и `ORG_AUTOMATION_APP_PRIVATE_KEY`.

`ORG_PROJECT_TOKEN` должен иметь права, достаточные для работы с sandbox Project V2 и связанными issue / PR. Для `link-pr-to-project.yml`, если включена синхронизация assignee, токену также нужны права `issues: write` на репозиторий PR.

`USER_COPILOT_FGPAT` — отдельный FGPAT с правом `Copilot Requests`; используется только для Copilot workflow.

`ORG_AUTOMATION_APP_PRIVATE_KEY` для локального `act` удобнее хранить одной строкой с литералами `\n` между строками ключа.

`.secrets` нужен, потому что test workflow теперь поддерживают два auth-режима:

- `pat` — через `secrets.ORG_PROJECT_TOKEN`, с user-owned sandbox: проект `ViRGiL175#10` и репозиторий `ViRGiL175/github-productivity-utilities`
- `app` — через `secrets.ORG_AUTOMATION_APP_ID` и `secrets.ORG_AUTOMATION_APP_PRIVATE_KEY`, с org-owned sandbox: проект `ViRGiL-GH-Productivity#1` и репозиторий `ViRGiL-GH-Productivity/scrum-test-backlog`

`act` подставляет эти значения из secret-file. `.env` для этого набора workflow не нужен.

### Что можно запускать

Поддерживаются test workflow-файлы:

- `test-ai-label-issue.yml`
- `test-ai-scrum-review-issue.yml`
- `test-copilot-generate-text.yml`
- `test-ensure-next-iteration-reminder.yml`
- `test-link-pr-to-project.yml`
- `test-reopen-issue-if-pr-open.yml`
- `test-safe-dependabot-pr-link.yml`
- `test-sync-sub-issue-sprint.yml`

Если параметр `--files` не указан, раннер по умолчанию запускает все test workflow по очереди.

### Примеры локального запуска

Кроссплатформенно через Node.js:

`node ./scripts/run-act-test.js --list`

`node ./scripts/run-act-test.js --auth-mode pat`

`node ./scripts/run-act-test.js --files test-ensure-next-iteration-reminder.yml --auth-mode pat`

`node ./scripts/run-act-test.js --files test-ensure-next-iteration-reminder.yml --auth-mode app`

`node ./scripts/run-act-test.js --files test-ensure-next-iteration-reminder.yml test-link-pr-to-project.yml --auth-mode app`

Для `test-copilot-generate-text.yml` нужен `USER_COPILOT_FGPAT` с permission `Copilot Requests`, потому что это живой integration test через реальный Copilot SDK.
