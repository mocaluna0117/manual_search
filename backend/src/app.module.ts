import { ApolloDriver, ApolloDriverConfig } from '@nestjs/apollo';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { GraphQLModule } from '@nestjs/graphql';
import { join } from 'path';
import { AppResolver } from './app.resolver';
import { AuthModule } from './auth/module';
import { CategoryModule } from './category/module';
import { ChatModule } from './chat/module';
import { HealthController } from './health/controller';
import { ManualModule } from './manual/module';
import { PrismaModule } from './prisma/module';
import { RagModule } from './rag/module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    GraphQLModule.forRoot<ApolloDriverConfig>({
      driver: ApolloDriver,
      autoSchemaFile: join(process.cwd(), 'src/schema.gql'),
      playground: true,
      plugins: [],
      // 認証ガードがHTTPリクエスト(のAuthorizationヘッダ)を読めるようにcontextへ渡す
      context: ({ req }: { req: unknown }) => ({ req }),
    }),
    AuthModule,
    PrismaModule,
    CategoryModule,
    ChatModule,
    ManualModule,
    RagModule,
  ],
  controllers: [HealthController],
  providers: [AppResolver],
})
export class AppModule {}
