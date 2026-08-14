# ActusTube Staging Database Preflight / Postflight Runbook

最終更新日：2026-08-14

## 目的と適用範囲

このRunbookは、別工程で作成・本人確認したActusTube専用staging databaseについて、Migration前の空状態をpreflightで確認し、Migration適用後の状態をpostflightで確認する手順です。Production、rehearsal、backup、default branch、接続先を分類できないdatabaseには使用しません。

文書上はstaging専用provider resourceが別の承認済み工程で作成済みですが、今回のlocal product recoveryではprovider状態を再確認していません。staging DBへのpreflight、Migration、postflightは未実行のままです。このRunbookの更新は、DB接続、Migration適用、Vercel deployment、Neon設定変更、Google Cloud / OAuth操作を新たに許可または実施するものではありません。

## 正式commandと実装path

- preflight package command：`npm run db:preflight:staging`
- preflight entry script：`scripts/verify-staging-database-preflight.mjs`
- preflight validation：`scripts/staging-database-preflight/`
- postflight package command：`npm run db:verify:staging`
- postflight entry script：`scripts/verify-staging-database-postflight.mjs`
- shared safety / postflight validation：`scripts/staging-database-postflight/`
- disposable external fixture workflow：`.github/workflows/staging-database-preflight.yml`
- connection-only verifier：`scripts/test-staging-database-preflight-postgres.mjs`
- P3 benign child fault oracle：`scripts/test-staging-database-fault-lifecycle.mjs`
- Migration command：`npm run db:migrate`

`db:preflight:staging`、`db:migrate`、`db:verify:staging`はすべて別commandです。preflightとpostflightは互いを呼び出さず、Migration commandも呼び出しません。どちらの検証commandもDDL、DML、reservation、release、finalize、stale recovery、cleanup functionを実行しません。

## 必須Environment Variable名

preflightとpostflightには次の共通名が必要です。値はterminal出力、文書、Git、issue、chat、clipboard履歴、command引数へ記録しません。

- `ACTUSTUBE_DB_ENV`
- `DIRECT_DATABASE_URL`
- `DATABASE_URL`
- `ACTUSTUBE_EXPECTED_STAGING_IDENTITY`

preflightではさらに、本人がprovider metadataから確認したextension inventoryを`ACTUSTUBE_EXPECTED_STAGING_EXTENSIONS`へ非表示のprocess-local入力として設定します。値はschemaVersion 1の固定JSON contractであり、command line、file、reportへ記録しません。

preflight専用の許可名は`ACTUSTUBE_ALLOW_STAGING_DB_PREFLIGHT`、postflight専用の許可名は`ACTUSTUBE_ALLOW_STAGING_DB_VERIFY`です。

- preflight：`ACTUSTUBE_DB_ENV=staging`かつ`ACTUSTUBE_ALLOW_STAGING_DB_PREFLIGHT=1`
- postflight：`ACTUSTUBE_DB_ENV=staging`かつ`ACTUSTUBE_ALLOW_STAGING_DB_VERIFY=1`

各commandは他方の許可名を代用しません。これらの固定値は接続先がstagingである証明にはなりません。

`ACTUSTUBE_EXPECTED_STAGING_IDENTITY`には、接続文字列から算出したhashではなく、provider UIで本人が別経路から確認したstaging endpointのexact identityを設定します。direct / pooled URLのprovider endpoint markerと内部で完全一致させ、値はsecretとして扱います。欠落、形式不正、照合不能ならDB接続前にexit code 3または2で停止します。値、fingerprint、endpoint identityは出力・報告しません。

## secret入力規則

1. provider UIで、対象が新規のstaging resourceであり、Production、rehearsal、backup、default branchではないことを本人がmetadataだけで確認します。
2. 別途明示承認されたstaging構築工程が、direct接続とpooled runtime接続を一意に取得します。
3. 接続値、expected identity、preflight用expected extension inventoryは、他の作業と共有しない専用terminal processのEnvironment Variablesへ、echoしない方法で渡します。
4. connection stringをcommand引数へ書きません。
5. `.env`、`.env.local`、PowerShell profile、script、report、Git管理fileへ保存しません。
6. Production用の既存Environment Variablesを流用しません。
7. 実行後は本人が呼出し元processからstaging用Environment Variablesを削除し、不要ならterminalを閉じます。

