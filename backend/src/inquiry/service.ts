import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { PrismaService } from '../prisma/service';

/** 問い合わせの宛先。運用で変える場合は環境変数で上書きする */
const TO_EMAIL = process.env.INQUIRY_TO_EMAIL ?? 'daibon20020117@gmail.com';
// SESは差出人も認証済みアドレスである必要があるため、既定は宛先と同じにする
const FROM_EMAIL = process.env.INQUIRY_FROM_EMAIL ?? TO_EMAIL;
const MAX_LENGTH = 2000;

@Injectable()
export class InquiryService {
  private readonly logger = new Logger(InquiryService.name);
  private readonly ses = new SESv2Client({
    region: process.env.AWS_REGION ?? 'ap-northeast-1',
  });

  constructor(private readonly prisma: PrismaService) {}

  /**
   * 問い合わせを受け付ける。
   * まずDBに残してからメールを送る。メール送信に失敗しても内容は失われず、
   * 利用者には「受け付けた」と返す(送れなかったことはログに残す)
   */
  async send(message: string, userEmail: string | null) {
    const trimmed = message.trim();
    if (!trimmed) {
      throw new BadRequestException('内容を入力してください');
    }
    if (trimmed.length > MAX_LENGTH) {
      throw new BadRequestException(
        `内容が長すぎます(${MAX_LENGTH}文字まで)`,
      );
    }

    const inquiry = await this.prisma.inquiry.create({
      data: { message: trimmed, userEmail },
    });

    try {
      await this.ses.send(
        new SendEmailCommand({
          FromEmailAddress: FROM_EMAIL,
          Destination: { ToAddresses: [TO_EMAIL] },
          // 送信者へそのまま返信できるようにする
          ReplyToAddresses: userEmail ? [userEmail] : undefined,
          Content: {
            Simple: {
              Subject: {
                Data: `【社内マニュアル検索】お問い合わせ (${userEmail ?? '不明'})`,
                Charset: 'UTF-8',
              },
              Body: {
                Text: {
                  Data: [
                    `送信者: ${userEmail ?? '不明'}`,
                    `受付日時: ${inquiry.createdAt.toLocaleString('ja-JP')}`,
                    '',
                    trimmed,
                  ].join('\n'),
                  Charset: 'UTF-8',
                },
              },
            },
          },
        }),
      );
    } catch (e) {
      // 送信できなくても問い合わせ自体は受理済み(DBに残っている)
      this.logger.error(
        `問い合わせメールの送信に失敗 id=${inquiry.id}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    return true;
  }
}
