import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { readFileSync } from 'fs';
import { PrismaClient } from '../../generated/prisma/client';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  constructor() {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL is not set');
    }

    // RDSのTLS証明書はAmazon独自のCAで署名されており、Nodeの標準信頼ストアには
    // 入っていない。そのため接続文字列に sslmode=require と書くだけでは
    // 「self-signed certificate in certificate chain」で接続が失敗する。
    //
    // rejectUnauthorized:false にすれば通るが、それでは経路は暗号化されても
    // 相手が本物のRDSかを確認できない(中間者攻撃を検知できない)。
    // CAを明示的に渡して「暗号化 + 証明書の検証」を両立させる。
    // ローカル開発(Dockerネットワーク内・TLSなし)では未設定なので何もしない。
    const caPath = process.env.DATABASE_SSL_CA;
    const adapter = new PrismaPg({
      connectionString,
      ...(caPath
        ? {
            ssl: { ca: readFileSync(caPath, 'utf8'), rejectUnauthorized: true },
          }
        : {}),
    });

    super({ adapter });
  }

  async onModuleInit() {
    await this.$connect();
  }
  async onModuleDestroy() {
    await this.$disconnect();
  }
}