preflight / postflight scriptは子processです。親shellのEnvironment Variablesを削除できず、削除したとも報告しません。

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
- 実行commandに対応するpreflightまたはpostflight confirmationがexact `1`
- direct / pooledの両URLが存在し、PostgreSQL形式として解析可能
- URL queryはdecode後のpositive allowlistで検査し、`sslmode=require`と`channel_binding=require`だけを許可。未知、重複、空key / value、大小文字やpercent encodingで表記を変えたrouting key、host / port / database / user / password / service / local-file / libpq optionsを変更するparameterは拒否
- database名とusername / roleはASCII英数字、`_`、`.`、`-`だけの非曖昧な文法へ限定し、percent escape、encoded separator、encoded query / fragment delimiter、NUL、double encoding、malformed escapeを接続前に拒否。接続せず生成したNeon clientの実効hostname、正規化port、database、usernameをsafety layerの認識値とdirect / pooledごとに完全照合する
- direct endpointとpooled endpointの役割が一致
- direct / pooledから導出した非表示のtarget identityが一致
- operatorがprovider UIで別経路から確認したexpected endpoint identityと一致
- host、database、またはrole metadataに境界付き`staging` markerがあり、role名を含む全target metadataにProduction等の禁止語がない。接続後は固定queryの`current_user`が各URLのdecode済みroleと完全一致する
- Production、prod、rehearsal、backup、default、main、template database等の明示的な禁止targetではない
- loopbackは正式commandでは拒否し、GitHub Actions disposable fixtureのconnection-only verifierだけがprogrammaticに明示許可

URLに`staging`という文字があること、database名、schema、Migration履歴が同じことだけではPASSにしません。staging marker判定は別の`decodeURIComponent`結果ではなくNeon driverが実際に使うdatabase / host / role authorityへ適用し、`app%2Fstaging`をstaging targetとして認定しません。許可されたquery parameterはrouting authorityを変更しない固定値だけです。接続後は、direct / pooled双方のdatabase OID、catalog identity、実database role、Migration fingerprint、管理対象schema fingerprint、object signature fingerprintを内部で完全比較します。実値は出力しません。同一論理databaseまたは期待roleを証明できなければexit code 1または3です。

preflightが正式対応するdatabase engineはPostgreSQL major 18だけです。固定read-only queryで`server_version_num`を最初に取得し、direct / pooled初回、再取得、before / afterのすべてでmajor 18かつ同一versionであることを確認します。version取得不能はexit code 3、major 18以外または検証済みversion不一致はexit code 1でMigrationを禁止します。reportは実version文字列を出さず、固定`supported` / `not_verified` statusだけを保持します。

## Migration前read-only preflight

provider metadata preflightと本人によるprocess-local非表示入力が完了した後、Migrationより先に次を最大1回だけ実行します。

```powershell
$env:ACTUSTUBE_DB_ENV = 'staging'
$env:ACTUSTUBE_ALLOW_STAGING_DB_PREFLIGHT = '1'
corepack npm run db:preflight:staging
```

`DIRECT_DATABASE_URL`、`DATABASE_URL`、`ACTUSTUBE_EXPECTED_STAGING_IDENTITY`、`ACTUSTUBE_EXPECTED_STAGING_EXTENSIONS`は、このcommandより前に本人が非表示でprocess-local入力します。値をcommand引数、file、clipboard履歴、出力へ含めません。

preflightが正式な空状態として認めるのは次のどちらかだけです。

1. `drizzle` schemaと`drizzle.__drizzle_migrations`がともに存在せず、user-defined residual objectが存在しないpristine状態
2. Drizzle PostgreSQL migration runnerがMigration transactionより前に作成し得る、正式形状の`drizzle.__drizzle_migrations` table、primary key、serial sequenceだけが存在し、履歴行が0件で、その他のuser-defined residual objectが存在しない空migration-table状態

