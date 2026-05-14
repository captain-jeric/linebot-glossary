FROM node:22-slim

ENV NODE_ENV=production
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY . .

USER node

EXPOSE 8080

CMD ["npm", "start"]
