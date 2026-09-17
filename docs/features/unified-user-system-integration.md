# 统一用户系统集成方案

## 需求分析

### 背景
公司有多个系统，希望实现统一的用户认证和权限管理，避免：
- ❌ 每个系统单独管理用户
- ❌ 用户需要记住多个账号密码
- ❌ 权限分散管理，难以统一控制

### 目标
- ✅ 一次登录，访问所有系统（SSO）
- ✅ 统一的用户管理后台
- ✅ 统一的权限控制
- ✅ 支持角色和组织架构

## 可行性评估

### ✅ 完全可行

**原因**：
1. **现有Token机制可扩展**：当前的ActorCredential表已经是用户凭证系统的雏形
2. **标准方案成熟**：OAuth 2.0/OIDC是业界标准
3. **开源方案丰富**：有多个成熟的开源SSO解决方案
4. **渐进式迁移**：可以保留现有API，逐步切换

## 技术方案对比

### 方案1：自研用户中心（中等复杂度）

#### 架构设计

```
┌─────────────────────────────────────────────────────────┐
│                   用户中心（User Center）                │
│  ┌────────────────────────────────────────────────────┐ │
│  │  用户管理 │ 角色管理 │ 权限管理 │ 组织架构        │ │
│  └────────────────────────────────────────────────────┘ │
│  ┌────────────────────────────────────────────────────┐ │
│  │  JWT签发 │ Token刷新 │ 会话管理                   │ │
│  └────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
                         ↓ JWT Token
        ┌────────────────┼────────────────┐
        ↓                ↓                ↓
  ┌──────────┐    ┌──────────┐    ┌──────────┐
  │ Video    │    │ 系统B    │    │ 系统C    │
  │ Flow     │    │          │    │          │
  └──────────┘    └──────────┘    └──────────┘
```

#### 数据模型

```prisma
// 用户中心数据库

// 用户表
model User {
  id            String    @id @default(uuid()) @db.Uuid
  username      String    @unique
  email         String?   @unique
  passwordHash  String    @map("password_hash")
  displayName   String    @map("display_name")
  avatar        String?
  status        String    @default("active")  // active, disabled, locked
  lastLoginAt   DateTime? @map("last_login_at")
  createdAt     DateTime  @default(now()) @map("created_at")
  updatedAt     DateTime  @updatedAt @map("updated_at")
  
  roles         UserRole[]
  sessions      UserSession[]
  apiTokens     ApiToken[]
  
  @@map("users")
}

// 角色表
model Role {
  id          String   @id @default(uuid()) @db.Uuid
  name        String   @unique
  displayName String   @map("display_name")
  description String?
  permissions Json     // ["video_flow:read", "video_flow:write", "admin:*"]
  createdAt   DateTime @default(now()) @map("created_at")
  
  users       UserRole[]
  
  @@map("roles")
}

// 用户角色关联表
model UserRole {
  id        String   @id @default(uuid()) @db.Uuid
  userId    String   @map("user_id") @db.Uuid
  user      User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  roleId    String   @map("role_id") @db.Uuid
  role      Role     @relation(fields: [roleId], references: [id], onDelete: Cascade)
  createdAt DateTime @default(now()) @map("created_at")
  
  @@unique([userId, roleId])
  @@map("user_roles")
}

// 会话表（JWT Refresh Token）
model UserSession {
  id           String    @id @default(uuid()) @db.Uuid
  userId       String    @map("user_id") @db.Uuid
  user         User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  refreshToken String    @unique @map("refresh_token")
  ipAddress    String?   @map("ip_address")
  userAgent    String?   @map("user_agent")
  expiresAt    DateTime  @map("expires_at")
  createdAt    DateTime  @default(now()) @map("created_at")
  lastUsedAt   DateTime? @map("last_used_at")
  
  @@index([userId])
  @@index([expiresAt])
  @@map("user_sessions")
}

// API Token表（兼容现有ActorCredential）
model ApiToken {
  id          String    @id @default(uuid()) @db.Uuid
  userId      String    @map("user_id") @db.Uuid
  user        User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  name        String    // Token名称，便于管理
  tokenHash   String    @unique @map("token_hash")
  scopes      String[]  // ["video_flow:*", "system_b:read"]
  expiresAt   DateTime? @map("expires_at")
  lastUsedAt  DateTime? @map("last_used_at")
  createdAt   DateTime  @default(now()) @map("created_at")
  
  @@index([userId])
  @@map("api_tokens")
}

// 组织架构表（可选）
model Organization {
  id          String   @id @default(uuid()) @db.Uuid
  name        String
  parentId    String?  @map("parent_id") @db.Uuid
  parent      Organization? @relation("OrgHierarchy", fields: [parentId], references: [id])
  children    Organization[] @relation("OrgHierarchy")
  createdAt   DateTime @default(now()) @map("created_at")
  
  @@map("organizations")
}
```

