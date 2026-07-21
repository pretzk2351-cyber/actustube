# ActusTube Production Release Runbook

## 目的

週次改善サイクルMVPを安全にProductionへ公開します。各Phaseを分離し、停止条件に1つでも該当した場合は独断で続行せず、その場で停止して報告します。

## 現在の前提

以下は引き継ぎ時に提示された直近確認情報です。実行時には必ず読み取り専用で再確認してください。

- Vercel Productionは旧安定版 `5964c2d749d14eff04ea356be14166fa7eb5f4dc`
- GitHub `main` は `92f834ddc77d5a8134904dce4ccbb38eced8ac14`
- 修正ブランチ `fix/weekly-action-duplicate-conflict` は `35b9615ce474194277e35921b628744f8dc640e5`
- Production DBは `br-blue-bonus-aza51iwc`
- Production DBのEndpoint IDは `ep-polished-cloud-az8xdsqg`
- Migration 0005はProduction本体へ未適用
- バックアップブランチでMigrationリハーサル合格済み
- バックアップブランチ `br-crimson-shadow-azkeq0kc` は削除せず保持中

## 正しい実行順序

### Phase 1：Production DB Migration

1. Gitの現在ブランチ、HEAD、upstream、作業ツリーを読み取り確認する。
2. `main` と `origin/main`、fixブランチとそのupstreamがそれぞれ0 / 0で同期していることを確認する。
3. Vercel Productionが `5964c2d` を参照し、READYであることを確認する。
4. ProductionトップページがHTTP 200であることを確認する。
5. Vercel ProductionのDB接続先Endpointが `ep-polished-cloud-az8xdsqg` であることを、秘密情報を表示せず確認する。
6. Production DBのMigration履歴が5件で、0000〜0004が適用済み、0005が未適用であることを確認する。
7. `analysis_runs`、`improvement_actions`、`improvement_action_status` が未作成であることを確認する。
8. 既存データ件数を記録する。
9. バックアップブランチ `br-crimson-shadow-azkeq0kc` がReadyで保持されていることを確認する。
10. 接続先をもう一度確認し、リハーサル合格時から変更されていない `drizzle/0005_silky_mystique.sql` だけをDrizzleの正規Migration手順で適用する。0000〜0004は再適用しない。
11. Migration履歴が6件となり、0005が1回だけ記録されたことを確認する。
12. 新テーブル、enum、Index、外部キー、関数、セキュリティ属性を読み取り確認する。
13. 既存データ件数が変わっていないこと、`analysis_runs` と `improvement_actions` が0件であることを確認する。
14. Schema driftがないことを確認する。
15. 旧ProductionがHTTP 200で、新しい404・500やログ異常がないことを確認する。
16. Git、Vercel環境変数、Productionデプロイが変化していないことを確認する。
17. ここで停止し、Phase 1の結果を報告する。

Phase 1で確認するMigration 0005の主要オブジェクト：

- テーブル：`analysis_runs`、`improvement_actions`
- enum：`improvement_action_status`（`planned`、`completed`、`skipped`）
- Index：`analysis_runs_id_user_unique`、`analysis_runs_user_analyzed_idx`、`improvement_actions_analysis_run_unique`、`improvement_actions_one_planned_per_user`、`improvement_actions_user_updated_idx`
- 外部キー：`analysis_runs_user_id_users_id_fk`、`improvement_actions_user_id_users_id_fk`、`improvement_actions_owned_analysis_fk`
- 関数：`finalize_channel_analysis_reservation`、`finalize_ai_consult_reservation`
- 関数属性：両方とも `SECURITY INVOKER`、`search_path = public, pg_temp`、PUBLIC実行権限なし

### Phase 2：fixブランチのmain統合

