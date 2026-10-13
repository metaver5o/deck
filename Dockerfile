FROM node:22-alpine
WORKDIR /app
COPY server.js ./
COPY public ./public
ENV NODE_ENV=production DECK_PORT=8787 DECK_HOOK_PORT=8788
RUN mkdir -p /home/node/.config/deck && chown -R node:node /home/node/.config
USER node
EXPOSE 8787 8788
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO /dev/null http://127.0.0.1:8787/ || exit 1
CMD ["node", "server.js"]
