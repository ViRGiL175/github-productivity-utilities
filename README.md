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

`ORG_AUTOMATION_APP_PRIVATE_KEY` для локального `act` удобнее хранить одной строкой с литералами `\n` между строками ключа.

`.secrets` нужен, потому что test workflow теперь поддерживают два auth-режима:

- `pat` — через `secrets.ORG_PROJECT_TOKEN`, с user-owned sandbox: проект `ViRGiL175#10` и репозиторий `ViRGiL175/github-productivity-utilities`
- `app` — через `secrets.ORG_AUTOMATION_APP_ID` и `secrets.ORG_AUTOMATION_APP_PRIVATE_KEY`, с org-owned sandbox: проект `ViRGiL-GH-Productivity#1` и репозиторий `ViRGiL-GH-Productivity/scrum-test-backlog`

`act` подставляет эти значения из secret-file. `.env` для этого набора workflow не нужен.

### Что можно запускать

Поддерживаются test workflow-файлы:

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

## Установка GitHub Actions secret через CLI

В репозитории есть кроссплатформенный Node.js-скрипт `scripts/set-github-secret.js`, который оборачивает `gh` и позволяет:

- задать secret в одном конкретном репозитории;
- массово проставить один и тот же secret во всех репозиториях организации.

### Требования

1. Установить GitHub CLI (`gh`).
2. Выполнить `gh auth login` или передать `GH_TOKEN` / `GITHUB_TOKEN`.
3. Использовать токен / учётку с правами на изменение Actions secrets в целевых репозиториях.

Если в корне проекта есть `.env`, скрипт автоматически подхватит переменные из него, не перетирая уже заданные env.

### Как передать значение секрета

Поддерживаются несколько способов:

- `--value "..."` — inline-значение (наименее безопасный вариант);
- `--value-env SOME_VAR` — взять значение из переменной окружения;
- `--value-file ./path/to/file.txt` — прочитать значение из файла;
- `GITHUB_SECRET_VALUE` — дефолтная env-переменная;
- stdin — можно передать значение пайпом.

### Примеры

Установить secret в один репозиторий:

`node ./scripts/set-github-secret.js --name ORG_PROJECT_TOKEN --repo ViRGiL175/github-productivity-utilities --value-env ORG_PROJECT_TOKEN`

Сделать dry-run для всех репозиториев организации:

`node ./scripts/set-github-secret.js --name ORG_PROJECT_TOKEN --org ViRGiL-GH-Productivity --all-repos --value-env ORG_PROJECT_TOKEN --dry-run`

Применить secret ко всем репозиториям организации без интерактивного подтверждения:

`node ./scripts/set-github-secret.js --name ORG_PROJECT_TOKEN --org ViRGiL-GH-Productivity --all-repos --value-file ./.tmp/org-project-token.txt --yes`

PowerShell / stdin-вариант:

`Get-Content ./.tmp/token.txt | node ./scripts/set-github-secret.js --name ORG_PROJECT_TOKEN --repo ViRGiL175/github-productivity-utilities`

По умолчанию массовый режим пропускает archived, disabled и fork-репозитории. При необходимости это можно переопределить флагами `--include-archived`, `--include-disabled` и `--include-forks`.
