import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { RagAnswer } from './model';

// Pythonサービスが返すJSONの形(snake_case)
interface RagSearchResponse {
  answer: string;
  citations: {
    manual_id: string;
    title: string;
    snippet: string;
  }[];
}

// Python(FastAPI)のRAGサービスを呼ぶHTTPクライアント。
// GraphQLの世界(フロント向け)とRAGの世界(Python)の橋渡し役
@Injectable()
export class RagService {
  private readonly baseUrl =
    process.env.RAG_SERVICE_URL ?? 'http://localhost:8000';

  async health(): Promise<string> {
    try {
      const res = await fetch(`${this.baseUrl}/health`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { status: string };
      return body.status;
    } catch {
      throw new ServiceUnavailableException('RAGサービスに接続できません');
    }
  }

  /** PDFの取り込み(テキスト抽出→チャンク分割→DB保存)をPythonに依頼する */
  async ingest(manualId: string, downloadUrl: string): Promise<number> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/ingest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ manual_id: manualId, download_url: downloadUrl }),
      });
    } catch {
      throw new ServiceUnavailableException('RAGサービスに接続できません');
    }
    if (!res.ok) {
      throw new ServiceUnavailableException(
        `PDFの取り込みに失敗しました (HTTP ${res.status})`,
      );
    }
    const body = (await res.json()) as { chunk_count: number };
    return body.chunk_count;
  }

  async search(question: string): Promise<RagAnswer> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question }),
      });
    } catch {
      throw new ServiceUnavailableException('RAGサービスに接続できません');
    }
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
      })),
    };
  }
}
