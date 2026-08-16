const authority = import.meta.env.VITE_COGNITO_AUTHORITY as string
const clientId = import.meta.env.VITE_COGNITO_CLIENT_ID as string
const cognitoDomain = import.meta.env.VITE_COGNITO_DOMAIN as string

// react-oidc-context(AuthProvider)に渡す設定。
// authority(発行者URL)からOIDCの各エンドポイントを自動発見してくれる
export const oidcConfig = {
  authority,
  client_id: clientId,
  redirect_uri: window.location.origin, // ログイン後に戻ってくる場所
  response_type: 'code', // 認可コードフロー(+PKCE)。SPAの標準
  scope: 'openid email profile',
  // Cognitoのログイン画面を日本語で出す。
  // 既定は英語で、langを付けたときだけ日本語になる(付けた後はCognitoが
  // 言語をcookieに覚えるので、次回以降は付けなくても日本語のまま)
  extraQueryParams: { lang: 'ja' },
  // ログインから戻った直後、URLに残る ?code=...&state=... を消して見た目を綺麗に
  onSigninCallback: () => {
    window.history.replaceState({}, document.title, window.location.pathname)
  },
}

/**
 * ログイン中ユーザーのIDトークンを取り出す。
 * oidc-client-tsはユーザー情報をsessionStorageに保存するので、
 * Reactの外(Apolloのリンク)からでも読めるようにここで直接参照する
 */
export function getIdToken(): string | null {
  const raw = sessionStorage.getItem(`oidc.user:${authority}:${clientId}`)
  if (!raw) return null
  try {
    return (JSON.parse(raw) as { id_token?: string }).id_token ?? null
  } catch {
    return null
  }
}

/** Cognito側のセッションも含めて完全にログアウトする */
export function signOutRedirect() {
  const logoutUri = encodeURIComponent(window.location.origin)
  // ログアウト後にログイン画面が出る場合もあるので、こちらにも言語を渡す
  window.location.href = `${cognitoDomain}/logout?client_id=${clientId}&logout_uri=${logoutUri}&lang=ja`
}
