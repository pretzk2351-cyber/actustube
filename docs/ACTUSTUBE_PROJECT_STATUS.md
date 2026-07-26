# ActusTube Project Status

最終更新日：2026-07-26

> 2026-07-23 02:10:39 JSTの読み取り専用確認に基づく状態スナップショットです。`main` / `origin/main` は `e036d34db3939a79073fcb05db9c27acda06d0e9` で同期し、Productionは `dpl_HgAsgkcPyJwkrSqgf5GCSHxqsfSn`（`main@e036d34db3939a79073fcb05db9c27acda06d0e9`）をREADY / Currentで配信しています。トップ・主要CSS・主要JavaScriptはHTTP 200です。アプリコードの直近基準は `7ef73eddf081cc0f558aa69e7e00af3a75f2fdbd` であり、そこから現在の `main` までの変更は承認済み文書ファイルだけです。認証済みProduction主要機能スモークは未実施です。この文書自体の後続docs-only commitやdeploymentによりGit / Production識別子が進む可能性があり、その場合もAGENTS / Runbookの全条件を満たすdocs-only限定例外だけが適用候補です。Production DB接続復旧は完了済みで、通常の環境変数変更禁止規則が引き続き適用されています。

## プロジェクト概要

ActusTubeは、YouTube投稿者向けのAI分析・改善サービスです。

中心価値：

- 通常動画とShortsのデータ分析
- 投稿者固有の強み・弱みの抽出
- 根拠付きの改善提案
- 次回動画の内容・構成・制作方法の提案
- 分析→改善→実行→振り返りのサイクル形成
- 投稿者がすぐ実行できる具体的な提案を重視

予定プラン：

- Free
- Standard
- Pro

原価割れ防止を最優先とし、動画本数、AI処理量、利用回数、文字起こし、DB、ストレージ等を上限管理します。

## 技術構成

`package.json`、Drizzle設定、実装を確認した構成です。

- Next.js 15.5.20
- React / React DOM 19.0.0
- TypeScript 5系
- Auth.js（`next-auth` 5.0.0 beta 25以降）
- Drizzle ORM 0.45.2 / Drizzle Kit 0.31.10
- Neon Serverless PostgreSQL
- OpenAI API（OpenAI SDK 6.1.0以降）
- YouTube Data API
- Vitest 4.1.10以降
- Vercel
- Stripe SDK 18.0.0以降は依存関係に存在するが、Stripe機能は今回の公開対象外

## 承認済み期限付きセキュリティ例外

現在のリリース準備feature branchでは、[GHSA-mh99-v99m-4gvg / CVE-2026-14257の正式な期限付き例外](./SECURITY_EXCEPTION_GHSA-MH99-V99M-4GVG.md)がActusTubeプロジェクトオーナーにより明示承認済みです。

- 対象：`brace-expansion` のdevDependency lint経路にあるGHSA-mh99-v99m-4gvgだけ
- 承認日：2026-07-26
- 失効日：2026-08-24 23:59 JST
- 初回週次確認期限：2026-08-02
- Runtime `npm audit --omit=dev`：全severity 0件
- full `npm audit`：対象GHSAによるHigh 9件のみ。対象GHSA以外は0件
- Production dependency / trace / bundle / route / action / user-input経路：対象packageへの到達なし
- Preview：Node.js 24.x、Corepack、npm 11.18.0、既定install、`npm run build`を実証済み
- ローカル回帰検証：247件成功、4件skip、React act警告0件
- 独立レビュー：P0 / P1 / P2 / P3 / NOT VERIFIEDすべて0件
- Git Fork Protection：有効
- `DATABASE_URL`：Productionだけに保存され、Previewには含まれない

通常のHigh / Critical 0件release gateは維持しています。今回の例外は単一GHSA、期限、週次再確認、即時解除条件、恒久対応を正式文書で拘束するもので、一般的なdevDependency脆弱性を許容しません。

