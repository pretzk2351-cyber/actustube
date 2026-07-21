# ActusTube Project Status

最終更新日：2026-07-21

> 2026-07-21にGit、Vercel、Neon Production DBを読み取り専用で再確認しました。Production DBへの書き込み、Migration、Vercel操作、Productionデプロイは行っていません。次工程でもRunbookの停止条件に従って実状態を再確認してください。

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

この修正コミットは `fix/weekly-action-duplicate-conflict` に存在し、`main` へは未統合です。

修正内容：

- `DrizzleQueryError` の `cause` 内にある `NeonDbError` を探索
- PostgreSQLエラーコード `23505` とconstraint名を認識
- `improvement_actions_analysis_run_unique` の違反だけを409へ変換
- APIコード `IMPROVEMENT_ACTION_ALREADY_EXISTS` を返却
- `planned` 制約に対する既存の409を維持
- `completed` / `skipped` 後も、同じ分析に作成フォームを再表示しない
- 409発生時は履歴を再取得
- 想定外のDBエラーは内部情報を出さない安全な500に変換

## 検証結果

release candidate作成時に再実行した確認結果です。

- 通常テスト：153件成功
- 実DB専用4件は通常実行時skip
- 重複作成関連実DB検証：4/4成功
- 関連実DBテスト：48/48成功
- ESLint：0エラー、既存の `<img>` 警告1件
- TypeScript：成功
- Production build：成功
- `npm audit`：脆弱性0件。間接dev依存の `brace-expansion` を1.1.14から修正版1.1.16へlockfile内で更新
- `drizzle-kit check`：成功
- Schema drift：なし
- `git diff --check`：成功
- 秘密情報混入：なし
- UI幅320、375、390、768、1024、1440で横はみ出しなし

## Git状態

release candidate作成前の読み取り確認結果：

- 現在ブランチ：`fix/weekly-action-duplicate-conflict`
- HEAD：`d02071f9cada7d5ebc858c541bf6e3d3bb73568e`
- upstream：`origin/fix/weekly-action-duplicate-conflict`
- fixブランチとupstream：0 / 0で同期済み
- 作業ツリー：release candidate作成前はclean
- `main`：`92f834ddc77d5a8134904dce4ccbb38eced8ac14`
- `origin/main`：`92f834ddc77d5a8134904dce4ccbb38eced8ac14`
- `main` と `origin/main`：0 / 0で同期済み

コード修正コミット `35b9615` と引き継ぎ文書コミット `d02071f` は `fix/weekly-action-duplicate-conflict` に含まれています。`main` へのmergeは未実施です。release candidateの最終commit SHA、upstreamとの同期状態、作業ツリーの状態はGit履歴と `git status` で確認してください。

## Vercel Production状態

2026-07-21の読み取り専用確認結果：

- Production Branch：`main`
- 現在Productionで稼働中の安定コミット：`5964c2d749d14eff04ea356be14166fa7eb5f4dc`
- `92f834d` のProductionはDB未準備のためInstant Rollback済み
- 現在のProduction状態：READY
- HTTP 200確認済み
- 直近確認で不要な404・500なし
- GitHub `main` 自体は `92f834d` のまま
- Vercel Productionだけ旧安定デプロイへ戻している

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

この既存ブランチはMigrationリハーサルに使用済みです。0005適用済みとなった現在のProduction DBを基点にした新規バックアップは、まだ作成していません。

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

1. 現在のProduction DBを基点に新規バックアップを作成し、Readyを確認
2. Migration 0005を再適用せず、適用済みDBオブジェクトと既存データ維持を再確認
3. `fix/weekly-action-duplicate-conflict` を `main` へ統合
4. `main` 上で全自動検証
5. `origin/main` へpush
6. Vercel自動Productionデプロイ確認
7. Productionスモークテスト
8. Productionログ・Console・Network確認
9. 安定確認後にバックアップブランチの扱いを判断
10. ProductionとdevelopmentのNeonブランチ構成を後日整理

## 今回の公開対象外

- YouTube Analytics API
- 自動成果比較
- Stripe
- 通知
- Proの全動画処理
- トレンド分析
- 収益予測
- UI全面リニューアル

## 次の作業

次に実施する工程は、現在のProduction DBを基点にした新規バックアップの作成と、適用済みMigration 0005の読み取り確認です。Migration 0005は再適用しません。

バックアップ・DB確認と `main` 統合・push・デプロイは段階を分けます。開始前に [Production Release Runbook](./PRODUCTION_RELEASE_RUNBOOK.md) を読み、記載内容とGit・Vercel・Neonの実状態が一致しない場合は停止してください。
