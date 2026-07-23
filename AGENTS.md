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

### docs-only状態差の限定例外

`docs/ACTUSTUBE_PROJECT_STATUS.md` と `docs/PRODUCTION_RELEASE_RUNBOOK.md` は確認日時点の状態スナップショットです。その文書を `main` へ統合した直後に、docs-only commitとdocs-only deploymentによって `main` SHAやdeployment IDだけが1世代進む場合があります。以下の条件を**すべて**満たす場合に限り、その差を一般的な状態不一致とは区別し、読み取り専用確認、文書更新、またはユーザーが明示的に許可したProductionスモークを続行できます。

1. 現在の `main` と `origin/main` が同期している。
2. 作業ツリーがcleanで、未追跡ファイルがない。
3. 文書に記載されたアプリコード基準から現在の `main` までの変更が、承認済み文書ファイル（`AGENTS.md`、`docs/ACTUSTUBE_PRODUCT_SPEC.md`、`docs/ACTUSTUBE_PROJECT_STATUS.md`、`docs/PRODUCTION_RELEASE_RUNBOOK.md`）だけである。
4. `src/`、API route、test、`package.json`、`package-lock.json`、Migration、Drizzle schema、`vercel.json`、Next.js設定、環境変数、DB、Neon、Google Cloudに変更が一切ない。
5. Current Productionのsource関係について、次のAまたはBのどちらか一方を読み取り専用のGit / Vercel情報で厳密に証明できる。
   - **A. 新deployment経路**：Current Productionのsource commitが現在の `main` の完全SHAと一致し、対象がProduction deploymentで、READY / Current、Production domain・主要CSS・主要JavaScriptが正常であり、deployment開始後のruntime error / fatal / HTTP 5xxに重大な異常がない。
   - **B. 明示的docs-only skip経路**：次をすべて満たす。
     1. docs-only統合直前に、Current Productionのsource commitと統合前 `main` の完全SHAが一致していた。
     2. 統合前 `main` から現在の `main` までの全差分が、その作業でユーザーから明示的に承認された文書だけである。
     3. 差分にアプリコード、API route、test、`package.json`、`package-lock.json`、Migration、Drizzle schema、Next.js設定、`.github` / workflow、script、`vercel.json`、DB関連ファイルが一切ない。
     4. Vercel等の読み取り専用情報で、自動処理が現在の `main` の完全SHAを対象としてdocs-onlyを理由に明示的にskipしたことを一意に確認できる。
     5. Current Productionが統合直前と同じdeployment / sourceのままREADY / Currentであり、そのsource commitが統合前 `main` の完全SHAと一致する。
     6. Production domain、トップページ、主要CSS、主要JavaScriptが正常である。
     7. skip確認後のruntime error / fatal / HTTP 5xxに重大な異常がない。
     8. 手動deploy、redeploy、promote、rollback、alias変更、Vercel設定・環境変数変更、DB変更を行っていない。
     9. Production sourceから現在の `main` までの非文書部分が同一であることをGit差分で証明できる。
6. Current ProductionがREADY / Currentである。
7. Productionトップページと主要静的リソースが正常である。
8. 実行する作業が、読み取り専用確認、文書更新、またはユーザーが明示的に許可したProductionスモークのいずれかである。
9. deploy、Migration、環境変数変更、DB変更を伴わない。

次の場合はこの例外を適用せず、従来どおり停止してください。

- アプリコード、test、package、Migration、DB schema、Vercel設定、環境変数に差分がある。
- Production source関係についてA、Bのどちらも厳密に証明できない、READY / Currentではない、または対象deploymentを一意に特定できない。
- 差分が承認済み文書ファイルだけであることを証明できない、または変更内容を一意に特定できない。
- Production変更、DB操作、Migration、rollbackを伴う。
- 作業に必要なユーザーの明示的許可がない。

明示的docs-only skip経路では、Production sourceと現在の `main` の完全SHA一致を要求しません。代わりに、Production sourceと統合前 `main` の完全SHA一致、Production sourceから現在の `main` までの全差分がユーザー承認済み文書だけであること、skip対象commitが現在の `main` の完全SHAであることを要求します。skip理由または対象commitを一意に確認できない場合は停止し、単に新deploymentが見つからないだけではskip扱いにしません。

この例外を使用した場合は、文書上のスナップショット、現在のGit / Production、docs-onlyである証拠、例外を適用したこと、コード・DB・Migration・設定に差分がないことを完了報告へ明記してください。この例外を一般的な状態不一致の無視には使用しません。
