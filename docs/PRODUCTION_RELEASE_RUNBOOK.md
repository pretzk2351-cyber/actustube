# ActusTube Production Release Runbook

## 目的

Production公開とDB接続を安全に保護するための手順と停止条件を定めます。2026-07-22のProduction DBパスワード認証失敗は、今回限定の例外手順、本人による単一Googleログイン、同時間帯のRuntime Log確認を経て復旧完了しました。通常のVercel環境変数変更禁止を再び全面適用します。

## 現在の前提

以下は2026-07-23 02:10:39 JSTのProductionスナップショットです。deployment情報は確認日時に限定した状態であり、将来の作業では必ず読み取り専用で実状態を再確認してください。

- GitHub `main` は `e036d34db3939a79073fcb05db9c27acda06d0e9`
- `main` と `origin/main` は0 / 0で同期し、作業ツリーはclean
- 正式仕様書v1.0 `docs/ACTUSTUBE_PRODUCT_SPEC.md` はmainへfast-forward統合済みで、merge commitはない
- `7ef73eddf081cc0f558aa69e7e00af3a75f2fdbd` から `e036d34` の変更は `AGENTS.md`、正式仕様書Markdown、Project Status、本Runbookだけで、アプリコードは `7ef73ed` の内容から変わっていない
- Vercel projectはActusTube
- Vercel Production deploymentは `dpl_HgAsgkcPyJwkrSqgf5GCSHxqsfSn`
- Production domainは `https://actustube.vercel.app`
- deploymentはREADY / Currentで、source branchは `main`、commitは `e036d34db3939a79073fcb05db9c27acda06d0e9`
- トップページ、主要CSS、主要JavaScriptはHTTP 200
- deployment開始は2026-07-23 01:38:17 JST
- docs-only統合と自動deploymentでは、DB、Migration、schema、データ、Vercel設定・環境変数、Neon、Google Cloudを変更していない
- 週次改善サイクルrelease candidate `c6b403e` とGoogle OAuth callback互換性修正 `2f79fa7` はmain統合・公開済み
- `redirect_uri_mismatch` とOAuth callbackの `missing iss` は解消済み
- 安全な認証DB診断ログ `c3e71ff` はProduction公開済み
- 有効なpooled接続資格情報による読み取り専用接続確認と、Vercel Productionの `DATABASE_URL` 1件の更新が完了
- 本人による単一Googleログインに成功し、Google callbackはHTTP 302、callback直後のトップページはHTTP 200
- 本人申告のログイン時刻周辺にGoogle callbackとHTTP 200を確認し、エラー、5xx、DB認証失敗は確認されなかった。Vercel側ログの表示時刻にはタイムゾーンまたは表示形式による差があるため、本人申告時刻との秒単位の一致は断定しない
- Auth.jsエラー、DB同期診断ログ、DBパスワード認証失敗、Neon / PostgreSQL接続エラー、HTTP 5xxは0件
- 以前失敗していたGoogle OAuthアカウントのDB同期境界を正常に通過し、Production DB接続復旧は正式完了
- 復旧でrollbackは不要だった
- Production DBは `br-blue-bonus-aza51iwc`
- Production DBのEndpoint IDは `ep-polished-cloud-az8xdsqg`
- Production DBのMigration履歴は0000〜0005の6件
- Migration 0005はProduction本体へ適用済みで、再適用しない
- ActusTube管理SchemaはMigration 0005、`schema.ts`、0005 snapshotと一致
- 管理外のNeonサンプルテーブル `playing_with_neon` はアプリ未参照で、削除・変更しない
- バックアップブランチでMigrationリハーサル合格済み
- バックアップブランチ `br-crimson-shadow-azkeq0kc` は削除せず保持中
- Production公開前バックアップ `backup-pre-release-20260721-c6b403e`（`br-withered-darkness-azjg6fpl`）はReady確認済み
- アプリコード基準 `7ef73ed` の `npm audit` は全severity 0件
- 所有者による単一Googleログインは成功済みだが、チャンネル・動画・分析・AI提案・利用枠・週次改善を含む認証済みProduction全機能スモークテストは未実施

直前のdocs-only deployment `dpl_6YzgHwYxG2w9XhwpGpZfJsjQ42sa`（`main@f6014a1`）と、直近のアプリコード公開deployment `dpl_37GSvgbM3Y23QAs9571UtAwzD42d`（`main@7ef73ed`）は比較用履歴です。Production DB接続復旧時の `dpl_Gk8TkDoUfG5dbpdn3HKpEc5k36aa`（`main@696d4b0`）、旧状態の `main` `92f834d`、旧安定版 `5964c2d`、診断ログ未公開、原因未確定、DB資格情報の復旧待ちは完了済みの監査履歴です。これらは現在のCurrentまたは自動的なrollback先ではありません。

今回の `docs/allow-safe-docs-only-state-drift` はdocs-only状態差の限定規則を追加し、Project Statusと本Runbookを同期する文書branchです。作業branchのcommit・pushは、`main` 統合、Production操作、DB操作、設定変更を許可しません。認証済みProduction主要機能スモークは未実施です。

