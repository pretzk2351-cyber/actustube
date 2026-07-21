# ActusTube Production Release Runbook

## 目的

週次改善サイクルMVP公開後に残ったGoogle OAuthのDBユーザー同期障害を、安全な診断ログで特定します。各Phaseを分離し、停止条件に1つでも該当した場合は独断で続行せず、その場で停止して報告します。

## 現在の前提

以下は2026-07-21の診断作業開始前スナップショットです。実行時には必ず読み取り専用で再確認してください。

- GitHub `main` は `2f79fa7199b8b376ba16838a175c8af436fe69c7`
- `main` と `origin/main` は0 / 0で同期し、作業ツリーはclean
- Vercel Production deploymentは `dpl_BFQqxdLJqaFS6vVcPVfZvfVkmFGQ`
- Production domainは `https://actustube.vercel.app`
- deploymentはREADY / Currentで、source branchは `main`、commitは `2f79fa7`
- 週次改善サイクルrelease candidate `c6b403e` とGoogle OAuth callback互換性修正 `2f79fa7` はmain統合・公開済み
- `redirect_uri_mismatch` とOAuth callbackの `missing iss` は解消済み
- 現在は `signIn` callback内の `public.sync_google_oauth_account(...)` が `NeonDbError` で失敗し、セッション・JWT作成前に停止
- PostgreSQLの正確な原因は既存ログの情報不足により未確定。一時的なNeon HTTP障害とは断定しない
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

旧状態の `main` `92f834d`、旧安定版 `5964c2d`、`fix/weekly-action-duplicate-conflict` 未統合、新規バックアップ作成・main統合を次工程とする記載は、完了済みの公開履歴です。

## 正しい実行順序

### Phase 1：文書同期と診断ブランチ

1. Gitのbranch、HEAD、upstream、作業ツリーを確認する。
2. `main` と `origin/main` が `2f79fa7` で0 / 0、作業ツリーcleanであることを確認する。
3. Vercel Productionが `dpl_BFQqxdLJqaFS6vVcPVfZvfVkmFGQ`、READY / Current、source commit `2f79fa7` であることを確認する。
4. `fix/auth-db-error-diagnostics` を `main` から作成する。
5. Project StatusとRunbookを現在状態へ同期する。AGENTS.mdの運用規則・停止条件・禁止事項は変更しない。
6. 文書差分、`git diff --check`、秘密情報混入を確認し、文書同期を独立commitにする。
7. 必読文書を再読し、実状態との矛盾が解消したことを確認する。

### Phase 2：安全な認証DB診断ログ

1. `syncGoogleAccount` のDB呼び出し境界だけを変更する。
2. `[auth][google-account-sync-diagnostic]` で、明示的allowlistのエラー属性だけを構造化出力する。
3. error / cause / sourceErrorを循環参照対策付き・最大3〜4階層で探索する。
4. message等を長さ制限し、メールアドレス、Google ID、token、Cookie、接続URL、SQL、query、params、ユーザー情報を伏せる。
5. エラー全体、stack、SQL文、SQL引数を出力しない。
6. 既存エラーを再throwし、認証判定・DB処理・セッション処理を変更しない。
7. 抽出・伏字・循環参照・深さ制限・正常時非出力・既存失敗処理維持の単体テストを追加する。

### Phase 3：検証・main統合・Production公開

1. `npm ci`、テスト、ESLint、TypeScript、Production build、`npm audit`、`drizzle-kit check`、Schema drift、`git diff --check`、秘密情報混入を確認する。
2. 今回の必要ファイルだけをstageし、診断実装をcommitする。
3. fixブランチを通常pushする。
4. `origin/main` が `2f79fa7` から変化していないことを再確認する。
5. `main` へfast-forward統合し、`origin/main` へ一度だけ通常pushする。
6. 新しいVercel Production deploymentがREADY / Currentになるまで確認する。
7. トップページ、静的リソース、auth providers、session、未認証保護API、継続的5xxの有無を確認する。
8. 重大なアプリ全体の回帰がある場合だけ、直前の `dpl_BFQqxdLJqaFS6vVcPVfZvfVkmFGQ` へrollbackする。OAuth障害だけを理由にrollbackしない。

### Phase 4：本人ログイン1回と診断

Productionへダミーや検証専用のデータを作成してはいけません。データ保存を伴う確認は、ユーザーが明示的に承認した実利用データで行う場合に限ります。それ以外はバックアップまたは一時DBでの合格結果を利用し、Productionでは非破壊の確認だけを行います。

1. Googleアカウント選択、パスワード、二段階認証など本人操作の直前で停止する。
2. ユーザー本人がGoogleログインを1回だけ行う。自動再試行や2回目のログインは行わない。
3. `[auth][google-account-sync-diagnostic]`、Auth.jsエラー、callback HTTP状態を読み取り専用で確認する。
4. PostgreSQL code / constraintが判明した場合は、正確な原因と最小修正案を報告して停止する。
5. sourceErrorが通信・timeout・fetch・接続リセット等を示す場合は、根拠を報告して停止する。
6. ログイン成功時は画面更新後のセッション維持だけを確認して停止する。
7. 診断情報が不足する場合は、推測修正せず不足項目を報告して停止する。

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
- `origin/main` が `2f79fa7` から進んでいる
- 新deploymentのBuild失敗、起動エラー、継続的5xx、アプリ全体の重大回帰

## ロールバック

新コード公開後に異常が発生した場合：

1. 新しい `main` commitを即座にrevertしない。
2. 重大なアプリ全体の回帰がある場合だけ、直前のProduction deployment `dpl_BFQqxdLJqaFS6vVcPVfZvfVkmFGQ` へInstant Rollbackする。OAuth障害だけを理由にrollbackしない。
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
- Vercel環境変数の変更
- Google Cloud設定の変更
- 認証検証の緩和
- 自動または複数回のGoogleログイン試行
- force push
- バックアップブランチの早期削除
- DB準備前の `main` push
- 問題発生時の独断による連続操作

## 完了条件

以下がすべて合格した時に、診断ログのProduction公開工程を完了し、本人操作待ちで停止します。

- Production Migration履歴6件
- 必要DBオブジェクトとセキュリティ属性が存在
- 既存データ維持
- 最新修正コードがProductionで稼働
- 診断ログがallowlist・伏字・長さ制限・深さ制限を満たす
- 自動テスト、ESLint、TypeScript、Production build、`npm audit`、Drizzle検査に合格
- 新deploymentがREADY / Current
- 未認証Production確認に合格し、継続的5xxがない
- Googleログインはまだ自動実行していない
- Git `main` と `origin/main` が同期
- 作業ツリーclean
