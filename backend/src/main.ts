import { NestFactory } from '@nestjs/core';
import { json } from 'express';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  // 画像添付(base64)を受けるためJSONボディ上限を引き上げ(既定は100KB)
  app.use(json({ limit: '8mb' }));
  app.enableCors({
    origin: process.env.FRONTEND_ORIGIN ?? 'http://localhost:5173',
  });
  // SIGTERM/SIGINTでNestのライフサイクルフックを動かす。
  // ECSはタスク停止時にSIGTERMを送るので、これが無いと終了処理が走らない
  app.enableShutdownHooks();
  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
