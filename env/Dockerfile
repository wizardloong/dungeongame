FROM node:20-alpine

WORKDIR /app

# Копируем только package.json для кэширования слоя с зависимостями
COPY app/package.json /app
RUN npm install

# Копируем все остальные файлы приложения
COPY app/ /app
COPY env/.env /app/.env

# Устанавливаем порт
EXPOSE 3000

# Используем условную команду через shell форму CMD
CMD if [ "$DEBUG_MODE" = "true" ]; then \
        echo "Starting application in DEBUG mode" && \
        node --require dotenv/config index.js; \
    else \
        echo "Starting application in PRODUCTION mode" && \
        npm start; \
    fi