既知のActusTube名だけでなく、非system schema内のrelation、view、materialized view、foreign table、sequence、index、routine、type、trigger、rule、policy、constraint、schema-local objectと、database-levelのuser-created catalog objectを固定read-only queryで列挙します。`pg_catalog`、`information_schema`、`pg_toast`、`pg_temp`、`pg_toast_temp`系はsystem schemaとして除外します。extension evidenceはcandidate signature単位に集約し、各evidenceを`managed support`、`residual support`、`neutral evidence`のexact 1種類へ分類します。`managed support`は`pg_depend.deptype='e'`と`pg_extension`によるdirect membership、direct memberのview / materialized viewへ`deptype='i'`で従属する正式`_RETURN` rule、direct memberのforeign-key constraintへ`deptype='i'`で従属し`tgconstraint`が一致するenforcement triggerだけです。candidate存在markerと通常の構造参照`deptype='n'`は、それだけでmanagedにもresidualにもできない`neutral evidence`です。genericなautomatic dependency (`deptype='a'`)、許可条件を満たさないinternal dependency、後付けconstraint / index / trigger等は`residual support`であり、別のmanaged supportがあっても無視しません。managed support＋residual support、neutral-only、evidenceなし、未知field、分類不能はexit code 3です。`pg_extension.extnamespace`一致だけではuser-created host schemaを許可せず、provider / extension風のschema名、prefix、owner名だけでも除外しません。

Production SQLは全candidate signature、一意なevidence signatureを持つraw dependency / candidate / residual-catalog evidence、managed signature、residual signatureを同時に返し、Production判定経路で使う同じclassifierがcandidateごとにexact 1分類を再計算します。candidate／evidence集合、computed／SQL managed集合、computed／SQL residual集合をすべて双方向照合し、candidate総数＝managed＋residual、両集合の交差0件、candidate・evidence signatureの重複0件、全candidateへのevidence、全evidenceのcandidate対応、residual signatureと`residual_objects`由来の`object_signature`・集計件数の一致を要求します。hidden residual、managedをresidualへも含める状態、mixed evidenceを片側へ寄せるfalse-clean、direct / pooled差、before / after差、欠落・重複・classification field取得不能はexit code 3または検証済みread-only driftとして拒否します。object名、schema名、owner名、OIDはreportへ出力しません。

`drizzle` schemaだけ、migration tableの形状不一致、migration管理objectの不足・追加、履歴1件以上、unknown / duplicate履歴、user-defined residual objectが1件でも存在する状態はpartialまたは既適用状態としてFAILです。空migration tableは正式な3 columns、primary key 1件、serial sequence 1件だけを許可します。3 columnsは、物理列数、relation対応、`attnum`順序、drop済み列0件、inheritance / local状態、built-in type、type length / pass-by-value / alignment、typmod、dimension、domain不使用、identity / generated不使用、canonical collation / NOT NULL / default有無、column ACL / option / FDW option、storage / compression、fresh PostgreSQL 18で得た単一の`attstattarget IS NULL`状態、missing-value状態まで`pg_attribute`の正式fieldをexact検証します。

canonical catalog契約はproduction preflight SQLとrepository metadata / testで固定します。実PostgreSQLでのgateはGitHub Actions Linux service containerが所有するdigest固定`postgres:18.6-bookworm`だけで実行し、repository harnessはdatabase process、port、data directory、PID、停止、削除を作成・所有しません。旧local postflight commandと旧local Migration commandは廃止し、repository-owned embedded PostgreSQL lifecycle commandは残していません。connection-only verifierはraw numeric `127.0.0.1`と明示portへだけ接続し、Production query関数を空ledger、fresh before / after、第三session drift、extension分類4種へ通します。extension actualはharness専用の独立catalog queryで取得し、digest固定PostgreSQL 18.6の固定contract `plpgsql` / `1.0` / `pg_catalog`とexact比較します。Production extension queryの結果からexpected値を生成しません。Migrationはrepositoryの固定journal / fileから0000〜0005、続いて0006を適用し、旧Migration harnessの0005互換性、PUBLIC依存時の原子的拒否、legacy owner / ACL継承、plan fail-closed、同時予約上限、release / finalize / stale recoveryをconnection-only verifierへ統合しています。0000〜0006適用後はschema、column、index、FK、unique、check、type、default、nullability、function、owner、ACL、ledger、replay、transaction rollback、postflightとdrift拒否を確認します。Environment Variable値、URL、host、database名、role名、owner名、OID実値、credential、raw error、stack、causeは出力しません。このworkflowは実staging / Production検証の代替ではありません。

