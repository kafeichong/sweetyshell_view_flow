import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { CredentialsService } from './credentials.service';

@Injectable()
export class ApiCredentialGuard implements CanActivate {
  constructor(
    private readonly credentials: CredentialsService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext) {
    const isPublic = this.reflector.get<boolean>('isPublic', context.getHandler());
    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const authorization = request.headers?.authorization;
    const token = authorization?.startsWith('Bearer ')
      ? authorization.slice('Bearer '.length).trim()
      : '';

    if (!token) {
      throw new UnauthorizedException('Bearer credential required');
    }

    const actor = await this.credentials.authenticate(token);
    if (!actor) {
      throw new ForbiddenException('Credential is invalid or inactive');
    }

    request.actor = actor;
    return true;
  }
}
