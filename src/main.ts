import { setGlobalDispatcher, Agent } from 'undici';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

// Node's global fetch (undici) has its OWN headersTimeout (default 5 min) that
// fires independently of our per-request AbortController. The /eml-process router
// legitimately takes minutes on big batches (e.g. a 14-order weekly list), so the
// default cut the call off before the router replied -> "AI analysis returned
// null" (a false router-down). Raise undici's global timeouts just past our AI
// budget so OUR AbortController (AI_EML_PROCESS_TIMEOUT_MS) stays the real
// deadline; every other fetch keeps its own shorter AbortController.
const aiBudgetMs = Number(process.env.AI_EML_PROCESS_TIMEOUT_MS) || 600000;
const fetchTimeoutMs = aiBudgetMs + 60000;
setGlobalDispatcher(
  new Agent({ headersTimeout: fetchTimeoutMs, bodyTimeout: fetchTimeoutMs }),
);

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // CORS: allow the configured frontend origin(s). Comma-separated list in
  // CORS_ORIGINS; when unset, reflect the request origin (dev convenience).
  const corsOrigins = (process.env.CORS_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  app.enableCors({
    origin: corsOrigins.length > 0 ? corsOrigins : true,
    credentials: true,
  });

  await app.listen(process.env.PORT ?? 3000, '0.0.0.0');
}
bootstrap();
