# 使い方ガイド

`index.html` が原稿。ここからPDFを作って、マニュアルとして本番に登録している。
チャットで「使い方を教えて」と聞くとAIがこのガイドを根拠に答える。

アプリ内ヘルプ(`frontend/src/components/layout/HelpDialog.tsx`)と内容を揃えること。
機能を追加・変更したら両方を更新する。

## 更新手順

1. `index.html` を編集する

2. PDF化(ヘッダー・フッター無しで印刷)

   ```bash
   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless \
     --disable-gpu --no-pdf-header-footer \
     --print-to-pdf=usage-guide.pdf docs/usage-guide/index.html
   ```

3. 本番S3へアップロード

   ```bash
   aws s3 cp usage-guide.pdf \
     "s3://manual-search-manuals-271357390238/usage-guide/社内マニュアル検索_使い方ガイド.pdf"
   ```

4. 登録スクリプトを一発タスクで実行(同名なので差し替えになる)。
   RAG_SERVICE_URLの上書きが必要な点は reingest-all と同じ
   (単発タスクはService Connectに入らないため、ragタスクのIPを直接指定する)。
   サイズ(MANUAL_SIZE)は手順2で作ったPDFの実バイト数に合わせること。

   ```bash
   backend/src/scripts/register-manual-file.ts のコメント参照
   ```

## 注意

- macOSのフォントで作ったPDFは、一部の漢字が康熙部首(⽅ U+2F58など)として
  抽出される。rag側の取り込みで通常の漢字に畳んでいる(main.pyのnormalize_text)
  ので追加対応は不要だが、この畳み込みを消すと「使い方」で検索できなくなる