`pg_class`はtable / sequence / primary-key indexについてrelation kind、namespace、access method、persistence、replica identity、RLS、populated / partition / shared / rewrite / row-type / typed-table状態、tablespace、TOASTのzero / nonzeroと参照対応、ACL / option、owner関係、固定boolean / charを検証します。`relfilenode`、`relpages`、`reltuples`、`relallvisible`、`relallfrozen`、`relfrozenxid`、`relminmxid`はrewrite、planner統計、VACUUM、freeze、transaction状態で変動するためfield別理由をcoverage matrixへ記録してexact固定から除外します。その他のstable fieldに未検査を残しません。

`pg_index`は`indexrelid` / `indrelid`対応、`indnatts` / `indnkeyatts`、全固定boolean、`indkey`、`indcollation`、`indclass`、`indoption`のsanitized vector、`indexprs` / `indpred`まで正式全fieldをcoverageします。`pg_constraint`はprimary key 1件とNOT NULL 2件についてcanonical name、namespace / relation / index / column対応、type、deferred / enforced / validated / local / inheritance / period状態、action chars、`conkey`、FK配列、delete-set列、exclusion配列、expressionの正式なnull / empty / fixed値まで全fieldをcoverageします。追加constraint、trigger、rule、policy、index、sequence、relation option、RLS、partition、predicate / expression index、sequence property / ownership / default dependencyの不一致を拒否し、追加catalog field取得不能はexit code 3です。serial sequenceの現在状態も固定read-only SQLで確認し、未使用状態`last_value=1`かつ`is_called=false`だけを許可します。direct / pooled初回・再取得・before / afterへ同じversion / catalog evidenceを含め、差異を拒否します。実値はreportへ出さず固定statusだけを保持します。repository journalとSQL fileは0000〜0006のexact 7件でなければならず、成功時のappliedは0件、pendingは0000〜0006のexact 7件です。

user-defined tableが0件であることによりapplication dataを保持するtableが存在しないことを確認し、catalog統計値にデータ残存が示される場合もFAILです。user-defined object evidenceとsequence current-state evidenceを、direct / pooled初回、両者比較、direct / pooled再取得、preflight前後比較のすべてへ含めます。preflightはprovider resourceの作成履歴や複製元をDB queryだけで証明しません。Productionから複製されていないことは、Neon側のprovider metadata preflightで別途証明する必須条件として維持します。

preflightはdirect / pooledのURL上のprovider identityとroutingを変更しないauthority、別経路で入力されたexpected identity、接続後のdatabase OID、catalog identity、`current_user`を照合します。両接続の初期状態も一致しなければなりません。実identity、host、database名、role名、provider IDは出力しません。

exit code 0の場合だけ、別途承認済みの`corepack npm run db:migrate`へ進めます。exit code 1 / 2 / 3、timeout、切断、cleanup不明、結果不明ではMigrationを実行しません。失敗または結果不明でもpreflightを再実行しません。

## 読み取り専用保証

direct / pooledはそれぞれ、bounded connection timeoutの後にbefore用の`REPEATABLE READ READ ONLY` transactionを開始します。transactionのread-only状態を確認し、statement timeoutとlock timeoutをtransaction内だけに設定します。before収集後はdirect / pooled双方のtransactionを安全に終了し、その両方の終了を確認してからafter用の新しい`REPEATABLE READ READ ONLY` transactionを双方で開始します。afterはbeforeと同じMVCC snapshotを再利用しません。終了または再開始を一方でも確認できなければexit code 3です。

repository管理の固定queryだけを許可し、次の処理を拒否します。

- `INSERT`、`UPDATE`、`DELETE`、`MERGE`
- `CREATE`、`ALTER`、`DROP`、`TRUNCATE`
- `GRANT`、`REVOKE`、`COMMENT`
- `VACUUM`、`ANALYZE`、`COPY FROM`
- `CALL`、`DO`、materialized view refresh
- Migration適用
- reservation / release / finalize / stale recovery / cleanup
- 任意SQLのCLI入力

成功・失敗のどちらでも`ROLLBACK`とconnection closeを試行します。rollbackまたはcleanupを確認できない場合はexit code 3です。AbortSignalまたはtimeoutが開始済みconnect / queryより先に確定した場合、provider driverがnative cancellationを保証しないためgraceful rollback / closeは`NOT VERIFIED`です。この場合もMigrationへ進まず、JSONとhuman summaryの同期書込み完了とfatal listener解除の後にprocessを終了し、active handleが残っても終了を保証します。通常のexit code 0 / 1 / 2では強制終了しません。