## docs-onlyスナップショット差の限定判定

Project Statusや本RunbookのGit / deployment識別子が現在の実状態と異なる場合も、一般的な不一致として停止する前に、次の手順を**すべて読み取り専用**で確認します。

1. 文書上のアプリコード基準を特定する。
2. その基準から現在の `main` までの変更ファイル一覧を確認する。
3. 変更が承認済み文書ファイル（`AGENTS.md`、`docs/ACTUSTUBE_PRODUCT_SPEC.md`、`docs/ACTUSTUBE_PROJECT_STATUS.md`、`docs/PRODUCTION_RELEASE_RUNBOOK.md`）だけであることを確認する。
4. `src/`、API route、test、`package.json`、`package-lock.json`、Migration、Drizzle schema、`vercel.json`、Next.js設定に差分がなく、環境変数、DB、Neon、Google Cloudも変更されていないことを確認する。
5. 現在の `main` と `origin/main` が同期し、作業ツリーがcleanで未追跡ファイルがないことを確認する。
6. Current Productionのsource関係について、次のAまたはBのどちらか一方を読み取り専用のGit / Vercel情報で厳密に証明する。
   - **A. 新Production deployment経路**
     1. Current Productionのsource commitが現在の `main` の完全SHAと一致する。
     2. 対象deploymentがProductionである。
     3. deploymentがREADY / Currentである。
     4. Production domain、トップページ、主要CSS、主要JavaScriptが正常である。
     5. deployment開始後のruntime error / fatal / HTTP 5xxに重大な異常がない。
   - **B. 明示的docs-only skip経路**
     1. docs-only統合直前に、Current Productionのsource commitと統合前 `main` の完全SHAが一致していたことを確認する。
     2. 統合前 `main` から現在の `main` までの全差分が、その作業でユーザーから明示的に承認された文書だけであることを確認する。
     3. 差分にアプリコード、API route、test、`package.json`、`package-lock.json`、Migration、Drizzle schema、Next.js設定、`.github` / workflow、script、`vercel.json`、DB関連ファイルが一切ないことを確認する。
     4. Vercel等の読み取り専用情報で、自動処理が現在の `main` の完全SHAを対象としてdocs-onlyを理由に明示的にskipしたことを一意に確認する。
     5. Current Productionが統合直前と同じdeployment / sourceのままREADY / Currentであり、そのsource commitが統合前 `main` の完全SHAと一致することを確認する。
     6. Production domain、トップページ、主要CSS、主要JavaScriptが正常であることを確認する。
     7. skip確認後のruntime error / fatal / HTTP 5xxに重大な異常がないことを確認する。
     8. 手動deploy、redeploy、promote、rollback、alias変更、Vercel設定・環境変数変更、DB変更を行っていないことを確認する。
     9. Production sourceから現在の `main` までの非文書部分が同一であることをGit差分で証明する。
7. Current ProductionがREADY / Currentで、トップページと主要静的リソースが正常であることを確認する。
8. 実行する作業が読み取り専用確認、文書更新、またはユーザーが明示的に許可したProductionスモークであることを確認する。
9. deploy、Migration、環境変数変更、DB変更、rollbackを伴わないことを確認する。

全条件に合格した場合だけ、差をdocs-onlyスナップショット差として記録し、対象作業を続行できます。例外を使用した報告には、文書上のスナップショット、現在のGit / Production、採用したA / B経路、docs-onlyである証拠、例外適用の事実、コード・DB・Migration・設定に差分がないことを記載します。

明示的docs-only skip経路では、Production sourceと現在の `main` の完全SHA一致を要求しません。代わりに、Production sourceと統合前 `main` の完全SHA一致、Production sourceから現在の `main` までの全差分がユーザー承認済み文書だけであること、skip対象commitが現在の `main` の完全SHAであることを要求します。skip理由または対象commitを一意に確認できない場合は停止し、単に新deploymentが見つからないだけではskip扱いにしません。

アプリコード、test、package、Migration、DB schema、Vercel設定、環境変数に差分がある場合、Production source関係についてA、Bのどちらも厳密に証明できない場合、READY / Currentでない場合、deploymentまたは差分を一意に特定できない場合、手動deploy等が必要な場合、安全性を証明できない場合、または必要なユーザー許可がない場合は、この限定判定を適用せず従来どおり停止します。Production変更、DB操作、Migration、rollbackへこの例外を拡張しません。

### docs-only統合後の自動処理判定

- 新しいProduction deploymentが作成された場合は、Aの新Production deployment経路で確認する。
- 現在の `main` の完全SHAを対象とする明示的なdocs-only skipを確認できた場合は、Bの明示的docs-only skip経路で確認する。
- どちらも一意に確認できない場合は停止する。

## 終了済み：今回限定のVercel環境変数例外

今回のDBパスワード認証失敗に限り、ActusTube projectのProduction scopeに一意に存在する `DATABASE_URL` だけを更新する例外を適用しました。この例外は、本人による単一Googleログインと同時間帯のRuntime Log確認が正常に完了したため、2026-07-22に終了しました。以下は再利用できる許可ではなく、終了済みの監査履歴です。

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
- この例外は、本人による単一ログイン結果の確認完了時点で終了済み