#### JWT Payload设计

```typescript
interface JwtPayload {
  sub: string;              // userId
  username: string;
  email: string;
  displayName: string;
  roles: string[];          // ["admin", "video_flow_user"]
  permissions: string[];    // ["video_flow:*", "system_b:read"]
  iat: number;              // 签发时间
  exp: number;              // 过期时间
  iss: string;              // 签发者："user-center"
}
```

#### API设计

```typescript
// 用户中心API

// 登录
POST /auth/login
Body: { username: string, password: string }
Response: {
  accessToken: string,      // JWT, 短期（15分钟）
  refreshToken: string,     // 长期（7天）
  expiresIn: number,
  user: {
    id: string,
    username: string,
    displayName: string,
    roles: string[]
  }
}

// 刷新Token
POST /auth/refresh
Body: { refreshToken: string }
Response: {
  accessToken: string,
  expiresIn: number
}

// 登出
POST /auth/logout
Body: { refreshToken: string }

// 获取当前用户信息
GET /auth/me
Header: Authorization: Bearer <jwt>
Response: {
  id: string,
  username: string,
  email: string,
  displayName: string,
  roles: string[],
  permissions: string[]
}

// 用户管理（管理员）
GET /users                  // 获取用户列表
POST /users                 // 创建用户
GET /users/:id              // 获取用户详情
PATCH /users/:id            // 更新用户
DELETE /users/:id           // 删除用户

// 角色管理（管理员）
GET /roles                  // 获取角色列表
POST /roles                 // 创建角色
PATCH /roles/:id            // 更新角色
DELETE /roles/:id           // 删除角色

// API Token管理
GET /api-tokens             // 获取我的API Token列表
POST /api-tokens            // 创建API Token
DELETE /api-tokens/:id      // 删除API Token
```

#### 各业务系统集成

```typescript
// Video Flow Backend 集成示例

// 添加JWT验证Guard
import { Injectable, CanActivate, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { verify } from 'jsonwebtoken';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest();
    const authorization = request.headers?.authorization;
    
    const token = authorization?.startsWith('Bearer ')
      ? authorization.slice('Bearer '.length).trim()
      : '';
    
    if (!token) {
      throw new UnauthorizedException('JWT token required');
    }
    
    try {
      // 验证JWT（公钥从用户中心获取）
      const payload = verify(token, process.env.JWT_PUBLIC_KEY, {
        issuer: 'user-center',
        algorithms: ['RS256']
      });
      
      request.user = payload;
      return true;
    } catch (error) {
      throw new UnauthorizedException('Invalid or expired token');
    }
  }
}

// 权限检查Guard
@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(private requiredPermission: string) {}
  
  canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest();
    const user = request.user;
    
    // 检查用户是否有所需权限
    const hasPermission = user.permissions?.some(p => 
      p === this.requiredPermission || 
      p === '*' || 
      p.startsWith(this.requiredPermission.split(':')[0] + ':*')
    );
    
    if (!hasPermission) {
      throw new ForbiddenException('Insufficient permissions');
    }
    
    return true;
  }
}

// 使用示例
@Controller('v1/consumption')
@UseGuards(JwtAuthGuard)
export class V1ConsumptionController {
  @Get('overview')
  @UseGuards(new PermissionGuard('video_flow:consumption:read'))
  async getOverview(@Request() req) {
    const userId = req.user.sub;
    return this.consumptionService.getOverview(userId);
  }
}
```

