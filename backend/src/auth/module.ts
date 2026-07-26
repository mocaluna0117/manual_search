import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { PassportModule } from '@nestjs/passport';
import { GqlAuthGuard } from './guard';
import { JwtStrategy } from './strategy';

@Module({
  imports: [PassportModule],
  providers: [
    JwtStrategy,
    // APP_GUARD: アプリ全体に門番を適用(各Resolverに書いて回らなくてよい)
    { provide: APP_GUARD, useClass: GqlAuthGuard },
  ],
})
export class AuthModule {}