本feature branchはまだ`main`へ統合しておらず、Productionへ反映していません。Production DBへ接続せず、Migration 0006は未適用で、Neon、Vercel設定・環境変数、Google Cloud / OAuthも変更していません。例外文書を含む新しい完全HEADは、全ローカル検証、独立レビュー、exact Preview、Current Production不変確認の合格後にだけrelease candidateとして確定します。その次工程で、release candidateを基準にProduction release可否を別途判定します。

## Production release停止とRunbook整合化

Migration 0006を含むProduction releaseは、RunbookのNeon branch作成全面禁止およびDB関数・schema・権限変更全面禁止と、承認されたbackup・正式Migration手順が矛盾していたため、必読文書確認で安全に停止しました。停止判断後、Production release、Production DB接続、Migration command、Neon backup / snapshot、main統合、Production deploymentは開始していません。

Runbookは、通常時の任意branch作成、任意DB変更、未承認Migration、既存Migration変更・再適用を引き続き禁止し、各releaseでproject ownerがrelease candidate branch、完全SHA、対象Migration、承認範囲を固定し、全release gateを満たした場合だけ発動できる狭い例外へ整合化します。backupはsnapshot優先・最大1件・作成試行最大1回、version管理済み正式Migrationはcommand起動最大1回とし、失敗または結果不明時の再実行、手動修正、自動rollback、restoreを許可しません。

この文書整合化、review、commit、PreviewはProduction releaseの承認ではありません。Migration 0006はProduction未適用のままです。新しいrelease candidate確定後、対象branch、完全SHA、Migration 0006、承認範囲を固定した別のproject owner明示承認を受け、Production手順を最初から再開します。

## 実装済み機能

- Googleログイン・ログアウト
- `youtube.readonly` 権限
- YouTubeアクセストークン更新
- チャンネル取得
- 通常動画・Shorts取得
- 再生数等の統計
- 投稿頻度
- 月別推移
- 再生数分布
- 動画ランキング
- 低再生動画抽出
- AIによる強み・弱み・改善点・次回提案
- API認証保護
- Free利用上限
- DB利用枠管理と失敗時の予約解放
- 分析履歴
- AI提案履歴
- 週次改善項目
- `planned` / `completed` / `skipped`
- 結果メモ
- 1ユーザーにつき `planned` 1件
- 1分析につき改善項目1件
- カーソルページネーション
- 所有者アクセス制御
- 320pxから1440pxまでのレスポンシブ対応

## 週次改善サイクルMVP

統合済みコミット：

- `363fa43` `feat: add weekly improvement cycle`
- `92f834d` `fix: prevent responsive overflow in YouTube form`

API 500修正コミット：

- `35b9615ce474194277e35921b628744f8dc640e5`
- `fix: handle duplicate weekly improvement actions`

この修正コミットはrelease candidate `c6b403e` に含まれ、`main` へ統合・Production公開済みです。

修正内容：

- `DrizzleQueryError` の `cause` 内にある `NeonDbError` を探索
- PostgreSQLエラーコード `23505` とconstraint名を認識
- `improvement_actions_analysis_run_unique` の違反だけを409へ変換
- APIコード `IMPROVEMENT_ACTION_ALREADY_EXISTS` を返却
- `planned` 制約に対する既存の409を維持
- `completed` / `skipped` 後も、同じ分析に作成フォームを再表示しない
- 409発生時は履歴を再取得
- 想定外のDBエラーは内部情報を出さない安全な500に変換

## 第1回UI改修

`main` へfast-forward統合・Production公開済みの関連コミット：

- `65cdff375ffeae8f6c063f7a4e6201f5dbf81508` `fix: override sharp to patched libvips release`
- `f675ee9cc1db785adc625ae7f8887914da0fe35a` `feat: establish UI foundation and primary improvement flow`
- `0b4d83509755e69495584871968015ca8b483a0a` `fix: distinguish weekly cycle error notices`
- `3ede11a415ad47899f9776bd5fcd0ca33018006b` `test: add weekly cycle component test harness`
- `7ef73eddf081cc0f558aa69e7e00af3a75f2fdbd` `fix: preserve weekly cycle refresh errors`

実装・検証済みの内容：

