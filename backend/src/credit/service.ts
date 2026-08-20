import { Injectable, Logger } from '@nestjs/common';
import { CreditLevel, CreditSource, CreditStatus } from './model';

/**
 * AWSの無料クレジットの残りを管理者に見せる。**移行が終わったら消す一時的な機能。**
 *
 * 消すときは (1) このディレクトリ (2) app.module.ts の CreditModule
 * (3) frontend の CreditBadge (4) 依存 @aws-sdk/client-freetier を削除する。
 *
 * 残高はAWSに問い合わせるが、タスクロールに freetier:GetAccountPlanState の
 * 権限が無いと取れない(infra/iam/backend-task-freetier.json を適用すると取れる)。
 * 権限が無くても使えるように、取れないときは実測ペースからの推定値を返す。
 * 推定は「止めずに動かし続けた場合」なので、夜間に止めれば実際はもっと長く持つ
 * (早めに警告する方向に外れるので、判断を誤らせない)。
 */

/** 実測した基準点。ここからの減り具合で1日あたりを割り出す */
const REFERENCE = {
  at: Date.parse('2026-08-20T13:30:00Z'),
  remainingUsd: 114.08,
};

/** 2026-08-06〜08-19の日次実績($2.67〜$3.79)の平均。問い合わせできないときに使う */
const FALLBACK_PER_DAY = 2.85;

/** 残り日数の警告のしきい値 */
const URGENT_DAYS = 14; // 切り替えを終えていないと危ない
const WARN_DAYS = 30; // 準備を始める頃

/** 問い合わせ結果を持ち回す時間。残高は日単位でしか動かないので長めでよい */
const CACHE_MS = 6 * 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class CreditService {
  private readonly logger = new Logger(CreditService.name);
  private cache: { at: number; status: CreditStatus } | null = null;

  async status(now = Date.now()): Promise<CreditStatus> {
    if (this.cache && now - this.cache.at < CACHE_MS) {
      return this.cache.status;
    }
    const remaining = await this.fetchRemaining();
    const status = buildStatus(remaining, now);
    this.cache = { at: now, status };
    return status;
  }

  /** AWSに残高を問い合わせる。取れなければnull(推定に切り替える) */
  private async fetchRemaining(): Promise<number | null> {
    try {
      // この機能を消すときに依存も消せるよう、使う瞬間まで読み込まない
      const { FreeTierClient, GetAccountPlanStateCommand } =
        await import('@aws-sdk/client-freetier');
      // 無料プランの状態を扱うAPIはus-east-1にしかない
      const client = new FreeTierClient({ region: 'us-east-1' });
      const res = await client.send(new GetAccountPlanStateCommand({}));
      const amount = res.accountPlanRemainingCredits?.amount;
      if (amount === undefined) return null;
      const value = typeof amount === 'string' ? Number(amount) : amount;
      return Number.isFinite(value) ? value : null;
    } catch (e) {
      // 権限が無い・APIが使えない等。推定値で続けるので警告だけ残す
      this.logger.warn(
        'クレジット残高を取得できませんでした(推定値を使います): ' +
          (e instanceof Error ? e.message : '不明なエラー'),
      );
      return null;
    }
  }
}

/**
 * 残高から、1日あたりの消費・残り日数・枯渇日を組み立てる。
 * 純粋な計算なのでテストしやすいよう外に出してある
 */
export function buildStatus(
  remainingUsd: number | null,
  now: number,
): CreditStatus {
  const elapsedDays = (now - REFERENCE.at) / DAY_MS;
  const source =
    remainingUsd === null ? CreditSource.ESTIMATE : CreditSource.AWS;

  // 基準点からの減り具合で1日あたりを出す。まだ日が経っていない、
  // または増えている(停止していた)場合は実測平均に寄せる
  let perDayUsd = FALLBACK_PER_DAY;
  if (remainingUsd !== null && elapsedDays >= 1) {
    const used = REFERENCE.remainingUsd - remainingUsd;
    const rate = used / elapsedDays;
    if (rate > 0.01) perDayUsd = rate;
  }

  const remaining =
    remainingUsd ??
    Math.max(0, REFERENCE.remainingUsd - FALLBACK_PER_DAY * elapsedDays);

  const daysLeft = Math.max(0, Math.floor(remaining / perDayUsd));
  const exhaustionOn = toDateString(now + daysLeft * DAY_MS);

  const level =
    daysLeft <= URGENT_DAYS
      ? CreditLevel.URGENT
      : daysLeft <= WARN_DAYS
        ? CreditLevel.WARN
        : CreditLevel.OK;

  const suffix = source === CreditSource.ESTIMATE ? '(推定)' : '';
  const summary =
    level === CreditLevel.URGENT
      ? `残り約${daysLeft}日${suffix} 移行を終えること`
      : level === CreditLevel.WARN
        ? `残り約${daysLeft}日${suffix} 移行の準備を`
        : `クレジット残り約${daysLeft}日${suffix}`;

  return {
    remainingUsd: round2(remaining),
    perDayUsd: round2(perDayUsd),
    daysLeft,
    exhaustionOn,
    level,
    source,
    summary,
  };
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

/** YYYY-MM-DD(日本時間)。枯渇日は日付だけ見せれば足りる */
function toDateString(ms: number) {
  return new Date(ms + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
