import { Injectable, ServiceUnavailableException } from '@nestjs/common';

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
}
