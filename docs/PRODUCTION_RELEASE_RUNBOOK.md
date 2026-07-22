# ActusTube Production Release Runbook

## 目的

安全な診断ログで確定したGoogle OAuthのProduction DBパスワード認証失敗を、今回限定の例外で復旧します。各Phaseを分離し、停止条件に1つでも該当した場合は独断で続行せず、その場で停止して報告します。

## 現在の前提

以下は2026-07-22のProduction DB接続復旧作業開始前スナップショットです。実行時には必ず読み取り専用で再確認してください。

- GitHub `main` は `c3e71ffdf5b66f97e1303f9e3f62481b7f725f2a`
- `main` と `origin/main` は0 / 0で同期し、作業ツリーはclean
- Vercel Production deploymentは `dpl_HPGCXavawHj3yHKo9nFg99LGB6jR`
- Production domainは `https://actustube.vercel.app`
- deploymentはREADY / Currentで、source branchは `main`、commitは `c3e71ff`
- 週次改善サイクルrelease candidate `c6b403e` とGoogle OAuth callback互換性修正 `2f79fa7` はmain統合・公開済み
- `redirect_uri_mismatch` とOAuth callbackの `missing iss` は解消済み
- 安全な認証DB診断ログ `c3e71ff` はProduction公開済み
- 本人による単一ログインで、Runtimeの `DATABASE_URL` によるDBパスワード認証失敗と確定
- `public.sync_google_oauth_account(...)` のSQL実行前に接続認証で停止
- timeout、fetch失敗、接続リセットではなく、Migration、関数、schema、制約、権限の問題でもない
- Production DBは `br-blue-bonus-aza51iwc`
- Production DBのEndpoint IDは `ep-polished-cloud-az8xdsqg`
- Production DBのMigration履歴は0000〜0005の6件
- Migration 0005はProduction本体へ適用済みで、再適用しない
- ActusTube管理SchemaはMigration 0005、`schema.ts`、0005 snapshotと一致
- 管理外のNeonサンプルテーブル `playing_with_neon` はアプリ未参照で、削除・変更しない
- バックアップブランチでMigrationリハーサル合格済み
- バックアップブランチ `br-crimson-shadow-azkeq0kc` は削除せず保持中
- Production公開前バックアップ `backup-pre-release-20260721-c6b403e`（`br-withered-darkness-azjg6fpl`）はReady確認済み
- `npm audit` のhigh以上は0件

旧状態の `main` `92f834d`、旧安定版 `5964c2d`、診断ログ未公開、原因未確定は完了済みの履歴です。

## 今回限定のVercel環境変数例外

通常時のVercel環境変数変更禁止は維持します。今回のDBパスワード認証失敗に限り、ActusTube projectのProduction scopeに一意に存在する `DATABASE_URL` だけを更新できます。

- 対象branch：`br-blue-bonus-aza51iwc`
- 対象database：`neondb`
- role：既存Production Runtime用role。role名は表示・文書化しない
- 既存のpooled構成を維持し、directへ切り替えない
- 接続URIは標準出力、ファイル、Git、文書、ログへ表示・保存しない
- 接続確認は `BEGIN READ ONLY; SELECT 1; ROLLBACK;` だけ
- `DIRECT_DATABASE_URL`、Preview、Development、Custom Environment、Shared / Team変数、他の変数は変更しない
- DB、データ、Migration、schema、関数、制約、権限、Neon構成、role、Google Cloudは変更しない
- roleパスワード再設定や別の秘密値変更が必要な場合は停止する
- `DATABASE_URL` 更新後は新しいProduction deploymentを1件だけ作成する
- 自動deploymentを優先し、重複deploymentを作成しない
- CodexはGoogleログインを実行しない
- 新deploymentと現在の文書上deploymentが異なることだけを理由に、本人ログイン後のログ確認を停止しない
- この例外は、本人による単一ログイン結果の確認が完了した時点で自動的に終了する

復旧deployment IDは本人ログイン後の完了報告に記録する。即時の追跡docs commitによって追加deploymentを発生させない。

## 正しい実行順序

