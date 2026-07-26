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

## 依存関係セキュリティrelease gate

通常のrelease gateは、full `npm audit` とRuntime `npm audit --omit=dev` のHigh / Criticalがともに0件であることです。この原則は維持し、一般的なdevDependency脆弱性を許容しません。

唯一、[GHSA-mh99-v99m-4gvgの承認済み期限付き例外](./SECURITY_EXCEPTION_GHSA-MH99-V99M-4GVG.md)については、次を**すべて**満たす場合に限り、full auditの当該GHSAだけを期限付きでrelease判定から除外できます。

1. 正式な例外文書が存在し、対象がGHSA-mh99-v99m-4gvg / CVE-2026-14257だけである。
2. ActusTubeプロジェクトオーナーの明示承認が記録されている。
3. 2026-08-24 23:59 JST以前で、例外が失効・撤回されていない。
4. 初回2026-08-02、その後最低週1回の再確認が期限内に完了し、次の再確認期限を超過していない。
5. Runtime `npm audit --omit=dev` が全severity 0件である。
6. full auditの当該GHSA以外のHigh / Criticalが0件である。
7. Production dependency、server/client trace、bundle、middleware/proxy、API route、server action、起動・lifecycle経路、ユーザー入力から当該packageへ到達しない。
8. 対象candidateのPreviewでNode.js 24.x、Corepack、npm 11.18.0、既定install、`npm run build`を確認済みである。
9. 必須検証と独立レビューに合格し、P0 / P1 / P2 / P3 / NOT VERIFIEDがすべて0件である。
10. 正式例外文書の即時解除条件に該当していない。

1条件でも満たさない場合は通常基準へ戻り、High / Criticalが0件でなければ停止します。この限定例外はmain統合、Production deployment、DB接続、Migration、Neon、Vercel設定・環境変数、Google Cloud / OAuth、Productionスモークを承認しません。Production工程は別計画、最新状態の確認、独立監査、明示許可を必要とします。

## 明示承認済みProduction Migration限定手順

通常時の任意のNeon branch作成、Production DBのschema・関数・ACL変更、未承認Migration、手動SQL、既存Migrationの変更・再適用は引き続き禁止します。以下は一般的権限、恒常的許可、Codexの自律判断権限、または将来Migrationの包括承認ではありません。文書整合化、review、commit、PreviewだけでもProduction releaseの承認にはなりません。

この限定手順は、各releaseについてproject ownerが別の実行指示または承認記録で対象release candidate branch、完全SHA、対象Migration、承認範囲、検証結果を固定し、以下の全条件をAND条件として満たす場合に限り発動できます。1項目でもFAILまたはNOT VERIFIEDなら発動せず停止し、条件を類推、拡張、または将来releaseへ持ち越してはいけません。

### 発動条件

1. project ownerが対象Production releaseを明示承認している。
2. 対象release candidateのbranchと完全SHAが固定され、local・remote・upstreamが同期し、worktreeがcleanである。
3. 適用対象Migrationのrepository pathとjournal entryが完全に特定され、既存Migrationに差分がない。
4. 必読文書、Migration SQL、関連コード、fresh / upgrade検証、旧Productionコード互換性が確認済みであり、Production Migrationは事前に別工程で明示承認されたbackupまたはchild branchでリハーサル合格が記録されている。
5. Migration SQLが独立レビュー済みで、必須の独立レビューにP0 / P1 / P2 / P3 / NOT VERIFIEDがない。
6. 通常のHigh / Critical 0件release gate、または「依存関係セキュリティrelease gate」に記載した単一の承認済み期限付き例外の全条件を満たす。期限付き例外を他の脆弱性へ拡張しない。
7. Current Productionのsource、READY / Current、主要HTTP、runtime error / fatal / 5xxを読み取り専用で確認する。
8. 対象Production branchとdatabaseを推測せず一意に特定し、Migration前preflightが全項目合格する。
9. Migration前に、承認対象と同じProduction sourceのsnapshotまたはbackupを最大1件だけ作成し、利用可能状態を読み取り専用で確認する。
10. Migrationにはpooled接続ではなく、同じProduction branch / databaseへのdirect接続を使用する。
11. pending Migrationが承認対象だけであり、対象Migrationが未適用である。
12. repositoryに定義された正式Migration commandだけを使用し、commandの起動を最大1回に限定する。
13. Migration後の履歴、schema、関数、owner、ACL、security mode、search path、主要aggregate件数を読み取り専用で確認する。
14. Migration異常時に再実行、別command、手動修正、自動rollback、restoreを行わない。
15. Migration後DB検証が全項目合格し、direct接続secretをprocess環境から削除した後だけGit統合工程へ進む。