- 共通UI基盤と、分析結果から今週の改善行動へ進む主要導線
- 320px、375px、390px、768px、1024px、1440pxを対象としたレスポンシブ確認
- 週次改善項目の作成・更新成功後に履歴再読込が失敗した場合、成功通知で上書きしない部分成功表示
- errorは `role="alert"` / `aria-live="assertive"`、successは `role="status"` / `aria-live="polite"`
- pending中のdisabledと二重送信防止
- WeeklyImprovementCycle本体をjsdomへrenderし、fetch mockとユーザー操作を通す実行経路テスト

API、認証、DB、Migration、schema、利用上限、課金仕様、AI提案の「期待効果」仕様は、このUI改修では変更していません。

## 検証結果

アプリコード基準 `7ef73ed` のmain統合前後に再実行した確認結果です。`7ef73ed` 以後の `f6014a1` と `e036d34` はdocs-onlyのため、アプリコードと依存関係はこの検証済み内容から変わっていません。

- 自動テスト：185件成功、4件skip
- React act警告：0件
- ESLint：0エラー、既存の `<img>` 警告1件
- TypeScript：成功
- Production build：成功
- `npm audit`：critical / high / moderate / lowすべて0件
- npm 11.18.0のclean installと `npm ls --depth=0`：extraneous / invalid 0件
- `sharp`：0.35.3のみ
- `libvips`：package 1.3.2 / runtime 8.18.3
- `sharp` によるメモリ内SVG→PNG変換：成功
- `drizzle-kit check`：成功
- 週次改善release candidate時の重複作成関連実DB検証：4/4成功
- 同release candidate時の関連実DBテスト：48/48成功
- ActusTube管理対象のSchema drift：なし。`696d4b0` 以後のUI・依存・文書更新ではDB、Migration、schemaを変更していない
- `git diff --check`：成功
- 秘密情報・個人情報候補：0件
- UI幅320、375、390、768、1024、1440で横はみ出しなし

## Git状態

2026-07-23 02:10:39 JSTに読み取り確認した状態：

- `main`：`e036d34db3939a79073fcb05db9c27acda06d0e9`
- `origin/main`：`e036d34db3939a79073fcb05db9c27acda06d0e9`
- `main` と `origin/main`：0 / 0で同期済み
- 作業ツリー：clean
- `c6b403e`：週次改善サイクルのrelease candidate
- `2f79fa7`：Google OAuth callback互換性修正
- `509bf21`：Production認証障害に合わせた文書同期
- `c3e71ff`：安全な認証DB診断ログ
- `696d4b0`：Production DB接続復旧手順の文書化と復旧deploymentのsource
- `7ef73ed`：第1回UI改修と週次改善サイクル通知修正を含む直近のアプリコード基準
- `f6014a1`：正式仕様書v1.0を正本Markdownとして追加したdocs-only commit
- `e036d34`：Project Status / Production Runbookを同期したdocs-only commit

`7ef73ed` から `e036d34` の変更は、`AGENTS.md`、`docs/ACTUSTUBE_PRODUCT_SPEC.md`、`docs/ACTUSTUBE_PROJECT_STATUS.md`、`docs/PRODUCTION_RELEASE_RUNBOOK.md` の4件だけです。アプリコード、test、package、Migration、Drizzle schema、Vercel設定は変更されていません。正式仕様書v1.0はmain統合済みですが、将来設計を現在の実装済み機能として扱いません。旧状態の `main` `92f834d`、`fix/weekly-action-duplicate-conflict` 未統合、診断ログ未公開、DB資格情報の復旧待ち、`feat/ui-foundation-primary-flow` 未統合は完了済みの履歴です。

## Vercel Production状態

2026-07-23 02:10:39 JSTのProductionスナップショット：

