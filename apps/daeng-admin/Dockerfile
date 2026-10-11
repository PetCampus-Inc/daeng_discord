FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --chown=node:node server.js service-admin.js ./
USER node

EXPOSE 3001
CMD ["node", "server.js"]