通常時のVercel環境変数変更禁止は全面的に再適用されています。`DATABASE_URL` を含むProduction環境変数は、新しい明示的許可なしに変更しません。Neon資格情報、role、password、endpoint、Production DB、Migration、schema、データも変更しません。この終了済み例外を将来の別障害へ流用しません。

## 復旧完了済み手順（監査履歴）

以下のPhase 1〜4は完了済みです。将来の障害対応を自動的に許可する手順ではありません。

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

### Phase 4：本人ログインと別タスクでの確認（完了）

Productionへダミーや検証専用のデータを作成してはいけません。データ保存を伴う確認は、ユーザーが明示的に承認した実利用データで行う場合に限ります。それ以外はバックアップまたは一時DBでの合格結果を利用し、Productionでは非破壊の確認だけを行います。

1. Googleアカウント選択、パスワード、二段階認証など本人操作の直前で停止する。
2. ユーザー本人がGoogleログインを1回だけ行う。自動再試行や2回目のログインは行わない。
3. 本人が完了時刻を報告した後、別タスクでcallback、ユーザー同期、DBパスワード認証失敗の再発、5xxを読み取り専用確認する。
4. 成功時は今回限定例外を終了し、追加環境変数変更・追加deployment・即時docs-only pushを行わない。
5. 失敗時はエラー分類だけを報告し、`DATABASE_URL` 以外へ例外を拡張せず停止する。

実績：本人による単一Googleログイン、callback HTTP 302、直後のトップページHTTP 200を確認しました。Auth.jsエラー、DB認証失敗、Neon / PostgreSQL接続エラー、HTTP 5xxは確認されず、例外を終了しました。

認証済みスモークテスト、AI提案、利用枠消費、週次改善項目の作成・更新はまだ行いません。

Productionでは検証専用データの作成や、その後片付けを前提とした削除を行いません。意図しないデータが作成された場合は独断で削除せず、その場で停止して対象と影響を報告してください。

## 共通停止条件

以下の場合は変更操作へ進まず、進行中なら直ちに停止します。Migration 0005は適用済みのため再実行しません。従来のProduction DB保護条件も引き続き有効です。

- `main`、`origin/main`、Production deploymentまたはsource commitが前提と不一致（全条件を満たすdocs-onlyスナップショット差を除く）
- 必読文書とGit・Vercel・Neonの実状態が不一致（全条件を満たすdocs-onlyスナップショット差を除く）
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

## Phase 2・3停止条件（復旧時の監査履歴）

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

今回のProduction DB接続復旧では、本人ログインとサーバーログが正常であり、rollbackは不要でした。2026-07-23 02:10:39 JST時点のCurrentは `dpl_HgAsgkcPyJwkrSqgf5GCSHxqsfSn` で、直前の `dpl_6YzgHwYxG2w9XhwpGpZfJsjQ42sa` と `dpl_37GSvgbM3Y23QAs9571UtAwzD42d` は同じアプリコード基準 `7ef73ed` を配信した比較用履歴です。以前のrollback候補を含む過去deploymentは監査上の履歴であり、将来の障害へ自動適用しません。将来rollbackが必要な場合は、その時点のCurrent deployment、直前の正常deployment、影響範囲を再確認し、新しい明示的許可に従います。適用済みMigrationやProduction DBを独断で巻き戻しません。

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
- Vercel環境変数の変更。終了済みの今回限定例外は再利用しない
- Google Cloud設定の変更
- 認証検証の緩和
- 自動または複数回のGoogleログイン試行
- force push
- バックアップブランチの早期削除
- DB準備前の `main` push
- 問題発生時の独断による連続操作

## 完了条件

2026-07-22のProduction DB接続復旧は、以下をすべて満たして正式完了しました。

- Production Migration履歴6件
- 必要DBオブジェクトとセキュリティ属性が存在
- 既存データ維持
- 最新修正コードがProductionで稼働
- 対象branch、database、endpoint、既存Production Runtime用role、pooled構成が一意に確認済み
- `BEGIN READ ONLY; SELECT 1; ROLLBACK;` による接続確認に合格
- Vercel Productionの `DATABASE_URL` だけを更新済み
- 新deploymentがREADY / Current
- 未認証Production確認に合格し、継続的5xxがない
- CodexによるGoogleログインは実行せず、本人による単一ログインに成功
- Git `main` と `origin/main` が同期
- 作業ツリーclean
- callback HTTP 302、直後のトップページHTTP 200
- Auth.jsエラー、DB認証失敗、Neon / PostgreSQL接続エラー、HTTP 5xxなし
- 今回限定の環境変数変更例外を終了し、通常の変更禁止規則を全面再適用
- rollback不要

第1回UI改修は `7ef73ed` としてmain統合・Production公開済みです。次工程は、限定規則差分の独立レビューとmain統合後、認証済みProduction主要機能スモークを再実行することです。この判定までは文書branchをmainへ統合せず、Production、DB、Migration、Vercel設定・環境変数を変更しません。
