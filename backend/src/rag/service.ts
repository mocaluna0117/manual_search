import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { RagAnswer } from './model';

// Pythonサービスが返すJSONの形(snake_case)
// Claudeが要求した管理操作(フォルダ作成など)。GraphQLには出さず、
// ChatServiceが内容を見て実行する
export interface RagAction {
  name: string;
  input: Record<string, unknown>;
}

interface RagSearchResponse {
  answer: string;
  citations: {
    manual_id: string;
    title: string;
    snippet: string;
    page: number | null;
  }[];
  options: string[];
  actions?: RagAction[];
}

// 用途ごとのタイムアウト(ミリ秒)。
// 取り込みはスキャンPDFの書き起こし(最大30ページ×Claude)があるため長い。
// タイムアウトが無いとRAG側が応答しないときにbackendの接続が延々ぶら下がる
const TIMEOUT_MS = {
  health: 5_000,
  search: 90_000,
  organize: 180_000,
  ingest: 900_000, // 15分
} as const;

// Python(FastAPI)のRAGサービスを呼ぶHTTPクライアント。
// GraphQLの世界(フロント向け)とRAGの世界(Python)の橋渡し役
@Injectable()
export class RagService {
  private readonly baseUrl =
    process.env.RAG_SERVICE_URL ?? 'http://localhost:8000';
  private readonly apiToken = process.env.RAG_API_TOKEN ?? '';

  /**
   * RAGサービスを呼ぶ共通処理。
   * - 共有トークンを付ける(RAG側は未認証だと401を返す)
   * - 用途に応じたタイムアウトを掛け、応答しない場合に呼び出し側を巻き込まない
   */
  private async request(
    path: string,
    timeoutMs: number,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<Response> {
    try {
      return await fetch(`${this.baseUrl}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Api-Token': this.apiToken,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        // タイムアウトに加えて、呼び出し元の中断(チャットの停止ボタン)でも打ち切る
        signal: signal
          ? AbortSignal.any([AbortSignal.timeout(timeoutMs), signal])
          : AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      // タイムアウトも通信断もここに来る。原因が分かる形で伝える
      const reason =
        e instanceof Error && e.name === 'TimeoutError'
          ? `応答がありません(${Math.round(timeoutMs / 1000)}秒でタイムアウト)`
          : '接続できません';
      throw new ServiceUnavailableException(`RAGサービスに${reason}`);
    }
  }

  async health(): Promise<string> {
    const res = await this.request('/health', TIMEOUT_MS.health);
    if (!res.ok) {
      throw new ServiceUnavailableException(
        `RAGサービスが異常です (HTTP ${res.status})`,
      );
    }
    const body = (await res.json()) as { status: string };
    return body.status;
  }

  /** PDFの取り込み(テキスト抽出→チャンク分割→DB保存)をPythonに依頼する */
  async ingest(manualId: string, downloadUrl: string): Promise<number> {
    const res = await this.request('/ingest', TIMEOUT_MS.ingest, {
      manual_id: manualId,
      download_url: downloadUrl,
    });
    if (!res.ok) {
      throw new ServiceUnavailableException(
        `PDFの取り込みに失敗しました (HTTP ${res.status})`,
      );
    }
    const body = (await res.json()) as { chunk_count: number };
    return body.chunk_count;
  }

  /** マニュアル一覧のカテゴリ分けをAIに依頼する(判断だけ返る。DB反映は呼び出し側) */
  async organize(
    manuals: { manualId: string; title: string; snippet: string }[],
    categories: string[],
    allowNew = true, // falseなら既存カテゴリだけに割り当てる(新カテゴリを作らせない)
    instruction?: string, // 管理者が指定した分類方針(例:「工種ごとに」)
    rules?: string[], // 管理者が蓄積した分類ルール(最優先で適用)
  ): Promise<{ manualId: string; category: string }[]> {
    const res = await this.request('/organize', TIMEOUT_MS.organize, {
      manuals: manuals.map((m) => ({
        manual_id: m.manualId,
        title: m.title,
        snippet: m.snippet,
      })),
      categories,
      allow_new: allowNew,
      instruction: instruction ?? null,
      rules: rules ?? [],
    });
    if (!res.ok) {
      throw new ServiceUnavailableException(
        `自動分類に失敗しました (HTTP ${res.status})`,
      );
    }
    const body = (await res.json()) as {
      assignments: { manual_id: string; category: string }[];
    };
    return body.assignments.map((a) => ({
      manualId: a.manual_id,
      category: a.category,
    }));
  }

  async search(
    question: string,
    image?: { base64: string; format: string },
    history?: { role: 'user' | 'assistant'; content: string }[],
    signal?: AbortSignal,
    isAdmin = false, // trueなら管理ツール(フォルダ作成・再分類)が有効になる
  ): Promise<RagAnswer & { actions: RagAction[] }> {
    const res = await this.request(
      '/search',
      TIMEOUT_MS.search,
      {
        question,
        image_base64: image?.base64,
        image_format: image?.format,
        history: history ?? [],
        is_admin: isAdmin,
      },
      signal,
    );
    if (!res.ok) {
      throw new ServiceUnavailableException(
        `RAGサービスがエラーを返しました (HTTP ${res.status})`,
      );
    }
    const body = (await res.json()) as RagSearchResponse;
    // Python流(snake_case)をGraphQL流(camelCase)に変換して返す
    return {
      answer: body.answer,
      citations: body.citations.map((c) => ({
        manualId: c.manual_id,
        title: c.title,
        snippet: c.snippet,
        pageNumber: c.page ?? null,
      })),
      options: body.options ?? [],
      actions: body.actions ?? [],
    };
  }
}
