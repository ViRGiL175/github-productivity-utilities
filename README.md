# github-productivity-utilities

> [!NOTE]
> Этот репозиторий развивается в формате **LLM-assisted development**.
> Это не мой основной стек, и у меня не будет достаточно времени на глубокую ручную долгосрочную поддержку, поэтому проект намеренно опирается на автоматизацию, воспроизводимые workflow и изменения, которые можно проверять тестами.

## Workflow-файлы

| Workflow-файл | Описание |
| --- | --- |
| [`./.github/workflows/ensure-next-iteration-reminder.yml`](./.github/workflows/ensure-next-iteration-reminder.yml) | Гарантирует, что в целевой итерации есть reminder draft, чтобы lane следующего спринта оставался видимым. |
| [`./.github/workflows/link-pr-to-project.yml`](./.github/workflows/link-pr-to-project.yml) | Добавляет PR в Project V2, копирует sprint-метаданные из связанной issue и ставит статус Done при закрытии. |
| [`./.github/workflows/reopen-issue-if-pr-open.yml`](./.github/workflows/reopen-issue-if-pr-open.yml) | Переоткрывает issue автоматически, если связанные PR, которые должны её закрыть, всё ещё открыты. |
| [`./.github/workflows/sync-sub-issue-sprint.yml`](./.github/workflows/sync-sub-issue-sprint.yml) | Наследует sprint/iteration-метаданные из родительской issue в её sub-issue. |
| [`./.github/workflows/copilot-generate-text.yml`](./.github/workflows/copilot-generate-text.yml) | Reusable workflow для генерации текста через Copilot SDK. Требует `copilot_token` с правом `Copilot Requests`. Возвращает output `text`. |

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

`ORG_PROJECT_TOKEN` должен иметь права, достаточные для работы с sandbox Project V2 и связанными issue / PR.

`USER_COPILOT_FGPAT` — отдельный FGPAT с правом `Copilot Requests`; используется только для Copilot workflow.

`ORG_AUTOMATION_APP_PRIVATE_KEY` для локального `act` удобнее хранить одной строкой с литералами `\n` между строками ключа.

`.secrets` нужен, потому что test workflow теперь поддерживают два auth-режима:

- `pat` — через `secrets.ORG_PROJECT_TOKEN`, с user-owned sandbox: проект `ViRGiL175#10` и репозиторий `ViRGiL175/github-productivity-utilities`
- `app` — через `secrets.ORG_AUTOMATION_APP_ID` и `secrets.ORG_AUTOMATION_APP_PRIVATE_KEY`, с org-owned sandbox: проект `ViRGiL-GH-Productivity#1` и репозиторий `ViRGiL-GH-Productivity/scrum-test-backlog`

`act` подставляет эти значения из secret-file. `.env` для этого набора workflow не нужен.

### Что можно запускать

Поддерживаются test workflow-файлы:

- `test-copilot-generate-text.yml`
- `test-ensure-next-iteration-reminder.yml`
- `test-link-pr-to-project.yml`
- `test-reopen-issue-if-pr-open.yml`
- `test-sync-sub-issue-sprint.yml`

Если параметр `--files` не указан, раннер по умолчанию запускает все test workflow по очереди.

### Примеры локального запуска

Кроссплатформенно через Node.js:

`node ./scripts/run-act-test.js --list`

`node ./scripts/run-act-test.js --auth-mode pat`

`node ./scripts/run-act-test.js --files test-ensure-next-iteration-reminder.yml --auth-mode pat`

`node ./scripts/run-act-test.js --files test-ensure-next-iteration-reminder.yml --auth-mode app`

`node ./scripts/run-act-test.js --files test-ensure-next-iteration-reminder.yml test-link-pr-to-project.yml --auth-mode app`

`node ./scripts/run-act-test.js --files test-ensure-next-iteration-reminder.yml --auth-mode pat --dry-run`

Для `test-copilot-generate-text.yml` нужен `USER_COPILOT_FGPAT` с permission `Copilot Requests`, потому что это живой integration test через реальный Copilot SDK.