## Migration後postflight検証内容

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
3. Productionから複製されておらず、Production、rehearsal、backup、defaultから完全に分離されていることをprovider metadataで確認する。
4. direct migration roleとpooled runtime roleのowner / ACL設計を事前監査する。
5. 本人がdirect、pooled、expected identity、preflight用expected extension inventoryを専用processへ非表示で入力する。
6. `ACTUSTUBE_DB_ENV=staging`と`ACTUSTUBE_ALLOW_STAGING_DB_PREFLIGHT=1`を設定する。
7. `corepack npm run db:preflight:staging`を最大1回実行する。
8. preflight exit code 0の場合だけ、明示承認済みの別工程で`corepack npm run db:migrate`をexact 1回実行する。
9. Migration commandが正常終了してから、preflight許可名を削除し、`ACTUSTUBE_ALLOW_STAGING_DB_VERIFY=1`を設定する。
10. 同じ承認済みtargetに対し`corepack npm run db:verify:staging`を最大1回実行する。
11. preflight / postflightそれぞれのJSONとhuman summaryを確認し、全必須項目PASSかつexit code 0の場合だけ次のauthenticated staging test工程へ進める。
12. 1件でもFAIL / NOT VERIFIED / skipped / timeout / cleanup不明があれば続行せず、親shellからstaging用Environment Variablesを削除して停止する。

## preflight後からMigration開始前のTOCTOU

preflightのfresh after snapshotはpreflight実行中のdriftを検出しますが、preflight終了後のconcurrency barrierではありません。exit code 0は将来の任意時点のMigrationを許可しません。

- project ownerが明示承認した排他的maintenance window内で実行する
- preflight成功後は、別command、provider管理操作、schema変更、接続先・Environment Variable変更を挟まず、同じ担当と固定targetで直ちに承認済みMigration commandへ進む
- 遅延、terminal再接続、担当者変更、provider操作、予期しないdatabase activity、target metadataの変化があれば、そのpreflight PASSを流用せず停止し、新しい明示承認の下でpreflightからやり直す
- 将来のMigration runnerでは、preflightとMigrationが共有するadvisory lock、またはMigration開始直前の同等なcatalog / identity再検証を導入候補とする

現行実装はpreflightとMigrationを同一lockで束縛しておらず、lock実装済みとは扱いません。

## 出力とexit code

preflight / postflightの出力は機械可読JSONと人間向けsummaryです。出力可能なのは固定check ID、status、分類別件数、Migration tag、exit codeだけです。URL、host、database、user、role、owner、object / schema名、OID、branch / endpoint / project ID、query parameter、raw hash、hash prefix、raw driver error、stack、cause、実データを出力しません。preflightはterminal出力前にexact public schemaへ投影し、unknown key、許可外status、非sanitized文字列を含むreportを固定`PREFLIGHT_PUBLIC_REPORT_INVALID`のexit code 3へ置換します。exit 0は単一のcanonical semantic predicateで全必須状態を再検証します。非0もcanonical mappingを一元検証し、exit 1 / 2は`overallStatus=fail`かつ`failure.status=fail`、exit 3は両statusとも`not_verified`だけを受理します。exit、overall、failureの矛盾、unknown exit code、missing、duplicate、unknown check IDはraw reportを公開せず固定exit 3へ置換します。preflightの`userDefinedObjects`はexit code 0 / 1 / 2 / 3の全経路で`direct`、`pooled`、`directAfter`、`pooledAfter`を保持し、未取得値は`not_verified`です。formatterは欠落fieldを防御的に扱い、formatter failureはraw errorを出さない固定exit code 3 reportへ置換します。JSONとhuman summaryは同じreportから各1回だけ出力します。CLIの`uncaughtException` / `unhandledRejection` listenerは参照を保持し、正常終了、検証済み失敗、top-level failure、fatal eventの各経路で解除します。fatal後のexit code 3は後続結果で上書きしません。

- `0`：全必須検証PASS
- `1`：検証できた不一致 / FAIL
- `2`：設定不足、安全ゲート不合格、Production等の禁止target疑い
- `3`：接続状態不明、同一性NOT VERIFIED、timeout、catalog権限不足、rollback / cleanup不明

