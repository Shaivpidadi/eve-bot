# The background worker (worker.mjs), run by Vercel Daemons in production.
# It has no dependencies: it only calls the app. See docs/configuration.md.
FROM node:24-slim
WORKDIR /app
COPY worker.mjs ./
USER node
CMD ["node", "worker.mjs"]
