# Express API Dockerfile
FROM node:20-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --only=production

COPY src ./src

EXPOSE 3000
CMD ["node", "src/index.js"]
