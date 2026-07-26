import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { passportJwtSecret } from 'jwks-rsa';
import { ExtractJwt, Strategy } from 'passport-jwt';

// リクエストに付いてくるJWT(IDトークン)を検証する戦略。
// 署名の検証鍵はCognitoが公開しているJWKSエンドポイントから自動取得する(キャッシュ付き)
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor() {
    const region = process.env.COGNITO_REGION ?? 'ap-northeast-1';
    const userPoolId = process.env.COGNITO_USER_POOL_ID ?? '';
    const issuer = `https://cognito-idp.${region}.amazonaws.com/${userPoolId}`;

    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      algorithms: ['RS256'],
      issuer, // 「うちのUser Poolが発行したか」を検証
      audience: process.env.COGNITO_CLIENT_ID, // 「うちのアプリ向けか」を検証
      secretOrKeyProvider: passportJwtSecret({
        cache: true,
        rateLimit: true,
        jwksRequestsPerMinute: 5,
        jwksUri: `${issuer}/.well-known/jwks.json`,
      }),
    });
  }

  // 署名・発行元・期限の検証が通った後に呼ばれる。
  // 返した値が req.user としてResolverから参照できる
  validate(payload: { sub: string; email?: string }) {
    return { userId: payload.sub, email: payload.email };
  }
}
