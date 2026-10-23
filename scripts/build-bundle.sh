#!/usr/bin/env bash
# Сборка apps-script/BUNDLE.gs — единый файл для быстрой установки
# (одно вставление в стандартный Code.gs вместо 13 файлов).
# Запуск из корня репозитория: bash scripts/build-bundle.sh
set -euo pipefail
cd "$(dirname "$0")/.."

ORDER=(
  Config.gs
  SheetService.gs
  TelegramService.gs
  Setup_Sheets.gs
  Code.gs
  CashflowEngine.gs
  DebtEngine.gs
  VisionParser.gs
  InvestNetWorth.gs
  FXAnalytics.gs
  TmaApi.gs
  Triggers.gs
  SecurityAudit.gs
)

OUT=apps-script/BUNDLE.gs
{
  echo '/**'
  echo ' * BUNDLE.gs — ЕДИНЫЙ файл всего бэкенда для быстрой установки.'
  echo ' * Сгенерирован автоматически скриптом scripts/build-bundle.sh —'
  echo ' * при изменении модулей apps-script/*.gs перегенерируйте бандл.'
  echo ' *'
  echo ' * Установка (быстрый путь, SETUP.md): вставьте содержимое этого файла'
  echo ' * ЦЕЛИКОМ в стандартный пустой Code.gs нового проекта Apps Script.'
  echo ' * Ничего больше создавать не нужно. Либо бандл, либо отдельные'
  echo ' * файлы apps-script/*.gs — не одновременно (будут конфликты имён).'
  echo ' */'
  for f in "${ORDER[@]}"; do
    echo ""
    echo "// ════════════════════════════════════════════════════════════════════"
    echo "// $f"
    echo "// ════════════════════════════════════════════════════════════════════"
    cat "apps-script/$f"
  done
} > "$OUT"

echo "✅ $OUT ($(wc -l < "$OUT") строк, ${#ORDER[@]} модулей)"
