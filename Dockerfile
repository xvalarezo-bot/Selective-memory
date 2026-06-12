FROM node:20-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=optional --no-audit --no-fund
COPY . .
# brain.config.json ships with ${VAR} placeholders only — secrets come from env
ENV NODE_ENV=production
EXPOSE 8080
CMD ["npx", "tsx", "server.ts"]
