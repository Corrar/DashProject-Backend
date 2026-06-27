# Alternativa ao deploy nativo Node do Render (use um OU outro).
FROM node:20-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build
ENV NODE_ENV=production
EXPOSE 8787
CMD ["npm", "start"]