### Production backup / snapshot限定例外

任意のbranch作成と開発目的のProduction複製は禁止します。明示承認されたProduction Migrationの直前に限り、次の優先順位でbackupを最大1件だけ作成できます。

1. 対象Production branchで安全に利用できるNeon snapshot
2. snapshotを利用できない場合だけ、対象Production branchの現在時点から作成するbackup branch

作成前にsource Production branch、database系統、現在時点、名前衝突の不存在、今回の作成数0件を一意に確認します。Migration直前の復旧用backupはMigration検証環境またはテスト環境として使用せず、backup側へMigrationを適用せず、schema、data、computeを変更しません。AGENTS.mdが要求するリハーサルは、これとは分離された、別工程で明示承認済みのbackupまたはchild branchで完了していなければなりません。この記載は新しいrehearsal branch作成を自動承認しません。

「最大1件」と「作成試行最大1回」を別々に管理します。作成操作を開始した時点で試行1回と数え、失敗、timeout、接続切断、応答不明、結果不明でも2件目を作成せず再試行しません。既存backup一覧と状態を読み取り専用で確認し、作成結果、source、利用可能状態を一意に確定できない場合は停止します。

backup branchの任意作成・削除を許可したと解釈してはいけません。rollbackまたはrestoreには、対象、目的、影響、手順を固定した別のproject owner明示承認が必要であり、Migration承認から推定しません。

### version管理済み正式Migration限定例外

Production DBへの任意変更、手作業のSQL修正、未レビューSQL、未承認Migration、Migration外のschema・関数・ACL変更は禁止します。明示承認されたversion管理済みの正式Migrationだけを、全release gate合格時に限り適用できます。正式Migrationであることだけでは許可になりません。

- `package.json`に定義された正式commandを使用し、現在の構成では`npm run db:migrate`から`drizzle-kit migrate`を実行する。
- `drizzle.config.ts`が参照する`DIRECT_DATABASE_URL`へ、保存・表示しないdirect接続secretをprocess環境だけで渡す。pooled接続、host置換、接続先の推測は禁止する。
- 現在固定されたDrizzle実装ではpending Migrationの各statementとMigration履歴行を同じtransaction内で実行する。この境界をrelease前に再確認し、手動transactionや補助SQLを追加しない。
- Migration commandを起動した時点で適用試行1回と数え、最大1回とする。
- Migration SQLに定義された変更以外を加えず、実行時編集、既存Migration変更、再適用、手動追加SQL、部分修正、補修SQLを行わない。
- owner名とrole名は期待値一致のbooleanだけを記録し、個別ユーザーデータを取得しない。

Migration 0006を対象とするreleaseでは、対象を`drizzle/0006_usage_status_plan_snapshot.sql`へ固定します。このMigrationは4つのversion付き利用枠関数を追加し、旧`reserve_usage_limits`を互換wrapperへ置換し、ACL preflight後に旧関数のowner、ACL、security modeをversion付き関数へ継承して、固定`search_path`とPUBLIC実行権限なしを検証します。変更可能範囲は同SQLに定義された関数定義、互換wrapper、owner、ACL、security mode、search pathだけです。既存Migration 0000〜0005を変更または再適用しません。

