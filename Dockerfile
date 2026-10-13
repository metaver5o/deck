FROM node:22-alpine
WORKDIR /app
COPY server.js hooks.js ./
COPY public ./public
ENV NODE_ENV=production HOME=/home/node DECK_PORT=8787 DECK_HOOK_PORT=8788
# Any UID may run this (compose matches it to the host user), so the state dir is sticky-writable.
RUN mkdir -p /home/node/.config/deck && chmod 1777 /home/node/.config/deck
USER node
EXPOSE 8787 8788
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO /dev/null http://127.0.0.1:8787/ || exit 1
CMD ["node", "server.js"]