1. Phase 1が全項目合格していることを確認する。
2. fixブランチとupstreamの同期を確認する。
3. `main` と `origin/main` の同期を確認する。
4. 差分と競合の有無を確認する。
5. ユーザーの明示指示を得てから `fix/weekly-action-duplicate-conflict` を `main` へ統合する。
6. `main` 上で自動テスト、ESLint、TypeScript型検査、Production build、`npm audit`、`drizzle-kit check`、Schema drift、`git diff --check`、秘密情報混入を確認する。
7. 全検証合格時かつユーザーの明示指示がある場合だけ `origin/main` へpushする。
8. Vercelの自動Productionデプロイ開始を確認する。

### Phase 3：Productionデプロイ確認

1. 対象コミットが `35b9615` を含むことを確認する。
2. Vercel ProductionがREADYになるまで確認する。
3. Productionドメインが新デプロイを参照することを確認する。
4. Build・Runtimeエラーを確認する。
5. 500ログを確認する。
6. 異常があれば旧安定版 `5964c2d` へInstant Rollbackする。

### Phase 4：Productionスモークテスト

Productionへダミーや検証専用のデータを作成してはいけません。データ保存を伴う確認は、ユーザーが明示的に承認した実利用データで行う場合に限ります。それ以外はバックアップまたは一時DBでの合格結果を利用し、Productionでは非破壊の確認だけを行います。

最低限、次を確認します。

- トップページ
- Googleログイン
- YouTubeチャンネル取得
- チャンネル分析
- `analysis_runs` 保存
- AI提案保存
- 改善項目作成
- 改善項目編集
- `completed`
- `skipped`
- 結果メモ
- 再読み込み後の保持
- `planned` 2件目防止
- 同一分析への重複作成が409
- API 500なし
- 未認証401
- 利用枠二重消費なし
- 320px、375px、390px、1024px、1440px
- Consoleエラーなし
- 不要な404・500なし
- 重複API通信なし

Productionでは検証専用データの作成や、その後片付けを前提とした削除を行いません。意図しないデータが作成された場合は独断で削除せず、その場で停止して対象と影響を報告してください。

## Phase 1停止条件

以下の場合はMigrationを実行しないか、進行中なら直ちに停止します。

- Endpoint ID不一致
- Migration履歴が5件ではない
- 0005が既に適用済み
- 既存データ件数が想定と不一致
- バックアップブランチが存在しない、またはReadyではない
- Migrationファイルにリハーサル後の変更がある
- Migration適用エラー
- 適用後の履歴が6件にならない
- 必要なテーブル、enum、Index、外部キー、関数、セキュリティ属性が不足
- 既存データ件数が変化
- Schema drift
- Production HTTPエラー
- Productionに新しい500
- Production環境変数またはデプロイの変化
- 意図しないGit差分

エラー後に独自判断でSQLを編集・再実行しないでください。Migrationファイルも編集しないでください。

## Phase 2停止条件

- `main` またはfixブランチが想定コミットと異なる
- upstreamと未同期
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

## ロールバック

新コード公開後に異常が発生した場合：

1. 新しい `main` commitを即座にrevertしない。
2. まずVercel Productionを既存安定デプロイ `5964c2d` へInstant Rollbackする。
3. Production HTTPとログを確認する。
4. Migration 0005は追加型のため、独断でDBを巻き戻さない。
5. バックアップブランチを維持する。
6. 原因を調査し、ユーザーと対応を決定する。

## 絶対禁止

- `DATABASE_URL` 全体の表示
- PostgreSQL接続文字列の表示
- パスワード、APIキー、OAuthトークン、Cookie、セッション値の表示
- Production DBの削除・リセット
- Productionへの未検証SQLの直接実行
- 0000〜0004の再適用
- Migrationの場当たり的な編集
- force push
- バックアップブランチの早期削除
- DB準備前の `main` push
- 問題発生時の独断による連続操作

## 完了条件

以下がすべて合格した時に公開完了とします。

- Production Migration履歴6件
- 必要DBオブジェクトとセキュリティ属性が存在
- 既存データ維持
- 最新修正コードがProductionで稼働
- Productionスモークテスト合格
- API 500なし
- Console・Network異常なし
- 利用枠不整合なし
- Git `main` と `origin/main` が同期
- 作業ツリーclean
