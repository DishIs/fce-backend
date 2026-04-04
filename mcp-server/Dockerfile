FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .
RUN npm run build

ENV TRANSPORT=streamable
ENV PORT=3000
ENV FCE_API_URL=https://api2.freecustom.email/v1
ENV MCP_BASE_URL=https://api2.freecustom.email/v1/mcp
ENV MCP_ISSUER=https://mcp.freecustom.email
ENV MCP_BASE_URL_PUBLIC=https://mcp.freecustom.email

EXPOSE 3000

CMD ["npm", "start"]