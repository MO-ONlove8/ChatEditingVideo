import { inject } from 'vitest';

declare module 'vitest' {
  export interface ProvidedContext {
    integrationDatabaseUrl: string;
  }
}

process.env.DATABASE_URL = inject('integrationDatabaseUrl');
