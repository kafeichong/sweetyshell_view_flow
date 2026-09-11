import 'reflect-metadata';

jest.mock('@nestjs/common', () => ({
  Injectable: () => (target: unknown) => target,
  Controller: () => (target: unknown) => target,
  Get: () => () => {},
  Post: () => () => {},
  Patch: () => () => {},
  Param: () => () => {},
  Body: () => () => {},
  Query: () => () => {},
  UseGuards: (...guards: unknown[]) => (
    _target: unknown,
    _key?: string,
    descriptor?: PropertyDescriptor,
  ) => {
    if (descriptor?.value) {
      Reflect.defineMetadata('__guards__', guards, descriptor.value);
    }
  },
  UnauthorizedException: class UnauthorizedException extends Error {},
}));

import { AdminTokenGuard } from '../auth/admin-token.guard';
import { WorkerServiceGuard } from '../auth/worker-service.guard';
import { TasksController } from './tasks.controller';

function guardsFor(method: keyof TasksController) {
  return Reflect.getMetadata(
    '__guards__',
    TasksController.prototype[method],
  ) ?? [];
}

describe('legacy tasks authorization metadata', () => {
  it.each(['create', 'findAll', 'findPending', 'findOne'] as const)(
    'protects legacy public method %s with the admin guard',
    (method) => {
      expect(guardsFor(method)).toContain(AdminTokenGuard);
    },
  );

  it.each(['claim', 'recover', 'update'] as const)(
    'keeps worker method %s behind the worker guard',
    (method) => {
      expect(guardsFor(method)).toContain(WorkerServiceGuard);
    },
  );
});
