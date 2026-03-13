# github-productivity-utilities

## Локальный прогон test workflow через act

Для локального прогона integration test workflow в этом репозитории настроен `act`.

Что уже лежит в репозитории:

- `.actrc` — базовая конфигурация `act`
- `.secrets.example` — лаконичный шаблон локальных секретов для `act`
- `scripts/run-act-test.js` — кроссплатформенный Node.js-раннер для test workflow

### Что нужно сделать один раз

1. Убедиться, что запущен Docker Desktop.
2. Скопировать `.secrets.example` в `.secrets`.
3. Заменить placeholder в `.secrets` на реальный `ORG_PROJECT_TOKEN`.

`ORG_PROJECT_TOKEN` должен иметь права, достаточные для работы с sandbox Project V2 и связанными issue / PR.

`.secrets` нужен, потому что test workflow читают токен именно из `secrets.ORG_PROJECT_TOKEN`, а `act` подставляет такие значения из secret-file. `.env` для этого набора workflow не нужен.

### Что можно запускать

Поддерживаются workflow-ключи:

- `ensure-next-iteration-reminder`
- `link-pr-to-project`
- `reopen-issue-if-pr-open`
- `sync-sub-issue-sprint`
- `all`

### Примеры локального запуска

Кроссплатформенно через Node.js:

`node ./scripts/run-act-test.js --list`

`node ./scripts/run-act-test.js --workflow ensure-next-iteration-reminder`

`node ./scripts/run-act-test.js --workflow ensure-next-iteration-reminder --dry-run`

`node ./scripts/run-act-test.js --all`
