import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Controller('api/v1/client-config')
export class ClientConfigController {
  constructor(private configService: ConfigService) {}

  @Get()
  getClientConfig() {
    // 返回前端需要的配置信息（不包含敏感的 Token）
    const adminToken = this.configService.get<string>('VIDEO_FLOW_ADMIN_TOKEN');

    return {
      hasToken: !!adminToken,
      apiBaseUrl: this.configService.get<string>('API_BASE_URL') || 'http://localhost:3000',
      // 可以添加其他非敏感配置
    };
  }
}
