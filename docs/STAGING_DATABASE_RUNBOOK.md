# ActusTube Staging Database Postflight Runbook

最終更新日：2026-07-29

## 目的と適用範囲

このRunbookは、別工程で作成・本人確認・Migration適用を終えたActusTube専用staging databaseを、repository管理の読み取り専用commandでpostflight確認する手順です。Production、rehearsal、backup、default branch、接続先を分類できないdatabaseには使用しません。

現在、実staging resourceは未作成です。このRunbookの追加は、staging DBの作成、Migration適用、接続、Vercel設定、Neon設定、Google Cloud / OAuth設定を許可または実施したことを意味しません。

## 正式commandと実装path

- package command：`npm run db:verify:staging`
- entry script：`scripts/verify-staging-database-postflight.mjs`
- shared validation：`scripts/staging-database-postflight/`
- local integration harness：`npm run test:db-postflight:local`
- Migration command：`npm run db:migrate`

`db:verify:staging`と`db:migrate`は別commandです。postflight commandはMigrationを呼び出さず、DDL、DML、reservation、release、finalize、stale recovery、cleanup functionも実行しません。

## 必須Environment Variable名

postflightには次の名前が必要です。値はterminal出力、文書、Git、issue、chat、clipboard履歴、command引数へ記録しません。

- `ACTUSTUBE_DB_ENV`
- `ACTUSTUBE_ALLOW_STAGING_DB_VERIFY`
- `DIRECT_DATABASE_URL`
- `DATABASE_URL`
- `ACTUSTUBE_EXPECTED_STAGING_IDENTITY`

要求される固定値は`ACTUSTUBE_DB_ENV=staging`と`ACTUSTUBE_ALLOW_STAGING_DB_VERIFY=1`です。ただし、この2値は接続先がstagingである証明にはなりません。

`ACTUSTUBE_EXPECTED_STAGING_IDENTITY`には、接続文字列から算出したhashではなく、provider UIで本人が別経路から確認したstaging endpointのexact identityを設定します。direct / pooled URLのprovider endpoint markerと内部で完全一致させ、値はsecretとして扱います。欠落、形式不正、照合不能ならDB接続前にexit code 3または2で停止します。値、fingerprint、endpoint identityは出力・報告しません。

## secret入力規則

1. provider UIで、対象が新規のstaging resourceであり、Production、rehearsal、backup、default branchではないことを本人がmetadataだけで確認します。
2. 別途明示承認されたstaging構築工程が、direct接続とpooled runtime接続を一意に取得します。
3. 接続値とexpected identityは、他の作業と共有しない専用terminal processのEnvironment Variablesへ、echoしない方法で渡します。
4. connection stringをcommand引数へ書きません。
5. `.env`、`.env.local`、PowerShell profile、script、report、Git管理fileへ保存しません。
6. Production用の既存Environment Variablesを流用しません。
7. 実行後は本人が呼出し元processからstaging用Environment Variablesを削除し、不要ならterminalを閉じます。

postflight scriptは子processです。親shellのEnvironment Variablesを削除できず、削除したとも報告しません。

## staging Web deployment専用の検索index防止

認証済みstaging Web deploymentでは、staging専用Vercel projectのProduction scopeだけに、server / build側Environment Variable `ACTUSTUBE_STAGING_NOINDEX=1`を設定します。この変数はsecretではありませんが、Production ActusTube projectや他のenvironment scopeへ設定しません。DB postflight processには不要で、`DIRECT_DATABASE_URL`等の接続情報とも共有しません。

値が文字列`1`と完全一致するbuildだけで、Next.js設定が全pathへ次のHTTP headerを追加します。

```text
X-Robots-Tag: noindex, nofollow, noarchive, nosnippet
```

未定義、空文字、`0`、`false`、その他の値ではheader設定を返しません。このdefault-off動作により、Environment Variableを設定しない現在のProductionの検索index挙動と既存metadataを変更しません。`NEXT_PUBLIC_`変数、robots metadata、robots.txtは使用しません。

