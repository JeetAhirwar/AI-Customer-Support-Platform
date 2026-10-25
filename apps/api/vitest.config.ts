import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

/**
 * NestJS needs `emitDecoratorMetadata` for constructor DI
 * (`design:paramtypes`). esbuild (vitest's default transform) cannot emit it,
 * so under plain esbuild every `constructor(private readonly x: X)` in the app
 * resolves to `undefined` at runtime — full-app boots then 500 in tests.
 * SWC emits the same metadata tsc does, so tests exercise the real DI graph
 * (ADR-008 Gate-B integration tests are the first to boot the real AppModule).
 */
export default defineConfig({
  plugins: [
    swc.vite({
      jsc: {
        parser: { syntax: 'typescript', decorators: true },
        transform: { legacyDecorator: true, decoratorMetadata: true },
        target: 'es2022',
      },
      module: { type: 'es6' },
    }),
  ],
  test: {
    environment: 'node',
    include: ['src/**/*.spec.ts'],
  },
});
