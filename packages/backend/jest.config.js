module.exports = {
  testEnvironment: 'node',
  testMatch: ['<rootDir>/src/**/*.{spec,test}.ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  transform: {
    '^.+\\.(t|j)s$': 'ts-jest',
  },
  // @nestjs/swagger@12 ships pure ESM with deep imports that bypass @nestjs/common's
  // CJS build, which ts-jest can't transpile cleanly. Its decorators only attach
  // OpenAPI metadata (inert for unit tests), so swap in a no-op stub for Jest runs.
  moduleNameMapper: {
    '^@nestjs/swagger$': '<rootDir>/test/mocks/nestjs-swagger.ts',
  },
  collectCoverageFrom: ['src/**/*.ts'],
  coveragePathIgnorePatterns: ['/node_modules/', '/dist/'],
};