#### 前端集成

```typescript
// lib/auth.ts
import api from './api';

interface LoginResponse {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  user: {
    id: string;
    username: string;
    displayName: string;
    roles: string[];
  };
}

export async function login(username: string, password: string): Promise<LoginResponse> {
  const response = await api.post('/auth/login', { username, password });
  const data = response.data;
  
  // 存储token
  localStorage.setItem('access_token', data.accessToken);
  localStorage.setItem('refresh_token', data.refreshToken);
  localStorage.setItem('user', JSON.stringify(data.user));
  
  return data;
}

export async function refreshToken(): Promise<string> {
  const refreshToken = localStorage.getItem('refresh_token');
  const response = await api.post('/auth/refresh', { refreshToken });
  const newAccessToken = response.data.accessToken;
  
  localStorage.setItem('access_token', newAccessToken);
  return newAccessToken;
}

export function logout() {
  const refreshToken = localStorage.getItem('refresh_token');
  api.post('/auth/logout', { refreshToken }).catch(() => {});
  
  localStorage.removeItem('access_token');
  localStorage.removeItem('refresh_token');
  localStorage.removeItem('user');
  
  window.location.href = '/login';
}

export function getCurrentUser() {
  const userStr = localStorage.getItem('user');
  return userStr ? JSON.parse(userStr) : null;
}

export function hasPermission(permission: string): boolean {
  const user = getCurrentUser();
  return user?.permissions?.includes(permission) || false;
}
```

```typescript
// lib/api.ts（更新）
import axios from 'axios';
import { refreshToken, logout } from './auth';

const api = axios.create({
  baseURL: process.env.NEXT_PUBLIC_API_BASE_URL,
});

// 请求拦截器
api.interceptors.request.use((config) => {
  const accessToken = localStorage.getItem('access_token');
  if (accessToken) {
    config.headers.Authorization = `Bearer ${accessToken}`;
  }
  return config;
});

// 响应拦截器（自动刷新token）
api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config;
    
    // Token过期，尝试刷新
    if (error.response?.status === 401 && !originalRequest._retry) {
      originalRequest._retry = true;
      
      try {
        const newAccessToken = await refreshToken();
        originalRequest.headers.Authorization = `Bearer ${newAccessToken}`;
        return api(originalRequest);
      } catch (refreshError) {
        // 刷新失败，跳转登录
        logout();
        return Promise.reject(refreshError);
      }
    }
    
    return Promise.reject(error);
  }
);

export default api;
```

#### 优点
- ✅ 完全自主可控
- ✅ 可定制化程度高
- ✅ 与现有系统集成灵活
- ✅ 数据存储在自己数据库

#### 缺点
- ❌ 开发工作量较大（约5-7天）
- ❌ 需要维护安全性（密码加密、JWT密钥管理）
- ❌ 需要自己实现常见功能（密码重置、邮箱验证等）

### 方案2：使用开源SSO方案（推荐）

#### 2.1 Keycloak（功能最全）

**简介**：RedHat开源的企业级身份和访问管理解决方案

**特点**：
- ✅ 功能完整：SSO、OAuth 2.0、OIDC、SAML
- ✅ 内置用户管理界面
- ✅ 支持多租户、组织架构
- ✅ 支持社交登录（Google、GitHub等）
- ✅ 支持多因素认证（MFA）
- ✅ 有中文界面
- ❌ 较重（Java应用，需要独立部署）

**部署**：
```yaml
# docker-compose.yml
services:
  keycloak:
    image: quay.io/keycloak/keycloak:23.0
    environment:
      KEYCLOAK_ADMIN: admin
      KEYCLOAK_ADMIN_PASSWORD: ${KEYCLOAK_ADMIN_PASSWORD}
      KC_DB: postgres
      KC_DB_URL: jdbc:postgresql://postgres:5432/keycloak
      KC_DB_USERNAME: keycloak
      KC_DB_PASSWORD: ${KC_DB_PASSWORD}
    ports:
      - "8080:8080"
    command: start-dev
```

