# =========================
# 使用官方 Node.js 镜像
# =========================

# node:24-slim
#
# 24 = Node.js 24版本（LTS长期支持版）
#
# 优点：
# - 体积小
# - 更安全
# - 部署更快
# - 适合服务器
#
FROM docker.io/node:24-slim


# =========================
# 设置生产环境变量
# =========================

# NODE_ENV=production
#
# 告诉Node：
#
# 当前是生产环境
#
# 很多库会自动：
#
# - 提高性能
# - 关闭调试
# - 减少日志
#
ENV NODE_ENV=production


# =========================
# 设置容器内部工作目录
# =========================

# 容器内部创建：
#
# /app
#
# 后续所有命令：
#
# RUN
# COPY
# CMD
#
# 都会在这个目录执行
#
WORKDIR /app


# =========================
# 使用官方镜像内置的非 root 用户（安全）
# =========================

# node 官方镜像已经内置：
#
# 用户：node
# 用户组：node
#
# 不需要自己创建 appuser / appgroup
#
# 企业部署非常推荐使用非 root 用户
#
# 风险：
# 如果程序被攻击
# root 权限可能影响整个容器环境
# 普通用户权限更安全
#


# =========================
# 复制 package.json
# =========================

# 这里只复制：
#
# package.json
# package-lock.json
#
# 不复制全部代码
#
# 这是Docker优化的重要技巧
#
# 原因：
#
# 如果代码变化
# 但依赖没变化
#
# Docker会使用缓存
# 不会重新 npm install
#
# --chown=node:node
#
# 复制时直接设置文件所有者
# 避免后面再执行 chown -R
#
COPY --chown=node:node package*.json ./


# =========================
# 安装 Node.js 依赖
# =========================

# npm ci
#
# 比 npm install 更适合生产环境
#
# 特点：
#
# - 更快
# - 更稳定
# - 完全按照 lock 文件安装
# - 不会自动升级版本
#
# --omit=dev
#
# 不安装开发依赖
#
# 例如：
# nodemon
# eslint
# typescript
#
# 可以减小镜像体积
#
# 注意：
#
# npm ci 需要 package-lock.json
#
RUN npm ci --omit=dev && npm cache clean --force


# =========================
# 复制项目代码
# =========================

# 把当前目录代码复制到容器
#
# 注意：
#
# .dockerignore 非常重要
#
# 否则：
# node_modules
# .env
# secrets
#
# 都可能被复制进去
#
# --chown=node:node
#
# 确保代码文件属于普通用户 node
#
COPY --chown=node:node . .


# =========================
# 切换为普通用户运行
# =========================

# 后续程序：
#
# node src/index.js
#
# 将不再使用 root 权限
#
USER node


# =========================
# 声明容器监听端口
# =========================

# 告诉 Docker：
#
# 本程序使用3001端口
#
# 注意：
#
# EXPOSE 只是声明
# 不会自动开放
#
EXPOSE 3001


# =========================
# 启动命令
# =========================

# 容器启动时自动执行：
#
# node src/index.js
#
# 推荐：
#
# 使用 JSON 数组格式
#
# 不推荐：
#
# CMD node src/index.js
#
# 因为 shell 模式
# 信号处理不好
#
CMD ["node", "src/index.js"]
