// Jest-only stub for @nestjs/testing. The real package (12.0.1) ships pure ESM
// which ts-jest can't transpile cleanly. Re-export the actual testing utilities
// from individual module files that ts-jest can handle.
export { Test } from '@nestjs/testing/test';
export { TestingModule } from '@nestjs/testing/testing-module';