**集成示例**：
```typescript
// 使用keycloak-connect
import Keycloak from 'keycloak-connect';

const keycloak = new Keycloak({}, {
  realm: 'company',
  'auth-server-url': 'http://keycloak:8080',
  'ssl-required': 'external',
  resource: 'video-flow-backend',
  'confidential-port': 0
});

// NestJS集成
@Module({
  providers: [
    {
      provide: APP_GUARD,
      useClass: KeycloakAuthGuard,
    },
  ],
})
export class AppModule {}
```

#### 2.2 Authentik（现代化UI）

**简介**：Python/Django开发的现代化SSO方案

**特点**：
- ✅ UI美观、现代化
- ✅ 配置灵活（Policy Engine）
- ✅ 支持OAuth 2.0、OIDC、SAML
- ✅ 内置Proxy Provider（反向代理认证）
- ✅ 轻量级（相比Keycloak）
- ❌ 社区相对较小

#### 2.3 Authelia（轻量级）

**简介**：Go语言编写的轻量级认证服务器

**特点**：
- ✅ 极其轻量（单个二进制）
- ✅ 部署简单
- ✅ 支持多因素认证
- ✅ 配置文件驱动
- ❌ 功能相对简单
- ❌ 主要用于反向代理场景

#### 2.4 Ory（云原生）

**简介**：Ory提供的云原生身份管理套件

**特点**：
- ✅ 微服务架构
- ✅ API优先设计
- ✅ Kubernetes友好
- ✅ 开源+商业版
- ❌ 学习曲线陡峭

### 方案3：使用云服务（最快）

#### 3.1 Auth0
- ✅ 功能完整，开箱即用
- ✅ 免费套餐（7000 MAU）
- ❌ 商业服务，有成本
- ❌ 数据在第三方

#### 3.2 阿里云IDaaS
- ✅ 国内服务，访问快
- ✅ 与阿里云生态集成好
- ❌ 商业服务
- ❌ 绑定阿里云

#### 3.3 Authing（中国）
- ✅ 国内团队，中文支持好
- ✅ 免费套餐
- ❌ 商业服务

## 推荐方案

### 阶段1：过渡方案（立即实施，0.5天）

**保留现有Token机制，增加JWT支持**

```typescript
// 双模式认证：兼容老Token + 新JWT
@Injectable()
export class HybridAuthGuard implements CanActivate {
  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest();
    const authorization = request.headers?.authorization;
    
    if (!authorization) {
      throw new UnauthorizedException('Authentication required');
    }
    
    const token = authorization.startsWith('Bearer ')
      ? authorization.slice('Bearer '.length).trim()
      : '';
    
    // 尝试JWT验证
    try {
      const payload = verify(token, process.env.JWT_PUBLIC_KEY);
      request.user = payload;
      return true;
    } catch {
      // JWT验证失败，尝试老Token
      const actor = await this.credentials.authenticate(token);
      if (actor) {
        request.user = { sub: actor.actorId, ...actor };
        return true;
      }
      
      throw new UnauthorizedException('Invalid token');
    }
  }
}
```

这样可以：
- ✅ 不影响现有API
- ✅ 逐步迁移到JWT
- ✅ 给自己时间选择最终方案

### 阶段2：选择SSO方案（1-2周后）

**推荐：Keycloak**

**理由**：
1. ✅ 功能最完整，企业级
2. ✅ 社区活跃，文档完善
3. ✅ 支持所有需要的功能
4. ✅ 开源免费，自主可控
5. ✅ 有中文界面，团队容易上手

**实施步骤**：
1. 部署Keycloak（Docker/K8s）
2. 创建Realm（公司域）
3. 配置Clients（各个系统）
4. 迁移现有用户数据
5. 各系统集成Keycloak SDK
6. 前端改造（统一登录页）
7. 逐步切换，下线老Token

**时间估算**：
- Keycloak部署配置：1天
- 后端集成改造：2-3天
- 前端登录改造：1-2天
- 用户数据迁移：0.5天
- 测试验证：1天
- **总计：5.5-7.5天**