directだけ、pooledだけ、partial PASS、check skippedは成功ではありません。

preflightのexit code 1はMigration履歴が空でない、unknown / duplicate履歴、migration管理objectやapplication objectの残存、partial schema、direct / pooledの検証済み状態不一致を含みます。exit code 2はenvironment、許可フラグ、URL分類、expected provider identity等の接続前安全gate違反です。identityや接続結果を確認できない場合はexit code 3です。

## external fixture harnessの証明範囲

通常のlocal VitestはPostgreSQLを起動・接続しません。URL parserがlowercase `postgres` / `postgresql`、raw numeric `127.0.0.1`、明示的な1〜65535のcanonical port、expected database / role、major 18、Migration max 0006だけを受理し、`localhost`、DNS、IPv6、IPv4-mapped IPv6、percent-encoded hostname / user / password / database、query、fragment、multi-host、whitespace / control、missing credential、identity不一致をconnection factory呼出し0件で拒否することを確認します。fixture未設定のdirect invocationは非0と固定`EXTERNAL_FIXTURE_NOT_CONFIGURED`だけを出力します。

repository側のconnection-only verifierが受け取るfixture入力は、`ACTUSTUBE_STAGING_HARNESS_DATABASE_URL`、`ACTUSTUBE_STAGING_HARNESS_EXPECTED_DATABASE`、`ACTUSTUBE_STAGING_HARNESS_EXPECTED_ROLE`、`ACTUSTUBE_STAGING_HARNESS_EXPECTED_MAJOR`、`ACTUSTUBE_STAGING_HARNESS_EXPECTED_MIGRATION_MAX`の5個だけです。generic `DATABASE_URL`、`.env` file、CLI URL fallbackは使いません。GitHub Actions jobだけが、固定されたdisposable CI用database / role / passwordとrandom host-mapped portからURLをstep environment内で組み立てます。この値はstaging / Production credentialではなく、log、artifact、reportへ出しません。

PostgreSQL lifecycleは`.github/workflows/staging-database-preflight.yml`のUbuntu 24.04 service containerだけが所有します。repository内のembedded PostgreSQL dependency、local PostgreSQL lifecycle package command、起動・停止scriptはすべて削除済みです。workflowはdigest固定PostgreSQL 18.6、read-only repository permission、15分job timeout、credentialを永続化しないcheckout、Node 24、`npm ci --ignore-scripts`を固定し、verifier、TypeScript、full Vitest、full ESLintを順に実行します。repository verifierにはdatabase process API、port allocation、filesystem root、cleanup worker、watchdog、process query、PID / kill、OS utility、recursive delete、quarantine、reparse handling、IPC lifecycle ownership、native broker / Job ObjectのコードもDI seamもありません。

connection-only verifierはharness開始時にmonotonic clockから作成した単一のabsolute deadlineを使用します。totalは300,000ms、connectは10,000ms、client queryは30,000ms、server statementは20,000ms、lockは5,000ms、idle transactionは20,000ms、client closeは5,000ms以下です。各operationは固有上限とtotal残時間の小さい方で停止し、timeout時はrepository verifierが作成した当該`pg.Client`のsocketだけをidempotentに破棄します。timeout後は同じClientを再利用せず、追加query、ROLLBACK、probe、別operationを開始しません。`client.end()`も有限期限であり、完了しない場合は同じowned socketを破棄します。provider-native cancellation、実Neon、transaction pooler、実staging owner / ACL、advisory lockは引き続きNOT TESTEDまたはNOT VERIFIEDです。

P3 unit gateだけはconnection-only verifierから分離した`test-staging-database-fault-lifecycle.mjs`で固定sourceのbenign Node childを使います。connection-only verifierはこのmoduleをimportせず、`node:child_process`へ到達しません。P3 parentが固定modeをprivate IPCで1回渡し、childのexact schema / occurrence / capability / sequence / phaseを検証した上で、parentが`exit`と`close`のevent count、code、signal、monotonic timestampを別々に記録し、error eventとauthenticated phase sequenceも保持します。exact nonzero code、exact signal、deadline時aliveだけをacceptedとし、wrong / zero exit、wrong signal、deadline前正常終了、phase前failure、phase後正常終了、terminal reason偽装、duplicate / malformed / replayed phaseをrejectします。result keyはexact allowlistであり、private bindingとPID情報を含めません。これはdatabase processのownership、termination、cleanupをテストするものではありません。