Migration 0006のpreflightでは履歴が0000〜0005の6件、pendingが0006だけ、0006が未適用であることを確認します。適用後は履歴が0000〜0006の7件となり、0006が1回だけ記録され、version付き関数と互換wrapperの定義・権限がMigration SQLおよび関連検証scriptと一致することを確認します。旧Productionコードが互換wrapperを通して動作可能であることもrelease gateに残します。

### 失敗・結果不明時の停止

command非0終了、timeout、接続切断、terminal異常終了、履歴とschemaの部分更新、または完了状態を取得できない場合は失敗または結果不明として扱います。Migrationを再実行せず、別commandで試さず、SQLを変更せず、手動部分修正、自動rollback、backup restoreを行いません。

許可された安全なread-only接続でMigration履歴とschemaを確認し、確認できた現在状態だけを記録して停止します。read-only確認でも接続先または権限を一意に確定できない場合は、それ以上操作しません。rollbackまたはrestoreには別のproject owner明示承認が必要です。

### Production releaseの順序

承認済みProduction Migrationを含むreleaseは、次の順序を変更せず実行します。

1. 対象releaseのproject owner明示承認
2. release candidate branch、完全SHA、対象Migration、承認範囲の固定
3. 必読文書、期限付き例外、release gateの確認
4. release candidate、Migration SQL、fresh / upgrade Migration、旧コード互換性の検証と独立レビュー
5. Current Productionの読み取り専用確認
6. Production snapshotまたはbackupを最大1件作成し、利用可能状態を確認
7. 同じProduction branch / databaseへのdirect接続を安全に取得
8. Production Migration preflight
9. 承認対象Migrationを正式commandで最大1回適用
10. Migration後の読み取り専用DB検証
11. direct接続secretをprocess環境から削除
12. Git統合可否とremote状態の最終確認
13. project ownerが承認した方式でmainへ統合
14. 許可されたmainへの通常push
15. main pushで自動作成されるProduction deploymentだけを確認
16. 承認範囲内のProductionスモーク
17. 完了報告または停止報告

backup前にMigrationを適用せず、preflight合格前にMigration commandを起動せず、Migration後DB検証合格前にmainへ進みません。main push前にProduction deploymentを作成せず、manual Deploy、Redeploy、Promote、alias変更、空commitを使用しません。direct接続secretを保持したままGitまたはVercel工程へ進みません。

### 秘密情報・個人情報

接続文字列、Environment Variablesの値、host、database名、role名、username、password、token、Cookieを画面、terminal、log、Git、文書、報告へ表示または保存しません。preflightと事後検証はboolean、schema metadata、個人情報を含まないaggregate件数に限定し、個人情報、本文、OAuth情報、個別レコードを取得しません。秘密情報を表示しなければ続行できない場合は停止します。

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
- Migration 0006適用前のpreflightでMigration履歴が0000〜0005の6件ではない、または適用後に0000〜0006の7件・0006の記録1件を確認できない
- 0005が未適用、複数回記録、またはjournalの順序・timestampと不一致。Migration 0006を承認対象とする場合は0006の順序・timestampも同様に確認する
- 既存データ件数が想定と不一致
- 承認済みProduction Migrationで必要なsnapshotまたはbackupが一意に存在しない、利用可能状態でない、またはsourceを確認できない
- DB変更を伴う将来作業で、必要な新規snapshotまたはbackupの作成試行、利用可能状態、source確認に失敗または結果不明
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
- DB関数、schema、権限の任意変更。上記の全条件を満たす明示承認済みversion管理Migrationに定義された変更だけを限定例外とする
- Neon branchの任意作成・削除。上記の全条件を満たす明示承認済みProduction Migration直前のbackup branch最大1件・作成試行最大1回だけを限定例外とし、削除は許可しない
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

第1回UI改修は `7ef73ed` としてmain統合・Production公開済みです。Production Migration限定手順の文書整合化、独立レビュー、文書commit、release candidate branchへのpush、Preview確認はProduction releaseと分離します。新しいrelease candidate確定後も、対象branch、完全SHA、対象Migration、承認範囲を固定した別のproject owner明示承認があるまでmain、Production、DB、Migration、Neon、Vercel設定・環境変数を変更しません。