staging deployment前にexact `1`とscopeをmetadataだけで確認し、deployment後は固定staging URLのrootと正式8routeのresponse headerを確認します。1routeでもheaderが欠落する場合、Production側へ変数を追加して補わず、追加deploymentを行わず停止します。

## 安全ゲート

database接続adapterを呼び出す前に、次をすべて検証します。

- environment名が大小文字・空白を含めずexact `staging`
- confirmationがexact `1`
- direct / pooledの両URLが存在し、PostgreSQL形式として解析可能
- direct endpointとpooled endpointの役割が一致
- direct / pooledから導出した非表示のtarget identityが一致
- operatorがprovider UIで別経路から確認したexpected endpoint identityと一致
- host、database、またはrole metadataに境界付き`staging` markerがあり、role名を含む全target metadataにProduction等の禁止語がない
- Production、prod、rehearsal、backup、default、main、template database等の明示的な禁止targetではない
- loopbackは正式commandでは拒否し、programmatic local harnessだけが明示的に許可

URLに`staging`という文字があること、database名、schema、Migration履歴が同じことだけではPASSにしません。接続後は、direct / pooled双方のdatabase OID、catalog identity、Migration fingerprint、管理対象schema fingerprint、object signature fingerprintを内部で完全比較します。実値は出力しません。同一論理databaseを証明できなければexit code 3です。

## 読み取り専用保証

direct / pooledはそれぞれ、bounded connection timeoutの後に`REPEATABLE READ READ ONLY` transactionを開始します。transactionのread-only状態を確認し、statement timeoutとlock timeoutをtransaction内だけに設定します。

repository管理の固定queryだけを許可し、次の処理を拒否します。

- `INSERT`、`UPDATE`、`DELETE`、`MERGE`
- `CREATE`、`ALTER`、`DROP`、`TRUNCATE`
- `GRANT`、`REVOKE`、`COMMENT`
- `VACUUM`、`ANALYZE`、`COPY FROM`
- `CALL`、`DO`、materialized view refresh
- Migration適用
- reservation / release / finalize / stale recovery / cleanup
- 任意SQLのCLI入力

成功・失敗のどちらでも`ROLLBACK`とconnection closeを行います。rollbackまたはcleanupを確認できない場合はexit code 3です。

## 検証内容

### Migration

- repository journalが0000〜0006のexact 7件、連続index、正式順序
- SQL fileがexact 7件で、欠落・追加なし
- Drizzleと同じUTF-8 file contentのSHA-256計算
- `drizzle.__drizzle_migrations`のschema、primary key、exact 7行
- journal timestamp / order / hashの完全一致
- pending、duplicate、unknownが0

hash、timestamp、内部IDは出力しません。

### schema / object

`drizzle/meta/0006_snapshot.json`、Migration SQL、既存testを正本として次を確認します。

- 管理対象schema、table、column、type、nullability、default
- primary key、foreign key、unique / check constraint
- index、unique index、partial predicate
- enum、sequence、sequence ownership
- function名だけでなくfull identity arguments、return type / table shape、volatility、strictness、parallel safety
- duplicate overloadと旧signatureが存在しないこと
- function dependencyとなるtable / type / constraintが揃うこと

journalやSQL fileが増減した場合はfailするため、将来Migrationではmanifestとtestを明示的に更新します。

### owner / ACL / security

- migration roleが対象databaseと管理objectのowner
- `public` schema ownerがdatabase owner方針と一致
- runtime roleはownerではなく、superuser / CREATEDB / CREATEROLE / replication / BYPASSRLSではない
- runtime roleのschema USAGE、必要なtable DML、function EXECUTEだけが存在
- runtime roleにschema / database CREATE、TRUNCATE、REFERENCES、TRIGGER、不要sequence privilegeがない
- table / function / schema / sequence / typeのruntime grant option、column-level ACL、sequence SELECT、default ACLの想定外granteeがない
- table / functionへPUBLIC権限がない
- function ACLがNULLの場合も`acldefault` / `aclexplode`でimplicit PUBLIC EXECUTEを検出
- default privilegeにPUBLIC権限がない
- 全管理functionがSECURITY INVOKER、fixed `search_path=public, pg_temp`
- runtime connectionのsearch pathがexact `public, pg_temp`で、`$user`や先行する書込み可能schemaがない
- RLSはsnapshotどおり無効、policyは0件
- `public`管理schemaのtable、function、enum、sequenceはallowlistと完全一致し、未知objectがない

