# Проверка default через GitHub App

Изолированный тест для `ViRGiL-GH-Productivity#1`: issue в `scrum-test-backlog`, draft PR в `test-client` от `main`. Авторизация — существующие CI secrets App и штатный `actions/create-github-app-token`, без PAT и расширения прав.

Перед запуском в IAB открыть проектное single-select поле [Horizon diagnostic 2026-10-28](https://github.com/orgs/ViRGiL-GH-Productivity/projects/1/settings/fields/434389474) и выбрать у Inbox **Set as default**. Проверить бейдж **Default** до создания items. Это отдельное проектное поле, не одноимённое Issue field организации. Публичный GraphQL не предоставляет настройку default; тест не подменяет её записью значения.

Workflow `test-project-default.yml` запускается при push теста только в диагностическую ветку `gff-horizon-default-diagnostic`, а также объявляет `workflow_dispatch`. В main workflow не добавляется в рамках диагностики.

Тест использует настоящий `ProjectV2Repository.addContentToProject` → `addProjectV2ItemById`. Horizon и Status явно не присваиваются. Наблюдения сохраняются сразу после добавления, через 30 и 120 секунд; после 120 секунд оба типа должны иметь Inbox. Неудачная проверка также сохраняет JSON artifact и job summary. Интервал показывает наблюдаемое состояние после ожидания, не является сигналом завершения всех внутренних очередей GitHub.

Cleanup только закрывает собственные issue и PR: items, значения и диагностическая ветка клиента сохраняются. Ничего не удаляется и не сливается. После прогона снять default в IAB, сохранив доказательства. Рабочие проекты, код importer и существующие workflow не меняются.
