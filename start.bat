@echo off
echo ========================================
echo    Crypto Price Tracker - Запуск
echo ========================================
echo.

REM Проверка наличия Node.js
node --version >nul 2>&1
if errorlevel 1 (
    echo ❌ Node.js не найден! Установите Node.js с https://nodejs.org/
    pause
    exit /b 1
)

REM Проверка наличия package.json
if not exist package.json (
    echo ❌ Файл package.json не найден!
    pause
    exit /b 1
)

REM Проверка наличия node_modules
if not exist node_modules (
    echo 📦 Устанавливаем зависимости...
    npm install
    if errorlevel 1 (
        echo ❌ Ошибка установки зависимостей!
        pause
        exit /b 1
    )
)

REM Проверка наличия .env файла
if not exist .env (
    echo ⚠️  Файл .env не найден! Создаем шаблон...
    echo BINANCE_API_KEY=your_api_key_here > .env
    echo BINANCE_API_SECRET=your_api_secret_here >> .env
    echo PORT=5000 >> .env
    echo.
    echo 📝 Создан файл .env с шаблоном.
    echo    Отредактируйте его и добавьте ваши API ключи Binance.
    echo.
    pause
)

echo ✅ Все проверки пройдены!
echo.
echo 🚀 Запускаем сервер...
echo 📊 Откройте: http://localhost:5000
echo.
echo Для остановки нажмите Ctrl+C
echo.

npm run dev
