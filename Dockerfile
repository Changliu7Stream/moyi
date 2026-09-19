# 墨忆 Docker 镜像
# 零运行时依赖，不需要 npm install——只 COPY 运行所需的源文件。
# 凭据（SUPABASE_URL 等）绝不写进镜像，运行时通过挂载目录注入。

FROM node:20-alpine

WORKDIR /app

# 只拷贝运行必需的文件，不引入测试、文档、git 历史等
COPY package.json ./
COPY server.js ./
COPY mcp-server.js ./
COPY api/ ./api/
COPY lib/ ./lib/
COPY public/ ./public/

# 入口脚本：从挂载目录读取 env，然后 exec node server.js
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# 非 root 用户运行，缩小攻击面
RUN addgroup -S moyi && adduser -S moyi -G moyi
USER moyi

EXPOSE 3906

# 健康检查：TCP 可连即算存活（401 也算服务活着）
# alpine 自带 busybox wget，用它做 TCP 探测
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q --spider --timeout=5 http://127.0.0.1:3906/ || exit 1

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
