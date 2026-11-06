FROM node:22-alpine
WORKDIR /app
COPY package.json server.js ./
COPY public ./public
RUN mkdir -p /data && chown node:node /data
ENV DATA_DIR=/data PORT=3000 TRUST_PROXY=1
USER node
EXPOSE 3000
VOLUME /data
CMD ["node", "server.js"]
