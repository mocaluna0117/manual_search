import { Module } from '@nestjs/common';
import { CognitoAdminService } from './cognito';
import { UserResolver } from './resolver';
import { UserService } from './service';

@Module({
  providers: [UserService, UserResolver, CognitoAdminService],
  exports: [UserService],
})
export class UserModule {}