- Production Branch：`main`
- Vercel Project：ActusTube
- commit：`e036d34db3939a79073fcb05db9c27acda06d0e9`
- deployment：`dpl_HgAsgkcPyJwkrSqgf5GCSHxqsfSn`
- domain：`https://actustube.vercel.app`
- 状態：READY / Current
- トップページ、主要CSS、主要JavaScript：HTTP 200
- source commit `e036d34` はProject Status / Production Runbook同期のdocs-only commitで、アプリコードは `7ef73ed` の内容から変わっていない
- `dpl_HgAsgkcPyJwkrSqgf5GCSHxqsfSn` の開始時刻は2026-07-23 01:38:17 JST
- docs-only統合・自動deploymentでは、DB、Migration、schema、データ、Vercel設定・環境変数、Neon、Google Cloudを変更していない
- このdeployment情報は確認時点のスナップショットであり、後続docs-only commitによって識別子が進んでも永続的にCurrentであることを意味しない

Production DB接続復旧に関する完了済み履歴：

- `redirect_uri_mismatch`：解消済み
- OAuth callbackの `missing iss`：解消済み
- callbackは `/api/auth/callback/google` まで到達し、HTTP 302で完了
- 安全な診断ログ：実装・検証・Production公開済み
- 本人による単一ログイン：成功。callback直後のトップページはHTTP 200
- 本人申告のログイン時刻周辺にGoogle callbackとHTTP 200を確認し、エラー、5xx、DB認証失敗は確認されなかった。Vercel側ログの表示時刻にはタイムゾーンまたは表示形式による差があるため、本人申告時刻との秒単位の一致は断定しない
- `[auth][error]`、`[auth][cause]`、`[auth][details]`：0件
- DB同期診断ログ：0件。失敗時だけ出力される実装のため正常結果と整合
- `password authentication failed`、Neon / PostgreSQL接続エラー、`error`、`fatal`、HTTP 5xx：0件
- 以前失敗していたGoogle OAuthアカウントのDB同期境界を正常に通過
- Production DB接続復旧：正式完了
- rollback：不要

直前のdocs-only deployment `dpl_6YzgHwYxG2w9XhwpGpZfJsjQ42sa`（`main@f6014a1`）と、直近のアプリコード公開deployment `dpl_37GSvgbM3Y23QAs9571UtAwzD42d`（`main@7ef73ed`）は比較用履歴として残します。Production DB接続復旧時の `dpl_Gk8TkDoUfG5dbpdn3HKpEc5k36aa`（`main@696d4b0`）、旧deployment `dpl_HPGCXavawHj3yHKo9nFg99LGB6jR`、`dpl_BFQqxdLJqaFS6vVcPVfZvfVkmFGQ` は監査履歴であり、現在のCurrentまたは自動的なrollback先ではありません。復旧ではVercel Productionの `DATABASE_URL` 以外を変更せず、Production DB本体やMigration 0000〜0005を変更・再適用していません。今回限定の環境変数変更例外は終了済みです。

## Production DB

ローカルの接続設定を秘密情報を表示せず解析し、明示的なread-only transactionでEndpoint IDとDatabaseを再確認しました。

実Production DB：

- Neon Project：ActusTube
- Project ID：`small-night-17748387`
- Branch name：`development`
- Branch ID：`br-blue-bonus-aza51iwc`
- Endpoint ID：`ep-polished-cloud-az8xdsqg`
- Database：`neondb`

重要：Neon上のブランチ名は `development` ですが、Vercel Productionが実際に接続しているためProduction DBとして扱います。削除、リセット、テスト用途への流用は禁止です。

2026-07-21のProduction DB状態：

- Migration履歴：6件
- 0000〜0005がjournalの順序どおり適用済み
- Migration 0005：適用済み。再適用は禁止
- journalの6つの `when` とDB履歴の `created_at`：すべて一致
- Drizzleと同じSHA-256計算で、0005は現在のファイルと一致
- 0000〜0004は現在のWindows作業ツリーのCRLFではhashが異なるが、LFへ正規化した同一SQL本文と一致。SQL内容変更ではなく改行コード差であり、Drizzleは最新の `created_at` とjournalの `when` により適用済みと判断する
- `analysis_runs`：作成済み、0件
- `improvement_actions`：作成済み、0件
- `improvement_action_status`：作成済み（`planned` / `completed` / `skipped`）
- Migration 0005のIndex・制約・関数：`schema.ts`、Migration SQL、0005 snapshotと一致
- 2つの確定関数：`SECURITY INVOKER`、固定 `search_path`、PUBLIC実行権限なし
- `users`：1件
- `oauth_accounts`：1件
- `plans`：1件
- `user_plan_assignments`：1件
- `user_usage_buckets`：0件
- `usage_reservation_leases`：0件