role名、owner名、grantee名は出力しません。

### pooled runtime read-only smoke

`crypto.randomUUID()`で生成した合成UUIDだけを使用します。users、analysis history、improvement item、reservation leaseのいずれにも存在しないことを件数だけで確認し、collision時は最大3回まで別UUIDを生成します。

固定されたparameterized SELECTで、usage-status相当の関係table、weekly-cycle相当のhistory / improvement tableを件数だけ確認します。書込み可能なDB functionは呼びません。実ユーザーID、record、free-text column、channel / video情報は取得しません。

実行前後に、table件数、usage counter合計、lease件数、history件数、improvement item件数が不変であることを確認します。

## 正式実行順序

次は工程の順序であり、現在の包括許可ではありません。各provider操作とMigrationには、その時点のproject ownerによる別の明示承認が必要です。

1. Gitのbranch、HEAD、upstream、worktreeを確認する。
2. 本人がprovider UIでstaging resourceのproject / branch / endpoint / databaseをmetadataだけで一意に確認する。
3. Production、rehearsal、backup、defaultから完全に分離されていることを確認する。
4. direct migration roleとpooled runtime roleのowner / ACL設計を事前監査する。
5. 明示承認済みの別工程で`npm run db:migrate`をexact 1回実行する。
6. Migration commandが終了してから、同じ承認済みtargetに対し`npm run db:verify:staging`を1回実行する。
7. JSONとhuman summaryの両方を確認する。
8. 全必須項目PASSかつexit code 0の場合だけ、次のauthenticated staging test工程へ進める。
9. 1件でもFAIL / NOT VERIFIED / skipped / timeout / cleanup不明があれば続行せず停止する。
10. 親shellからstaging用Environment Variablesを削除し、不要ならterminalを閉じる。

## 出力とexit code

出力は機械可読JSONと人間向けsummaryです。出力可能なのは固定check ID、status、件数、exit codeだけです。URL、host、database、user、role、owner、branch / endpoint / project ID、query parameter、raw hash、hash prefix、raw driver error、stack、cause、実データを出力しません。

- `0`：全必須検証PASS
- `1`：検証できた不一致 / FAIL
- `2`：設定不足、安全ゲート不合格、Production等の禁止target疑い
- `3`：接続状態不明、同一性NOT VERIFIED、timeout、catalog権限不足、rollback / cleanup不明

directだけ、pooledだけ、partial PASS、check skippedは成功ではありません。

## local harnessの証明範囲

`npm run test:db-postflight:local`は外部DB関連Environment Variablesを子processへ渡さず、loopbackだけにbindした使い捨てPostgreSQLを起動します。Migration 0000〜0006、別owner / runtime role、正常系、別DB不一致、schema drift、未知table / function / enum、PUBLIC EXECUTE、grant option、column ACL、sequence SELECT、default ACL想定外grantee、function default式drift、Migration hash不一致、read-only SQL instrumentation、stdout / stderr redaction、timeout cleanupを確認し、process、port、data directoryを削除します。

- local separate-role connection：検証対象
- real transaction pooler behavior：実staging DB未作成のためNOT TESTED
- 実staging owner / ACL：実staging DB未作成のためNOT TESTED

local harnessのPASSを、実provider poolerや実staging DBのPASSとして扱いません。

## 成功・停止・cleanup

staging構築を続行できるのは、provider UI上の本人確認、Migration工程の成功、postflight exit code 0、秘密情報露出0、cleanup確認のすべてが揃った場合だけです。

staging resourceを将来削除する場合は、対象、影響、backup要否、Environment Variables、OAuth callback、provider resourceの順序を固定した別承認で行います。postflightはresource、schema、data、role、Environment Variablesを作成・変更・削除しません。失敗時も自動cleanupやprovider resource削除を行いません。
