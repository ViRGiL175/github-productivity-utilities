# Проверка default через GitHub App

Изолированный тест для `ViRGiL-GH-Productivity#1`: issue в `scrum-test-backlog`, draft PR в `test-client` от `main`. Авторизация — существующие CI secrets App и штатный `actions/create-github-app-token`, без PAT и расширения прав.

Перед запуском в IAB открыть проектное single-select поле [Horizon diagnostic 2026-10-28](https://github.com/orgs/ViRGiL-GH-Productivity/projects/1/settings/fields/434389474) и выбрать у Inbox **Set as default**. Проверить бейдж **Default** до создания items. Это отдельное проектное поле, не одноимённое Issue field организации. Публичный GraphQL не предоставляет настройку default; тест не подменяет её записью значения.

Workflow `test-project-default.yml` запускается при push теста только в диагностическую ветку `gff-horizon-default-diagnostic`, а также объявляет `workflow_dispatch`. В main workflow не добавляется в рамках диагностики.

Тест использует настоящий `ProjectV2Repository.addContentToProject` → `addProjectV2ItemById`. Horizon и Status явно не присваиваются. Наблюдения сохраняются сразу после добавления, через 30 и 120 секунд; после 120 секунд оба типа должны иметь Inbox. Неудачная проверка также сохраняет JSON artifact и job summary. Интервал показывает наблюдаемое состояние после ожидания, не является сигналом завершения всех внутренних очередей GitHub.

Cleanup только закрывает собственные issue и PR: items, значения и диагностическая ветка клиента сохраняются. Ничего не удаляется и не сливается. После прогона снять default в IAB, сохранив доказательства. Рабочие проекты, код importer и существующие workflow не меняются.

## Результат 2026-10-28

[CI run 40681709593](https://github.com/ViRGiL175/github-productivity-utilities/actions/runs/40681709593), коммит `f0f3964`: App-авторизация успешна; проверка ожидаемого Inbox упала. У [issue #128](https://github.com/ViRGiL-GH-Productivity/scrum-test-backlog/issues/128) и [PR #25](https://github.com/ViRGiL-GH-Productivity/test-client/pull/25) поле вернуло `null` сразу после добавления, через 30 и 120 секунд. Последние чтения: 11:42:14.821 и 11:42:15.025 UTC. В JSON artifact сохранены все семь наблюдений и успешное закрытие обеих сущностей.

UI-контроль в том же проектном поле: [issue #126](https://github.com/ViRGiL-GH-Productivity/scrum-test-backlog/issues/126) и [PR #23](https://github.com/ViRGiL-GH-Productivity/test-client/pull/23) получили Inbox сразу и сохранили его после двух минут. Default подтверждён в IAB перед App-прогоном и повторно во время него; после прогона отключён.

Доказанное расхождение: связка GitHub App + `addProjectV2ItemById` не инициализировала настроенный default за наблюдаемые 120 секунд, в отличие от UI. Тест не пишет Horizon или Status, поэтому их последующее изменение автоматизацией не объясняет этот результат. Отдельное влияние API-метода и типа авторизации не разделено. Это не устанавливает причину каждого исторического item и не является изменением importer.
