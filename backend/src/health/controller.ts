import { Controller, Get } from '@nestjs/common';
import { Public } from '../auth/public';

/**
 * ALB(ロードバランサ)のヘルスチェック用エンドポイント。
 *
 * GETで叩けて認証不要である必要がある:
 * - GraphQLは POST /graphql なのでヘルスチェックに使えない
 * - 認証ガードはRESTにも適用されるため @Public() が必須
 *   (付けないと401になり、ALBが「異常」と判定してタスクを落とし続ける)
 *
 * あえて「生存確認のみ」でDBやRAGサービスは見ない。
 * 依存先の障害でヘルスチェックを落とすと、ECSがタスクを次々に入れ替えて
 * 状況を悪化させるだけで復旧しないため(DBが落ちているのはタスクの責任ではない)。
 */
@Controller()
export class HealthController {
  @Public()
  @Get('healthz')
  healthz() {
    return { status: 'ok' };
  }
}
