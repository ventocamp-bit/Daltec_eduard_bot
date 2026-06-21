FROM node:22-alpine

WORKDIR /app

ENV NODE_ENV=production

RUN apk add --no-cache postgresql-client

COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY scripts ./scripts
COPY data/settings.example.json ./data/settings.example.json
COPY data/lager-preis-muster.csv ./data/lager-preis-muster.csv

RUN mkdir -p /app/data /app/secrets

EXPOSE 3030

CMD ["npm", "run", "admin"]
