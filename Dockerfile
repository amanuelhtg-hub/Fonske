FROM node:24-slim
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080
WORKDIR /app
# No npm dependencies: nothing to install.
COPY package.json ./
COPY src ./src
COPY public ./public
USER node
EXPOSE 8080
CMD ["node", "src/server.js"]