実データの内容、ユーザー情報、認証情報、接続情報の秘密部分は記載しません。

管理外テーブル `playing_with_neon` が1つ存在し、40件の行があります。コード、`schema.ts`、Migration、テストから参照されておらず、ActusTube管理オブジェクトとの名前衝突もありません。Neonのサンプルテーブルとしてアプリ管理Schemaの比較対象から除外し、削除・変更・Migrationへの追加は行いません。ActusTube管理対象のSchema driftはありません。

## バックアップ兼リハーサルブランチ

- Name：`pre-weekly-mvp-production-backup-20260720`
- Branch ID：`br-crimson-shadow-azkeq0kc`
- Endpoint ID：`ep-still-bar-azv826h8`
- Parent：`br-blue-bonus-aza51iwc`
- Database：`neondb`
- 状態：Ready
- 削除せず保持中

この既存ブランチはMigrationリハーサルに使用済みです。

週次改善サイクルProduction公開前には、当時のProduction DBを基点に次のバックアップを作成し、Readyを確認済みです。

- Name：`backup-pre-release-20260721-c6b403e`
- Branch ID：`br-withered-darkness-azjg6fpl`
- 状態：Ready

今回の認証診断ログ追加ではDB・Migrationを変更しないため、新たなNeon branch作成やMigration実行は行いません。

このブランチでは、引き継ぎ時点で次が合格済みと報告されています。

- 親ブランチとのMigration履歴・データ件数一致
- Migration 0005適用
- 履歴5件から6件
- 新テーブル・enum・Index・外部キー・関数作成
- `SECURITY INVOKER`
- 固定 `search_path`
- PUBLIC実行権限なし
- Googleログイン
- YouTube分析
- 分析履歴保存
- AI提案保存
- 改善項目作成・編集
- `completed` / `skipped`
- 結果メモ
- 重複作成409
- API 500なし
- 既存データ維持
- テストデータ削除

## 現在残っている作業

1. Runbook整合化後の新しいrelease candidateを基準に、対象branch、完全SHA、Migration 0006、承認範囲を固定した別のproject owner明示承認を受け、Production release手順を最初から再開する
2. Production releaseが全gateに合格した場合だけ、所有者による認証済みProduction主要機能スモークを、費用と利用枠を考慮して最小回数で実施する
3. 料金・利用上限・原価率、利用規約・プライバシー・Google / YouTubeポリシー適合を確定する
4. 正式仕様書で未実装または未確認とされた「期待効果」専用field、YouTube Analytics、決済、Standard / Pro等を、設計と実装を混同せず個別工程で扱う

Production DB接続復旧と第1回UI改修は完了しています。通常のVercel環境変数変更禁止が適用されており、今回の文書同期ではProduction、アプリコード、DB、Migration、schema、認証、API契約、利用上限、AI処理を変更しません。

## 今回の公開対象外

- YouTube Analytics API
- 自動成果比較
- Stripe
- メール・プッシュ等の外部通知機能
- Proの全動画処理
- トレンド分析
- 収益予測
- UI全面リニューアル

## 次の作業

次工程は、承認済み期限付き例外を含むrelease candidate確定後、Production release手順を独立作成・監査し、main統合とProduction releaseの可否を別途判定することです。Productionスモークは現時点では未実施です。

この文書同期branchの作成・commit・pushはProduction操作と分離します。レビュー完了までは `main` へ統合・pushせず、Production deploy、Vercel設定・環境変数、Production DB、Migration、Neon、Google Cloudを変更しません。文書上の識別子と後続の実状態がdocs-only commit / deployment分だけ異なる場合は、AGENTS / Runbookの全条件を読み取り専用で確認できた場合に限り、限定例外を適用できます。
