# Сборка фронтенда
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# Рабочий образ: только зависимости для запуска (tsx выполняет TypeScript сервера)
FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/app/data PORT=3000
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server ./server
COPY shared ./shared
COPY docs ./docs
COPY --from=build /app/web/dist ./web/dist
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node
EXPOSE 3000
VOLUME ["/app/data"]
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["npx", "tsx", "server/index.ts"]
