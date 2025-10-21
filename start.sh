#!/bin/bash

echo "========================================"
echo "   Crypto Price Tracker - Запуск"
echo "========================================"
echo

# Проверка наличия Node.js
if ! command -v node &> /dev/null; then
    echo "❌ Node.js не найден! Установите Node.js с https://nodejs.org/"
    exit 1
fi

# Проверка наличия package.json
if [ ! -f "package.json" ]; then
    echo "❌ Файл package.json не найден!"
    exit 1
fi

# Проверка наличия node_modules
if [ ! -d "node_modules" ]; then
    echo "📦 Устанавливаем зависимости..."
    npm install
    if [ $? -ne 0 ]; then
        echo "❌ Ошибка установки зависимостей!"
        exit 1
    fi
fi

# Проверка наличия .env файла
if [ ! -f ".env" ]; then
    echo "⚠️  Файл .env не найден! Создаем шаблон..."
    cat > .env << EOF
BINANCE_API_KEY=your_api_key_here
BINANCE_API_SECRET=your_api_secret_here
PORT=5000
EOF
    echo
    echo "📝 Создан файл .env с шаблоном."
    echo "   Отредактируйте его и добавьте ваши API ключи Binance."
    echo
    read -p "Нажмите Enter для продолжения..."
fi

echo "✅ Все проверки пройдены!"
echo
echo "🚀 Запускаем сервер..."
echo "📊 Откройте: http://localhost:5000"
echo
echo "Для остановки нажмите Ctrl+C"
echo

npm run dev
