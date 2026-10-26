import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { timingSafeEqual } from 'crypto';

@Injectable()
export class AdminTokenGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest();
    const actual = request.headers?.['x-admin-token'] ?? '';
    const expected = process.env.VIDEO_FLOW_ADMIN_TOKEN ?? '';
    if (!expected || typeof actual !== 'string' || !actual) {
      throw new UnauthorizedException('Admin token required');
    }
    const actualBytes = Buffer.from(actual);
    const expectedBytes = Buffer.from(expected);
    const valid = actualBytes.length === expectedBytes.length &&
      timingSafeEqual(actualBytes, expectedBytes);
    if (!valid) throw new UnauthorizedException('Admin token required');
    return true;
  }
}
