import { SetMetadata } from '@nestjs/common';

export const PUBLIC_KEY = 'aicsp:public';

/** Marks a route/controller as exempt from the global JwtAuthGuard. */
export const Public = (): MethodDecorator & ClassDecorator =>
  SetMetadata(PUBLIC_KEY, true);
