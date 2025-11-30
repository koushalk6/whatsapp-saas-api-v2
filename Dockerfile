FROM node:20-alpine
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080

COPY package*.json ./
RUN npm install --only=production

COPY index.mjs ./index.mjs

EXPOSE 8080
CMD ["node", "index.mjs"]
