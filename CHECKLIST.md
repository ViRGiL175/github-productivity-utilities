# Чек-лист: AI issue workflows

## Автолейблер (`ai-label-issue.yml`)

- [x] `workflow_call` inputs: `issue_url`, `allowed_fields` (список строк), `project_owner`, `project_number`
- [x] `workflow_dispatch` для ручного запуска с `issue_url` и `allowed_fields`
- [x] `allowed_fields` — обычный список строк; `labels`, `assignees`, `milestone` считаются issue-полями, остальные строки — Project V2 fields
- [x] Два режима авторизации: `auth_mode=pat` / `auth_mode=app` (те же секреты: `pat_token`, `app_id`, `app_private_key`, `installation_owner`)
- [x] Секрет `copilot_token` для вызова `copilot-generate-text.yml`
- [x] Шаг: собрать контекст ишью — title, body, labels, assignees, milestone
- [x] Шаг: собрать поля проекта (ProjectV2), варианты и доступные issue-параметры
- [x] Шаг: сформировать prompt только для автолейблинга и вызвать `copilot-generate-text.yml`
- [x] Шаг: распарсить ответ AI (JSON с полями или признак "не хватает данных")
- [x] Шаг: если хватает данных для автолейблинга — выставить только разрешённые issue/project поля
- [x] Шаг: если не хватает данных — поставить лейбл `ai-label-rejected`
- [x] Шаг: всегда ставить лейбл `ai-label-processed` (в конце, независимо от результата)
- [x] `permissions`: `issues: write`, `pull-requests: read`, `contents: read`

## Автоскрамер (`ai-scrum-review-issue.yml`)

- [x] `workflow_call` input: `issue_url`
- [x] `workflow_dispatch` для ручного запуска с `issue_url`
- [x] Два режима авторизации: `auth_mode=pat` / `auth_mode=app`
- [x] Секрет `copilot_token` для вызова `copilot-generate-text.yml`
- [x] Шаг: собрать контекст ишью — title, body, labels
- [x] Шаг: собрать issue templates вызывающего репозитория из `.github/ISSUE_TEMPLATE*`, чтобы AI учитывал локальные стандарты оформления
- [x] Шаг: сформировать prompt только для Scrum-ready review и вызвать `copilot-generate-text.yml`
- [x] Шаг: если история ready — поставить `ai-scrum-processed`
- [x] Шаг: если история не ready — поставить `ai-scrum-rejected`, `ai-scrum-processed` и оставить комментарий `AI Scrum review`

## Тесты (`test-ai-label-issue.yml`, `test-ai-scrum-review-issue.yml`)

- [x] `workflow_dispatch` с выбором `auth_mode` (pat/app)
- [x] `pull_request` триггер на соответствующие workflow-файлы
- [x] `concurrency` + `cancel-in-progress: false`
- [x] Guard `if: github.event.pull_request.head.repo.full_name == github.repository` на всех jobs
- [x] Label case 1: ишью с достаточным контекстом → issue label + project field выставлены, `ai-label-processed` есть
- [x] Label case 2: ишью без данных для автолейблинга → `ai-label-rejected` + `ai-label-processed`
- [x] Scrum case 1: Scrum-ready ишью → `ai-scrum-processed`, без `ai-scrum-rejected`
- [x] Scrum case 2: плохо оформленная история → `ai-scrum-rejected` + `ai-scrum-processed` + комментарий `AI Scrum review`
- [x] Cleanup: закрыть тестовые ишью и удалить ProjectV2 items (`if: always()`)
- [x] Базовая статическая проверка VS Code diagnostics пройдена
- [ ] `actionlint` не прогнан локально: `actionlint` не установлен
