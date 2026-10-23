#!/usr/bin/env bash
# Устанавливает pre-commit хук защиты секретов в .git/hooks.
# Запуск из корня репозитория: bash scripts/install-hooks.sh
set -e
cd "$(dirname "$0")/.."
cp scripts/hooks/pre-commit .git/hooks/pre-commit
chmod +x .git/hooks/pre-commit
echo "✅ pre-commit хук установлен (.git/hooks/pre-commit)"
echo "   Опционально, для полной проверки истории: gitleaks detect -c .gitleaks.toml"
