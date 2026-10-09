# Builds the site, then runs the API (which serves it too) on Node, with only what it needs at run
# time. The database, uploads and files the AI made live in /data: keep that volume.

FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# The site's name is part of the built pages.
ARG VITE_APP_NAME=Parley
ENV VITE_APP_NAME=$VITE_APP_NAME
RUN npm run build

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production PORT=8787 DATABASE_PATH=/data/chat.db
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY server ./server
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8787
CMD ["node", "server/index.ts"]
