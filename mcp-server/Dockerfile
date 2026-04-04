FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .
RUN npm run build

# Default to SSE mode for Docker
ENV TRANSPORT=sse
ENV PORT=3001

EXPOSE 3001

CMD ["npm", "start"]