import { buildStatus } from './service';
import { CreditLevel, CreditSource } from './model';

/**
 * クレジット残高から「残り何日か」を出す計算のテスト。
 *
 * ここが狂うと移行の判断を誤る。特に、残高を取得できないときの推定が
 * 「実際より短く見える」側に外れることを固定しておく
 * (長く見えると準備が遅れて、データを失う)。
 */

const REF_AT = Date.parse('2026-08-20T13:30:00Z'); // service.ts の基準点
const DAY = 24 * 60 * 60 * 1000;

describe('buildStatus', () => {
  it('基準点の残高から、実測ペースで残り日数を出す', () => {
    // 基準点そのもの。$114.08 / $2.85 ≒ 40日
    const s = buildStatus(114.08, REF_AT);
    expect(s.source).toBe(CreditSource.AWS);
    expect(s.perDayUsd).toBe(2.85);
    expect(s.daysLeft).toBe(40);
    expect(s.level).toBe(CreditLevel.OK);
  });

  it('実際の減り具合から1日あたりを計算し直す', () => {
    // 10日で$40減った → $4/日。残り$74なら18日
    const s = buildStatus(74.08, REF_AT + 10 * DAY);
    expect(s.perDayUsd).toBe(4);
    expect(s.daysLeft).toBe(18);
  });

  it('停止していて残高が減っていなくても、実測平均に寄せて答える', () => {
    // 減っていない(rate<=0)ときに0除算やInfinityにならないこと
    const s = buildStatus(114.08, REF_AT + 10 * DAY);
    expect(s.perDayUsd).toBe(2.85);
    expect(Number.isFinite(s.daysLeft)).toBe(true);
    expect(s.daysLeft).toBe(40);
  });

  it('残高を取得できないときは推定に切り替え、そう分かる形で返す', () => {
    const s = buildStatus(null, REF_AT + 10 * DAY);
    expect(s.source).toBe(CreditSource.ESTIMATE);
    // $114.08 - $2.85×10 = $85.58 → 30日
    expect(s.remainingUsd).toBeCloseTo(85.58, 2);
    expect(s.daysLeft).toBe(30);
    expect(s.summary).toContain('推定');
  });

  it('残り30日以下で「準備を」、14日以下で「終えること」に変わる', () => {
    expect(buildStatus(2.85 * 31, REF_AT).level).toBe(CreditLevel.OK);
    const warn = buildStatus(2.85 * 30, REF_AT);
    expect(warn.level).toBe(CreditLevel.WARN);
    expect(warn.summary).toContain('準備');
    const urgent = buildStatus(2.85 * 14, REF_AT);
    expect(urgent.level).toBe(CreditLevel.URGENT);
    expect(urgent.summary).toContain('移行を終える');
  });

  it('残高が尽きても負の日数にならない', () => {
    const s = buildStatus(0, REF_AT);
    expect(s.daysLeft).toBe(0);
    expect(s.level).toBe(CreditLevel.URGENT);
  });

  it('推定は基準点から時間が経っても0を下回らない', () => {
    const s = buildStatus(null, REF_AT + 400 * DAY);
    expect(s.remainingUsd).toBe(0);
    expect(s.daysLeft).toBe(0);
  });

  it('枯渇日は日本時間の日付で返す', () => {
    // 2026-08-20 22:30 JST + 40日 = 2026-09-29
    const s = buildStatus(114.08, REF_AT);
    expect(s.exhaustionOn).toBe('2026-09-29');
  });
});
