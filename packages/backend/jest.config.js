module.exports = {
  testEnvironment: 'node',
  testMatch: ['<rootDir>/src/**/*.{spec,test}.ts'],
  moduleFileExtensions: ['ts', 'js', 'cjs', 'json'],
  transform: {
    '^.+\\.ts$': 'ts-jest',
    '^.+\\.js$': '<rootDir>/test/transform-esm.cjs',
  },
  // Nest 12 and file-type's dependency chain ship ESM. Load their real code so
  // dependency injection, decorators and guards remain testable under Jest 29.
  transformIgnorePatterns: [
    '/node_modules/(?!(@nestjs/|file-type/|strtok3/|token-types/|uint8array-extras/|@tokenizer/|@borewit/|peek-readable/))',
  ],
  // Legacy isolated controller suites mock @nestjs/common incompletely; Swagger
  // metadata is outside their scope. Nest testing itself must remain real.
  moduleNameMapper: {
    '^@nestjs/swagger$': '<rootDir>/test/mocks/nestjs-swagger.ts',
  },
  collectCoverageFrom: ['src/**/*.ts'],
  coveragePathIgnorePatterns: ['/node_modules/', '/dist/'],
};