### Phase 1：文書同期と復旧ブランチ

1. Gitのbranch、HEAD、upstream、作業ツリーを確認する。
2. `main` と `origin/main` が `c3e71ff` で0 / 0、作業ツリーcleanであることを確認する。
3. Vercel Productionが `dpl_HPGCXavawHj3yHKo9nFg99LGB6jR`、READY / Current、source commit `c3e71ff` であることを確認する。
4. `fix/production-database-url-recovery` を `main` から作成する。
5. Project StatusとRunbookを現在状態と今回限定例外へ同期する。AGENTS.mdの運用規則・停止条件・禁止事項は変更しない。
6. 文書差分、`git diff --check`、秘密情報混入を確認し、文書同期を独立commitにする。
7. 必読文書を再読し、実状態との矛盾が解消したことを確認する。

### Phase 2：安全な接続資格情報の確認

1. 対象project、branch、database、read-write endpoint、既存Production Runtime用roleを非秘密情報だけで一意に特定する。
2. 現在のRuntimeがpooled構成であることを確認し、取得時もpooledを明示する。
3. 接続URIを表示・保存せず、同一の安全な処理内のメモリだけで取得する。
4. `BEGIN READ ONLY; SELECT 1; ROLLBACK;` だけを実行する。
5. branch、database、endpoint、pooled状態と接続成功、短い非可逆fingerprintだけを記録する。
6. 取得または接続確認に失敗した場合は `DATABASE_URL` を変更せず停止する。

### Phase 3：DATABASE_URL更新・main統合・Production公開

1. Vercel Productionにproject固有・Sensitive・重複なしの `DATABASE_URL` が一意に存在することを確認する。
2. 接続確認済みURIを安全なstdinまたは同一プロセスのメモリから渡し、既存 `DATABASE_URL` を更新する。追加・削除はしない。
3. `origin/main` が `c3e71ff` から変化していないことを再確認する。
4. 文書commitを `main` へfast-forward統合し、`origin/main` へ通常pushする。
5. 自動Production deploymentを優先し、作成された場合は手動deploymentを作成しない。
6. docs-only commitが明確にskipされ、自動deploymentが存在しない場合だけ、cleanな `main` の完全SHAから `vercel deploy --prod --skip-domain` を1件作成し、正式なpromoteを使用する。手動alias変更はしない。
7. 新deploymentがREADY / Currentとなり、Production domainが配信することを確認する。
8. トップページ、静的リソース、auth providers、session、未認証保護GET API、継続的5xxの有無を確認する。
9. 重大なアプリ全体の回帰がある場合だけ、事前に特定した直前の正常deploymentへrollbackする。本人ログイン待ちだけを理由にrollbackしない。

### Phase 4：本人ログイン待ちと別タスクでの確認

Productionへダミーや検証専用のデータを作成してはいけません。データ保存を伴う確認は、ユーザーが明示的に承認した実利用データで行う場合に限ります。それ以外はバックアップまたは一時DBでの合格結果を利用し、Productionでは非破壊の確認だけを行います。

1. Googleアカウント選択、パスワード、二段階認証など本人操作の直前で停止する。
2. ユーザー本人がGoogleログインを1回だけ行う。自動再試行や2回目のログインは行わない。
3. 本人が完了時刻を報告した後、別タスクでcallback、ユーザー同期、DBパスワード認証失敗の再発、5xxを読み取り専用確認する。
4. 成功時は今回限定例外を終了し、追加環境変数変更・追加deployment・即時docs-only pushを行わない。
5. 失敗時はエラー分類だけを報告し、`DATABASE_URL` 以外へ例外を拡張せず停止する。

認証済みスモークテスト、AI提案、利用枠消費、週次改善項目の作成・更新はまだ行いません。

Productionでは検証専用データの作成や、その後片付けを前提とした削除を行いません。意図しないデータが作成された場合は独断で削除せず、その場で停止して対象と影響を報告してください。

## 共通停止条件

以下の場合は変更操作へ進まず、進行中なら直ちに停止します。Migration 0005は適用済みのため再実行しません。従来のProduction DB保護条件も引き続き有効です。

