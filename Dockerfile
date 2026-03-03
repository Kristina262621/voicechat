FROM node:20-alpine

# Зависимости для better-sqlite3 (нативный модуль)
RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY . .

# Создаём папку для данных SQLite
RUN mkdir -p /app/data

EXPOSE 3000

ENV NODE_ENV=production

CMD ["node", "server.js"]
