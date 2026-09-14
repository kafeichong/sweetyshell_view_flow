// Jest-only stub for @nestjs/swagger. The real package (12.0.1) ships pure ESM
// with deep imports that bypass @nestjs/common's CJS build, which ts-jest can't
// transpile cleanly. Its decorators only attach OpenAPI metadata — inert for
// unit tests — so a no-op stand-in avoids fighting the ESM interop chain.
const noopDecoratorFactory = () => () => undefined;

export const ApiTags = noopDecoratorFactory;
export const ApiBearerAuth = noopDecoratorFactory;
export const ApiSecurity = noopDecoratorFactory;
export const ApiHeader = noopDecoratorFactory;
export const ApiProperty = noopDecoratorFactory;
export const ApiPropertyOptional = noopDecoratorFactory;
export const ApiOperation = noopDecoratorFactory;
export const ApiResponse = noopDecoratorFactory;

export class DocumentBuilder {
  setTitle() { return this; }
  setDescription() { return this; }
  setVersion() { return this; }
  addBearerAuth() { return this; }
  addApiKey() { return this; }
  build() { return {}; }
}

export const SwaggerModule = {
  createDocument: () => ({}),
  setup: () => undefined,
};
