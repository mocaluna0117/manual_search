/** 添付できる画像の上限(4MB) */
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024

/** 受け付ける画像形式。値はサーバーへ渡す形式名 */
export const ALLOWED_IMAGE_TYPES: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpeg',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

/** File → base64文字列(data:プレフィックスを除いた本体) */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result as string
      resolve(result.split(',', 2)[1] ?? '')
    }
    reader.onerror = () => reject(new Error('画像を読み込めませんでした'))
    reader.readAsDataURL(file)
  })
}

/**
 * 添付してよい画像かを確かめる。
 * 問題があれば利用者に見せる文言を返す(問題なければnull)
 */
export function checkImage(file: File): string | null {
  if (!(file.type in ALLOWED_IMAGE_TYPES)) {
    return 'PNG / JPEG / WebP / GIF を選んでください'
  }
  if (file.size > MAX_IMAGE_BYTES) {
    return '画像は4MB以下にしてください'
  }
  return null
}
