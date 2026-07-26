import { Module } from '@nestjs/common';
import { UserService } from './service';

@Module({
  providers: [UserService],
  exports: [UserService],
})
export class UserModule {}
