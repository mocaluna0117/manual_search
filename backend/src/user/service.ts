import { BadRequestException, Injectable } from '@nestjs/common';
import { UserRole } from '../../generated/prisma/client';
import { AuthUser } from '../auth/current-user';
import { PrismaService } from '../prisma/service';
import { CognitoAdminService } from './cognito';
import { ManagedUser } from './model';

/**
 * 一度に招待できる件数の上限。
 * 部署単位の追加を想定した数で、押し間違いで大量に送ってしまう事故も防ぐ
 */
const MAX_INVITE_AT_ONCE = 30;

@Injectable()
export class UserService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cognito: CognitoAdminService,
  ) {}

  /**
   * JWTで認証されたユーザーをDBに確保する(JITプロビジョニング)。
   * 初回アクセスなら作成、既存ならメールアドレスを最新化。
   * Cognito側でユーザーを追加するだけで、アプリ側の登録作業は不要になる
   */
  ensure(authUser: AuthUser) {
    return this.prisma.user.upsert({
      where: { cognitoSub: authUser.userId },
      update: { email: authUser.email },
      create: { cognitoSub: authUser.userId, email: authUser.email },
    });
  }

  /** 全ユーザーの一覧(アカウント=Cognito、権限=DBを合成) */
  async listManaged(): Promise<ManagedUser[]> {
    const [cognitoUsers, dbUsers] = await Promise.all([
      this.cognito.listUsers(),
      this.prisma.user.findMany({ select: { cognitoSub: true, role: true } }),
    ]);
    const roleBySub = new Map(dbUsers.map((u) => [u.cognitoSub, u.role]));
    return cognitoUsers.map((c) => ({
      cognitoSub: c.sub,
      email: c.email,
      // まだ一度もログインしていない(DB行が無い)ユーザーは既定のMEMBER扱い
      role: roleBySub.get(c.sub) ?? UserRole.MEMBER,
      passwordPending: c.passwordPending,
      createdAt: c.createdAt,
    }));
  }

  /** ユーザーを招待する(Cognito作成+権限をDBへ事前登録) */
  async invite(email: string, role: UserRole): Promise<ManagedUser> {
    const created = await this.cognito.createUser(email);
    // ログイン前でも権限が決まっているように、DB行を先に作っておく。
    // JITプロビジョニングはcognitoSubで照合するので、この行がそのまま使われる
    await this.prisma.user.upsert({
      where: { cognitoSub: created.sub },
      update: { role },
      create: { cognitoSub: created.sub, email, role },
    });
    return {
      cognitoSub: created.sub,
      email: created.email,
      role,
      passwordPending: created.passwordPending,
      createdAt: created.createdAt,
    };
  }

  /**
   * 複数のメールアドレスをまとめて招待する。
   *
   * 1件ずつ招待すると、届く時刻が人によってばらける。同じ説明を別々の
   * タイミングで受け取ると「自分だけ何か違うのか」と迷わせるので、
   * まとめて実行して同じ時刻に届くようにする。
   *
   * 1件の失敗(既に登録済み・形式不正)で全体を止めない。
   * 送れたものは送り、送れなかったものは理由を返して画面に出す
   */
  async inviteMany(
    emails: string[],
    role: UserRole,
  ): Promise<{
    invited: ManagedUser[];
    failed: { email: string; reason: string }[];
  }> {
    // 前後の空白を落とし、大文字小文字の違いは同じ宛先として1件にまとめる
    const seen = new Set<string>();
    const targets: string[] = [];
    for (const raw of emails) {
      const email = raw.trim();
      if (!email) continue;
      const key = email.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      targets.push(email);
    }
    if (targets.length === 0) {
      throw new BadRequestException('招待するメールアドレスを入力してください');
    }
    if (targets.length > MAX_INVITE_AT_ONCE) {
      throw new BadRequestException(
        `一度に招待できるのは${MAX_INVITE_AT_ONCE}件までです`,
      );
    }

    const invited: ManagedUser[] = [];
    const failed: { email: string; reason: string }[] = [];
    // 並行して呼ぶ(順番に待つと最後の人へ届くのが遅れる)
    await Promise.all(
      targets.map(async (email) => {
        try {
          invited.push(await this.invite(email, role));
        } catch (e) {
          failed.push({
            email,
            reason: e instanceof Error ? e.message : '不明なエラー',
          });
        }
      }),
    );
    // 画面に出す順番を入力順に戻す(並行実行で崩れるため)
    const order = new Map(targets.map((e, i) => [e.toLowerCase(), i]));
    const at = (e: string | null) => order.get((e ?? '').toLowerCase()) ?? 999;
    invited.sort((a, b) => at(a.email) - at(b.email));
    failed.sort((a, b) => at(a.email) - at(b.email));
    return { invited, failed };
  }

  /** 権限の変更。自分自身は変更不可(管理者が誰もいなくなる事故を防ぐ) */
  async updateRole(
    cognitoSub: string,
    role: UserRole,
    actor: AuthUser,
  ): Promise<ManagedUser> {
    if (cognitoSub === actor.userId) {
      throw new BadRequestException('自分自身の権限は変更できません');
    }
    await this.prisma.user.upsert({
      where: { cognitoSub },
      update: { role },
      create: { cognitoSub, role },
    });
    const users = await this.listManaged();
    const updated = users.find((u) => u.cognitoSub === cognitoSub);
    if (!updated) {
      throw new BadRequestException('ユーザーが見つかりません');
    }
    return updated;
  }

  /**
   * ユーザーの削除。自分自身は削除不可。
   * DB行を消すと会話履歴もカスケード削除される(退職者の後始末を想定)
   */
  async remove(cognitoSub: string, actor: AuthUser): Promise<boolean> {
    if (cognitoSub === actor.userId) {
      throw new BadRequestException('自分自身は削除できません');
    }
    await this.cognito.deleteUser(cognitoSub);
    await this.prisma.user
      .delete({ where: { cognitoSub } })
      .catch(() => undefined); // 一度もログインしていない人はDB行が無い
    return true;
  }
}
