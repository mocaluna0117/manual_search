import { BadRequestException } from '@nestjs/common';
import { Args, Mutation, Resolver } from '@nestjs/graphql';
import { StorageService } from '../storage/service';
import { ManualUploadTarget } from './model';

@Resolver()
export class ManualResolver {
  constructor(private readonly storageService: StorageService) {}

  @Mutation(() => ManualUploadTarget)
  createManualUploadUrl(
    @Args('fileName') fileName: string,
  ): Promise<ManualUploadTarget> {
    if (!fileName.toLowerCase().endsWith('.pdf')) {
      throw new BadRequestException('PDFファイルのみアップロードできます');
    }
    return this.storageService.createUploadUrl(fileName);
  }
}
