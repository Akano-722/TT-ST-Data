FROM node:20-alpine

WORKDIR /app

# 先只拷 manifest 装依赖，改代码时不用重装。
# 用 ci + lockfile 而不是 install：镜像里的依赖版本和你本地跑过测试的严格一致，
# 不会因为哪天上游发了个新版本，镜像就悄悄装上没测过的代码。
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
ENV DATA_DIR=/data

# Zeabur 会通过 PORT 环境变量注入端口，server.js 会读取它
EXPOSE 8080

CMD ["node", "server.js"]
