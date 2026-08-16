import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { PrismaService } from '../prisma/service';
import { buildRawEmail, canReplyTo } from './mail';

/** 問い合わせの宛先(カンマ区切りで複数可)。運用で変える場合は環境変数で上書きする */
const TO_EMAILS = (
  process.env.INQUIRY_TO_EMAIL ??
  'daibon20020117@gmail.com,kimura@takamatsu-build.co.jp'
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
// SESは差出人も認証済みアドレスである必要があるため、既定は先頭の宛先にする
const FROM_EMAIL = process.env.INQUIRY_FROM_EMAIL ?? TO_EMAILS[0];
const MAX_LENGTH = 2000;

/** 画像1枚の上限(バイト) */
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

/** 添付できる枚数 */
const MAX_IMAGE_COUNT = 5;

/**
 * 添付の合計サイズの上限。
 * メールはbase64で約1.33倍に膨らむため、受信箱側の上限(25MB前後が多い)に
 * 引っかからないよう、手前で止める
 */
const MAX_TOTAL_BYTES = 10 * 1024 * 1024;

/** 添付を受け付ける画像形式(拡張子はここから決める) */
const IMAGE_TYPES: Record<string, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
};

/** 画像1件分。フロントからはbase64で受け取る */
export interface InquiryImage {
  base64: string;
  format: string;
}

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
  async send(
    message: string,
    userEmail: string | null,
    images: InquiryImage[] = [],
  ) {
    const trimmed = message.trim();
    if (!trimmed) {
      throw new BadRequestException('内容を入力してください');
    }
    if (trimmed.length > MAX_LENGTH) {
      throw new BadRequestException(`内容が長すぎます(${MAX_LENGTH}文字まで)`);
    }

    // 画像は添付として送るだけで、DBには保存しない。
    // 「うまくいかない画面」を見せてもらうのが目的なので、
    // 本文と一緒に届けば足りる(DBを重くしない)
    if (images.length > MAX_IMAGE_COUNT) {
      throw new BadRequestException(
        `画像は${MAX_IMAGE_COUNT}枚までにしてください`,
      );
    }
    const attachments = images.map((image, i) => {
      const ext = image.format.toLowerCase();
      const mimeType = IMAGE_TYPES[ext];
      if (!mimeType) {
        throw new BadRequestException(`対応していない画像形式です: ${ext}`);
      }
      const bytes = Buffer.from(image.base64, 'base64');
      if (bytes.length === 0) {
        throw new BadRequestException('画像を読み取れませんでした');
      }
      if (bytes.length > MAX_IMAGE_BYTES) {
        throw new BadRequestException('画像は1枚あたり4MB以下にしてください');
      }
      // 受信側で並び順が分かるよう、名前に番号を振る
      return { bytes, mimeType, filename: `screenshot-${i + 1}.${ext}` };
    });
    const totalBytes = attachments.reduce((sum, a) => sum + a.bytes.length, 0);
    if (totalBytes > MAX_TOTAL_BYTES) {
      throw new BadRequestException('画像の合計が大きすぎます(全部で10MBまで)');
    }

    const inquiry = await this.prisma.inquiry.create({
      data: { message: trimmed, userEmail },
    });

    const subject = `【Manualy】お問い合わせ (${userEmail ?? '不明'})`;
    const body = [
      `送信者: ${userEmail ?? '不明'}`,
      // サーバーの時計はUTCなので、時間帯を明示しないとイギリス標準時で出る
      `受付日時: ${inquiry.createdAt.toLocaleString('ja-JP', {
        timeZone: 'Asia/Tokyo',
      })}`,
      '',
      trimmed,
    ].join('\n');

    // SESのサンドボックスでは未認証の宛先が1人でも混ざると送信全体が拒否される。
    // 1通ずつ送ることで、届けられる宛先には確実に届ける
    for (const to of TO_EMAILS) {
      try {
        await this.ses.send(
          new SendEmailCommand({
            FromEmailAddress: FROM_EMAIL,
            Destination: { ToAddresses: [to] },
            // 送信者へそのまま返信できるようにする(同じ社内ドメイン宛ては除く)
            ReplyToAddresses: canReplyTo(to, userEmail)
              ? [userEmail as string]
              : undefined,
            // 添付があるときは、こちらで組み立てたメール全体を渡す。
            // Simple形式は添付を扱えないため
            Content: attachments.length
              ? {
                  Raw: {
                    Data: buildRawEmail({
                      from: FROM_EMAIL,
                      to,
                      replyTo: canReplyTo(to, userEmail) ? userEmail : null,
                      subject,
                      body,
                      attachments,
                    }),
                  },
                }
              : {
                  Simple: {
                    Subject: { Data: subject, Charset: 'UTF-8' },
                    Body: { Text: { Data: body, Charset: 'UTF-8' } },
                  },
                },
          }),
        );
      } catch (e) {
        // 送れない宛先があっても問い合わせ自体は受理済み(DBに残っている)
        this.logger.error(
          `問い合わせメールの送信に失敗 id=${inquiry.id} to=${to}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    return true;
  }
}

/**
 * 添付つきのメールを組み立てる(MIMEのmultipart)。
 *
 * SESのSimple形式は添付を扱えないので、メール全体を自前で作ってRawで渡す。
 * 日本語の件名と本文は、そのまま書くと文字化けするのでbase64で包む
 */
