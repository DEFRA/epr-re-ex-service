FROM node@sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf

WORKDIR /app
COPY package.json package-lock.json .
RUN npm ci --omit=dev --ignore-scripts
COPY index.js .

USER node
CMD ["node", "index.js"]
