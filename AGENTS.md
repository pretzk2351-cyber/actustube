# ActusTube Codex Instructions

## ユーザーについて

- ユーザーはプログラミング初心者です。作業結果は専門用語だけで終わらせず、実施内容と次の操作を明確に説明してください。
- ユーザーへ手動操作を求める場合は、貼り付けるコマンドと操作場所を明記してください。
- コードを提示する場合は、可能な限り既存コードと追加コードを含む完全な置換版にしてください。

## 基本作業ルール

- 作業開始時にGitブランチ、HEAD、upstream、作業ツリーを確認してください。
- 変更前に既存実装、テスト、Migration、関連APIを調査してください。
- 推測で既存仕様を変更せず、関係ないリファクタリングを行わないでください。
- Migration 0000〜0004を変更しないでください。未適用Migrationも勝手に書き換えないでください。
- DB制約をアプリ側の都合で削除・緩和しないでください。
- 所有者・認証・利用枠制御を維持し、処理失敗時に利用枠を消費したままにしないでください。
- 想定外エラーの内部情報をAPIレスポンスへ出さないでください。

## Gitルール

- `main` へのmerge・pushは、ユーザーの明示指示がある場合だけ実施してください。
- `main` へのpushでVercel Productionが自動デプロイされることを認識し、本番DB準備前にpushしないでください。
- 作業完了時にcommitハッシュ、変更ファイル、upstreamとの同期状態、作業ツリーの状態を報告してください。
- force pushは禁止です。
- featureブランチをユーザーの指示なく削除しないでください。

## Productionルール

- Neonの `development` ブランチは、名前に反してVercel Productionが接続する実Production DBです。名前だけでdevelopment環境と判断しないでください。
- Production DB操作前にProject ID、Branch ID、Endpoint ID、DB名を再確認してください。
- Production Migrationは、バックアップまたは子ブランチでリハーサルに合格した後だけ実施してください。
- Migrationは原則としてDBを先に更新し、その後コードをデプロイしてください。
- Production操作には明確な停止条件を設定してください。
- Productionへテストデータを作成しないでください。
- OAuthトークン、接続文字列、パスワード、APIキーを表示・保存・commitしないでください。

## 検証ルール

関連変更に応じて、次を実行してください。

- 自動テスト
- ESLint
- TypeScript型検査
- Production build
- `npm audit`
- `drizzle-kit check`
- Schema drift確認
- `git diff --check`
- 秘密情報混入確認
- 実DB検証が必要な変更は、一時DBまたはバックアップブランチで確認
- UI変更は320px、375px、390px、1024px、1440pxで確認
- Console、Network、404、500、重複リクエストを確認

## 作業前に読む文書

- `docs/ACTUSTUBE_PRODUCT_SPEC.md`
- `docs/ACTUSTUBE_PROJECT_STATUS.md`
- `docs/PRODUCTION_RELEASE_RUNBOOK.md`

## 文書更新ルール

- `main` 統合、Migration適用、Productionデプロイ、ロールバックなどで状態が変わった場合は、関連文書の更新も提案してください。
- 実際の状態と文書が異なる場合は、文書を信じて作業を続けず、その場で停止して差異を報告してください。
