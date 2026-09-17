import { Injectable, NestMiddleware, Logger } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { TokenManagementService } from '../v1/tokens/token-management.service';

/**
 * Token使用日志中间件
 * 在每次API请求完成后记录Token使用情况
 */
@Injectable()
export class TokenUsageMiddleware implements NestMiddleware {
  private readonly logger = new Logger(TokenUsageMiddleware.name);

  constructor(private readonly tokenManagement: TokenManagementService) {}

  use(req: Request, res: Response, next: NextFunction) {
    // 记录原始的res.end方法
    const originalEnd = res.end;
    const self = this;

    // 重写res.end以在响应结束时记录日志
    res.end = function (chunk?: any, encoding?: any, callback?: any): any {
      // 恢复原始方法
      res.end = originalEnd;

      // 记录Token使用日志
      self.logUsage(req, res);

      // 调用原始的end方法
      return originalEnd.call(this, chunk, encoding, callback);
    };

    next();
  }

  /**
   * 异步记录日志，不阻塞响应
   */
  private logUsage(req: Request, res: Response): void {
    const actor = (req as any).actor;

    // 只记录已鉴权的请求
    if (!actor?.actorId) {
      return;
    }

    const endpoint = (req as any).route?.path || req.path;
    const method = req.method;
    const statusCode = res.statusCode;
    const ipAddress = this.extractIpAddress(req);
    const userAgent = req.headers['user-agent'];

    // 使用setImmediate异步记录，不阻塞响应
    setImmediate(() => {
      this.tokenManagement
        .logTokenUsage(actor.actorId, endpoint, method, statusCode, ipAddress, userAgent)
        .catch((error) => {
          // 日志记录失败不应影响业务，只记录错误
          this.logger.error(
            `Failed to log token usage for actor ${actor.actorId}: ${error.message}`,
            error.stack,
          );
        });
    });
  }

  /**
   * 提取真实IP地址
   * 优先从代理头获取，否则使用直连IP
   */
  private extractIpAddress(req: Request): string | undefined {
    // 按优先级尝试不同的IP头
    const xForwardedFor = req.headers['x-forwarded-for'];
    if (xForwardedFor) {
      // x-forwarded-for 可能包含多个IP，取第一个
      const ips = Array.isArray(xForwardedFor)
        ? xForwardedFor[0]
        : xForwardedFor.split(',')[0];
      return ips.trim();
    }

    const xRealIp = req.headers['x-real-ip'];
    if (xRealIp) {
      return Array.isArray(xRealIp) ? xRealIp[0] : xRealIp;
    }

    // 回退到直连IP
    return req.ip || (req.connection as any)?.remoteAddress;
  }
}
