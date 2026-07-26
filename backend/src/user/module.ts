import { Module } from '@nestjs/common';
import { UserResolver } from './resolver';
import { UserService } from './service';

@Module({
  providers: [UserService, UserResolver],
  exports: [UserService],
})
export class UserModule {}
