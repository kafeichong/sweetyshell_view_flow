FROM node:20-slim

WORKDIR /app

# 安装 OpenSSL 和其他依赖
RUN apt-get update && apt-get install -y \
    openssl \
    && rm -rf /var/lib/apt/lists/*

# 复制依赖文件
COPY package.json ./

# 安装依赖
RUN npm install

# 复制代码
COPY . .

# 生成 Prisma Client
RUN npx prisma generate

# 构建
RUN npm run build

# 暴露端口
EXPOSE 3000

# 启动命令
CMD ["npm", "run", "start:prod"]