- external fixture separate-role connection、PostgreSQL 18.6 actual結果、移植したusage Migration意味検証：GitHub Actions実行前のためNOT RUN
- staging専用provider resource：文書上は別工程で作成済み。今回のlocal product recoveryではprovider状態をNOT VERIFIED
- 実staging DB：未接続・未検証。preflight / Migration / postflightは実行0回
- real transaction pooler behavior：実provider endpoint未接続のためNOT TESTED
- 実staging owner / ACL：実staging DB未接続のためNOT TESTED
- Production：未接続・不変

local unit PASSまたはGitHub Actions disposable fixture PASSを、実provider poolerや実staging DBのPASSとして扱いません。workflow未実行時はexternal fixture検証をPASSと記録しません。

## 成功・停止・cleanup

staging構築を続行できるのは、provider UI上の本人確認、preflight exit code 0、Migration工程の成功、postflight exit code 0、秘密情報露出0、cleanup確認のすべてが揃った場合だけです。

staging resourceを将来削除する場合は、対象、影響、backup要否、Environment Variables、OAuth callback、provider resourceの順序を固定した別承認で行います。postflightはresource、schema、data、role、Environment Variablesを作成・変更・削除しません。失敗時も自動cleanupやprovider resource削除を行いません。

## Preflight input / terminal hardening contract

実行前にserver-side process入力として`ACTUSTUBE_EXPECTED_STAGING_EXTENSIONS`を必須とします。値は`{"schemaVersion":1,"extensions":[{"name":"...","schema":"...","version":"..."}]}`形式のJSONで、最大32,768 bytes、最大128 entries、各string最大128 charactersです。plain own objectとexact keyだけを受理し、unknown／dangerous key、prototype pollution形状、duplicate name、control character、NUL、path separator、空値、型不正、malformed／oversize JSONを拒否します。期待値とdirect／pooledのbefore／after inventoryは順序非依存でexact比較し、name／schema／versionの不足・余分・不一致を`STAGING_EXTENSION_INVENTORY_MISMATCH`として停止します。未設定は`STAGING_EXTENSION_INVENTORY_REQUIRED`、入力不正は`STAGING_EXTENSION_INVENTORY_INVALID`、実catalog取得不能は`STAGING_EXTENSION_INVENTORY_UNAVAILABLE`です。実際のstaging extension inventoryを本人が安全に確認し、値をcommand line、Git、reportへ露出せずprocess入力してください。

terminal reportはJSON summaryとhuman summaryをmemory上で単一buffer化し、terminal barrier後に同期write 1回だけで出力します。commit前のfatalはmain結果より優先し、exit 3のfatal report pairだけを出力します。main処理のAbortSignalはDB open、query scheduling、query待機、direct／pooled比較、before transaction終了、after transaction開始、report準備、cleanup開始判断のorchestration境界へ伝播します。cleanupはmainとは別のcontrollerを使い、direct／pooledを同時に開始して全体を最大5,000msに制限します。開始済みのprovider adapter connect / queryをdriverがnative cancelすることは、実provider未接続のためNOT TESTEDです。exit code 3では同期report commitとlistener解除後にprocessを終了します。

network evidenceの証明範囲はguardを明示的に導入したNode childだけです。報告項目は`guarded Node API unexpected violation`と`expected blocked DNS probe`の観測件数です。Windowsではcanonical `\\.\pipe\...`だけをlocal named pipeとして許可し、remote UNC、slash表記、extended UNC、`options.path`のremote形式をoriginal connect前にunexpected violationとして拒否します。POSIX local Unix domain socketはlocal IPCとして維持します。接続成功を観測する経路ではないため、`successful guarded Node API external connection`と`native child external connection`はどちらも`NOT VERIFIED`とします。expected probe IDは専用DNS probe childだけへ設定し、親profileへ設定しません。

このnetwork-guard unit testの観測範囲はguardを明示的に導入したNode childだけです。Next.js、npm、Vitest、Corepackその他のprocessがsensitive environment fileを読み取らなかったことや、native childの外部接続がなかったことは証明しません。
