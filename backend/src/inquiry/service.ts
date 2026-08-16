import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { PrismaService } from '../prisma/service';

/** 問い合わせの宛先(カンマ区切りで複数可)。運用で変える場合は環境変数で上書きする */
const TO_EMAILS = (
  process.env.INQUIRY_TO_EMAIL ??
  'daibon20020117@gmail.com,kimura@takamatsu-build.jp'
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
// SESは差出人も認証済みアドレスである必要があるため、既定は先頭の宛先にする
const FROM_EMAIL = process.env.INQUIRY_FROM_EMAIL ?? TO_EMAILS[0];
const MAX_LENGTH = 2000;

/** 添付できる画像の上限(バイト)。SESの受け入れ上限に対して十分な余裕を取る */
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

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
    image?: InquiryImage,
  ) {
    const trimmed = message.trim();
    if (!trimmed) {
      throw new BadRequestException('内容を入力してください');
    }
    if (trimmed.length > MAX_LENGTH) {
      throw new BadRequestException(
        `内容が長すぎます(${MAX_LENGTH}文字まで)`,
      );
    }

    // 画像は添付として送るだけで、DBには保存しない。
    // 「うまくいかない画面」を見せてもらうのが目的なので、
    // 本文と一緒に届けば足りる(DBを重くしない)
    let attachment: { bytes: Buffer; mimeType: string; ext: string } | null =
      null;
    if (image) {
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
        throw new BadRequestException('画像は4MB以下にしてください');
      }
      attachment = { bytes, mimeType, ext };
    }

    const inquiry = await this.prisma.inquiry.create({
      data: { message: trimmed, userEmail },
    });

    const subject = `【Manualy】お問い合わせ (${userEmail ?? '不明'})`;
    const body = [
      `送信者: ${userEmail ?? '不明'}`,
      `受付日時: ${inquiry.createdAt.toLocaleString('ja-JP')}`,
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
            // 送信者へそのまま返信できるようにする
            ReplyToAddresses: userEmail ? [userEmail] : undefined,
            // 添付があるときは、こちらで組み立てたメール全体を渡す。
            // Simple形式は添付を扱えないため
            Content: attachment
              ? {
                  Raw: {
                    Data: buildRawEmail({
                      from: FROM_EMAIL,
                      to,
                      replyTo: userEmail,
                      subject,
                      body,
                      attachment,
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
function buildRawEmail({
  from,
  to,
  replyTo,
  subject,
  body,
  attachment,
}: {
  from: string;
  to: string;
  replyTo: string | null;
  subject: string;
  body: string;
  attachment: { bytes: Buffer; mimeType: string; ext: string };
}): Buffer {
  // 区切り文字は本文と衝突しない文字列にする
  const boundary = `----manualy-${Date.now().toString(36)}`;
  const encodeHeader = (text: string) =>
    `=?UTF-8?B?${Buffer.from(text, 'utf8').toString('base64')}?=`;
  // base64は76文字ごとに改行する決まり(長い1行だと弾く受信側がある)
  const wrap = (text: string) => text.replace(/.{1,76}/g, '$&\r\n');

  const lines = [
    `From: ${from}`,
    `To: ${to}`,
    ...(replyTo ? [`Reply-To: ${replyTo}`] : []),
    `Subject: ${encodeHeader(subject)}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrap(Buffer.from(body, 'utf8').toString('base64')),
    `--${boundary}`,
    `Content-Type: ${attachment.mimeType}`,
    'Content-Transfer-Encoding: base64',
    `Content-Disposition: attachment; filename="screenshot.${attachment.ext}"`,
    '',
    wrap(attachment.bytes.toString('base64')),
    `--${boundary}--`,
    '',
  ];
  return Buffer.from(lines.join('\r\n'), 'utf8');
}