## 迁移路线图

### Phase 1: 准备阶段（当前）
- [x] 现有Token机制正常工作
- [ ] 添加JWT支持（兼容模式）
- [ ] 评估SSO方案

### Phase 2: 试点阶段（1-2周）
- [ ] 部署Keycloak测试环境
- [ ] Video Flow系统试点集成
- [ ] 小范围用户测试

### Phase 3: 全面推广（2-4周）
- [ ] 其他系统逐个接入
- [ ] 用户数据完整迁移
- [ ] 统一权限管理

### Phase 4: 下线老系统（1-2个月后）
- [ ] 确认所有系统已迁移
- [ ] 下线老Token机制
- [ ] 删除冗余代码

## 成本效益分析

### 自研方案
- **开发成本**：5-7天（用户中心开发）
- **维护成本**：持续（安全更新、功能迭代）
- **灵活性**：⭐⭐⭐⭐⭐
- **功能完整度**：⭐⭐⭐

### Keycloak方案（推荐）
- **开发成本**：5.5-7.5天（集成改造）
- **维护成本**：低（主要是配置，官方负责安全更新）
- **灵活性**：⭐⭐⭐⭐
- **功能完整度**：⭐⭐⭐⭐⭐

### 云服务方案
- **开发成本**：3-4天（最快）
- **维护成本**：几乎没有
- **使用成本**：持续付费（$）
- **灵活性**：⭐⭐⭐
- **功能完整度**：⭐⭐⭐⭐⭐

## 安全考虑

### JWT密钥管理
- 使用非对称加密（RS256）
- 私钥仅用户中心持有
- 公钥分发给各业务系统
- 定期轮换密钥

### Token有效期
- Access Token：15分钟（短期）
- Refresh Token：7天（长期）
- API Token：不过期或长期（用于服务间调用）

### 权限粒度
```
系统:资源:操作
例如：
- video_flow:consumption:read
- video_flow:consumption:write
- video_flow:task:create
- system_b:*
- admin:*
```

### 审计日志
- 登录日志（谁、何时、从哪里登录）
- 权限变更日志
- 敏感操作日志

## 附录：Keycloak快速开始

### 部署
```bash
docker run -d \
  --name keycloak \
  -p 8080:8080 \
  -e KEYCLOAK_ADMIN=admin \
  -e KEYCLOAK_ADMIN_PASSWORD=admin \
  quay.io/keycloak/keycloak:23.0 \
  start-dev
```

### 配置步骤
1. 访问 http://localhost:8080
2. 创建Realm: `company`
3. 创建Client: `video-flow-frontend`
   - Client Type: OpenID Connect
   - Client authentication: OFF (public client)
   - Valid redirect URIs: `http://localhost:3001/*`
4. 创建Client: `video-flow-backend`
   - Client Type: OpenID Connect
   - Client authentication: ON (confidential)
5. 创建Role: `video_flow_user`, `video_flow_admin`
6. 创建User并分配Role

### 前端集成（Next.js）
```bash
npm install next-auth @next-auth/keycloak-adapter
```

```typescript
// app/api/auth/[...nextauth]/route.ts
import NextAuth from 'next-auth';
import KeycloakProvider from 'next-auth/providers/keycloak';

export const authOptions = {
  providers: [
    KeycloakProvider({
      clientId: process.env.KEYCLOAK_CLIENT_ID,
      clientSecret: process.env.KEYCLOAK_CLIENT_SECRET,
      issuer: process.env.KEYCLOAK_ISSUER,
    }),
  ],
};

export const handler = NextAuth(authOptions);
export { handler as GET, handler as POST };
```

## 总结

**统一用户系统完全可行且建议实施。**

**短期方案**（Phase 2开发期间）：
- 继续使用现有Token机制
- 前端实现简单的登录页

**中长期方案**（Phase 2完成后）：
- 部署Keycloak
- 逐步迁移所有系统
- 建立统一身份管理

这样既不影响当前进度，又为未来的统一认证打好基础。
