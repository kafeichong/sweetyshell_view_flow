import { Body, Controller, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { AdminTokenGuard } from '../../auth/admin-token.guard';
import { CredentialsService } from '../../auth/credentials.service';

@Controller('v1/admin/credentials')
@UseGuards(AdminTokenGuard)
export class V1CredentialsController {
  constructor(private readonly credentials: CredentialsService) {}

  @Post()
  create(@Body() body: { actorId: string; name: string }) {
    if (!body?.actorId?.trim() || !body?.name?.trim()) {
      throw new Error('actorId and name are required');
    }
    return this.credentials.create(body.actorId.trim(), body.name.trim());
  }

  @Patch(':actorId/revoke')
  revoke(@Param('actorId') actorId: string) {
    return this.credentials.revoke(actorId);
  }
}