- `main`、`origin/main`、Production deploymentまたはsource commitが前提と不一致
- 必読文書とGit・Vercel・Neonの実状態が不一致
- 作業開始前に意図しないGit差分が存在

- Endpoint ID不一致
- Migration履歴が6件ではない
- 0005が未適用、複数回記録、またはjournalの順序・timestampと不一致
- 既存データ件数が想定と不一致
- バックアップブランチが存在しない、またはReadyではない
- DB変更を伴う将来作業で、必要な新規バックアップの作成またはReady確認に失敗
- Migrationファイルに改行コード差では説明できないSQL本文の変更がある
- 必要なテーブル、enum、Index、外部キー、関数、セキュリティ属性が不足
- 既存データ件数が変化
- ActusTube管理対象のSchema drift
- `playing_with_neon` がアプリから参照される、または管理Schemaと衝突する
- Production HTTPエラー
- Productionに新しい500
- 意図しないProduction環境変数またはデプロイの変化
- 意図しないGit差分

Migration 0005を含む適用済みMigrationは再実行しないでください。エラー後に独自判断でSQLを編集・実行せず、Migrationファイルも編集しないでください。

## Phase 2・3停止条件

- `main` またはfixブランチが想定コミットと異なる
- upstream設定済みのブランチがupstreamと未同期
- 競合
- テスト失敗
- lintエラー
- TypeScriptエラー
- build失敗
- audit脆弱性
- Drizzle不整合
- Schema drift
- 秘密情報候補
- 意図しない差分
- 診断ログにallowlist外のプロパティ、stack、SQL、query、params、個人情報、認証情報、接続情報が含まれる
- 正常同期時にも診断ログが出力される
- 既存の認証成功・失敗判定、DB処理、セッション処理に変化がある
- `origin/main` が `c3e71ff` から進んでいる
- 新deploymentのBuild失敗、起動エラー、継続的5xx、アプリ全体の重大回帰

## ロールバック

新コード公開後に異常が発生した場合：

1. 新しい `main` commitを即座にrevertしない。
2. 重大なアプリ全体の回帰がある場合だけ、事前に一意に特定した直前のProduction deployment `dpl_HPGCXavawHj3yHKo9nFg99LGB6jR` へInstant Rollbackする。本人ログイン待ちだけを理由にrollbackしない。
3. Production HTTPとログを確認する。
4. 適用済みMigration 0005は追加型のため、独断でDBを巻き戻さない。
5. バックアップブランチを維持する。
6. 原因を調査し、ユーザーと対応を決定する。

## 絶対禁止

- `DATABASE_URL` 全体の表示
- PostgreSQL接続文字列の表示
- パスワード、APIキー、OAuthトークン、Cookie、セッション値の表示
- Production DBの削除・リセット
- Productionへの未検証SQLの直接実行
- 0000〜0005の再適用
- Migrationの場当たり的な編集
- DB関数、schema、権限の変更
- Neon branchの作成・削除
- Vercel環境変数の変更。ただし上記「今回限定のVercel環境変数例外」に完全一致するProduction `DATABASE_URL` の1回の更新だけを除く
- Google Cloud設定の変更
- 認証検証の緩和
- 自動または複数回のGoogleログイン試行
- force push
- バックアップブランチの早期削除
- DB準備前の `main` push
- 問題発生時の独断による連続操作

## 完了条件

以下がすべて合格した時に、Production DB接続復旧の未認証確認工程を完了し、本人操作待ちで停止します。

- Production Migration履歴6件
- 必要DBオブジェクトとセキュリティ属性が存在
- 既存データ維持
- 最新修正コードがProductionで稼働
- 対象branch、database、endpoint、既存Production Runtime用role、pooled構成が一意に確認済み
- `BEGIN READ ONLY; SELECT 1; ROLLBACK;` による接続確認に合格
- Vercel Productionの `DATABASE_URL` だけを更新済み
- 新deploymentがREADY / Current
- 未認証Production確認に合格し、継続的5xxがない
- Googleログインはまだ自動実行していない
- Git `main` と `origin/main` が同期
- 作業ツリーclean
