import { createParamDecorator, ExecutionContext } from '@nestjs/common';

export const CurrentActor = createParamDecorator(
  (_data: unknown, context: ExecutionContext) =>
    context.switchToHttp().getRequest().actor,
);
