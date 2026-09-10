import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { timingSafeEqual } from 'crypto';

@Injectable()
export class AdminTokenGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest();
    const actual = request.headers?.['x-admin-token'] ?? '';
    const expected = process.env.VIDEO_FLOW_ADMIN_TOKEN ?? '';
    const valid = Boolean(expected && actual && actual.length === expected.length) &&
      timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
    if (!valid) throw new UnauthorizedException('Admin token required');
    return true;
  }
}
