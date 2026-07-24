---
name: filemaker-sql
description: ODBC 経由の SQL (FSQL) で FileMaker Pro / FileMaker Server のデータベースを直接管理するスキル。VS Code の SQLTools ドライバから SELECT / INSERT / UPDATE / DELETE / CREATE / ALTER / DROP / TRUNCATE を実行する場面で必ず使用する。「FileMaker に SQL を投げたい」「テーブル定義を SQL で変更したい」「FileMaker のスキーマを調べたい」「ExecuteSQL / FSQL のクエリーを書いて」「ODBC でレコードを更新して」など、FileMaker と SQL が絡む依頼はすべてこのスキルの対象。FileMaker の SQL 方言は標準 SQL と大きく異なる (LIMIT なし、INFORMATION_SCHEMA なし等) ため、記憶に頼らず必ず本スキルのチートシートを参照してからクエリーを書くこと。
---

# FileMaker SQL (FSQL) — ODBC 経由のデータベース管理

FileMaker Pro / Server の ODBC クライアントドライバ経由で SQL を実行し、データとスキーマを直接管理するためのスキル。実行環境は VS Code の SQLTools + カスタム FileMaker ODBC ドライバを想定する。

FileMaker の SQL 方言 (通称 FSQL) は SQL-92 エントリレベル準拠だが、一般的な RDBMS の常識が通じない点が多い。**クエリーを書く前に必ず下のチートシートを確認し、不明点は末尾の公式リファレンス URL を fetch して裏を取ること。**

## ワークフロー

1. **スキーマ調査から始める** — `INFORMATION_SCHEMA` は存在しない。代わりに FileMaker システムテーブルを使う:
   ```sql
   -- 基本テーブル一覧 (テーブルオカレンスを除くので高速)
   SELECT BaseTableName FROM FileMaker_BaseTables
   -- 特定テーブルのフィールド定義
   SELECT FieldName, FieldType, FieldClass, FieldReps
   FROM FileMaker_BaseTableFields WHERE BaseTableName = 'テーブル名'
   ```
   `FieldClass` が `Calculated` / `Summary` のフィールドは書き込み不可。DML の対象は `Normal` のみ。
2. **チートシートに従って FSQL を組み立てる** (下記)。
3. **生成した SQL はチャットに書くだけでなく、必ずファイルに書き込む** — 「SQL を作成して」「クエリーを書いて」という依頼は、現在エディタで開いているドキュメント (ide_opened_file、通常は `*.session.sql`) への書き込みまでを含む指示として扱う。開いているファイルが SQL ファイルでない・どのファイルも開いていない場合のみ、書き込み先を確認する。既存内容があるファイルには追記し、勝手に上書きしない。SQLTools で 1 文ずつ選択実行できるよう、ステートメントは `;` 区切り + 実行順に並べる。
4. **SQLTools で実行する**。破壊的操作 (UPDATE / DELETE / TRUNCATE / DROP / ALTER) は下の「安全プロトコル」に従う。
5. **エラーが出たら** エラーコードを公式の「FileMaker SQL エラーコード」ページで確認し、クエリーを修正して再実行する (生成→実行→エラー→修正のループ)。

## FSQL チートシート

### 識別子と引用符

- テーブル名・フィールド名は**ダブルクォーテーション**で囲む。英字以外で始まる名前・ピリオドを含む名前は必須、それ以外でも予約語衝突やスペース対策として**常に囲むのが安全** (日本語名は必ず囲む): `SELECT "姓" FROM "従業員名簿"`
- 文字列リテラルは**シングルクォーテーション**: `WHERE "会社" = 'Claris'`
- 予約語は非常に多い (公式「予約 SQL キーワード」参照)。`DATE`, `ORDER`, `USER`, `NAME` 等をフィールド名に使う場合は必ずダブルクォートする。

### 一般的な SQL との相違点 (最重要)

| やりたいこと | ❌ 動かない書き方 | ✅ FSQL の書き方 |
| --- | --- | --- |
| 行数制限 | `LIMIT 10` / `TOP 10` | `FETCH FIRST 10 ROWS ONLY` |
| ページング | `LIMIT 10 OFFSET 25` | `OFFSET 25 ROWS FETCH FIRST 10 ROWS ONLY` (必ず OFFSET が先) |
| スキーマ取得 | `INFORMATION_SCHEMA.*` | `FileMaker_BaseTables` / `FileMaker_BaseTableFields` |
| 自動連番 | `AUTO_INCREMENT` / `SERIAL` | SQL では定義不可 (FileMaker 側のシリアル番号入力値の自動化を使う) |
| 空文字判定 | `WHERE f = ''` | 空文字は NULL として格納される → `WHERE f IS NULL` |

- `OFFSET` / `FETCH FIRST` は**サブクエリーでは使えない**。`FETCH FIRST n PERCENT` と `WITH TIES` (要 ORDER BY) が使える。
- DML (INSERT / UPDATE / DELETE) は**単一テーブルのみ**。JOIN を伴う UPDATE / DELETE は不可 → 対象の主キーや `ROWID` を SELECT で先に特定してから単一テーブルに対して実行する。
- `SELECT` の句の並び: `SELECT [DISTINCT] … FROM … [WHERE] [GROUP BY] [HAVING] [UNION [ALL]] [ORDER BY] [OFFSET] [FETCH FIRST] [FOR UPDATE]`

### 日付・時刻・その他の定数

```sql
DATE '2026-07-24'   TIME '14:30:00'   TIMESTAMP '2026-07-24 14:30:00'
-- ODBC ブレース形式も可: {d '2026-07-24'} {t '14:30:00'} {ts '2026-07-24 14:30:00'}
CURRENT_DATE  CURRENT_TIME  CURRENT_TIMESTAMP  CURRENT_USER
```

### データタイプ (CREATE TABLE / ALTER TABLE 用)

`NUMERIC` / `DECIMAL(p,s)` / `INT` / `DATE` / `TIME` / `TIMESTAMP` / `VARCHAR(n)` / `CHARACTER VARYING` / `BLOB` (= オブジェクトフィールド) / `VARBINARY` / `LONGVARBINARY` / `BINARY VARYING`

- 繰り返しフィールド: 型の後に `[n]` (1〜32000)。例: `"姓" VARCHAR(20)[4]`
- 制約: `DEFAULT 式` / `UNIQUE` (=ユニークな値) / `NOT NULL` (=空欄不可) / `PRIMARY KEY` / `GLOBAL` (=グローバル格納)
- 外部キー: `FOREIGN KEY REFERENCES 親テーブル (列)` — リレーションシップグラフに実際にリレーションが作られる。循環参照はエラー 8201。
- 外部保存オブジェクト: `BLOB EXTERNAL 'Files/DB名/' SECURE` または `… OPEN 'フォルダ'`

```sql
CREATE TABLE "注文" (
    "注文 ID" INT PRIMARY KEY,
    "顧客 ID" INT FOREIGN KEY REFERENCES "顧客" ("顧客 ID"),
    "注文日" DATE,
    "メモ" VARCHAR(500)
)
```

### ALTER TABLE (1 ステートメント 1 列まで)

```sql
ALTER TABLE "T" ADD "列 1" VARCHAR
ALTER TABLE "T" DROP "列 1"
ALTER TABLE "T" RENAME TO "新テーブル名"
ALTER TABLE "T" RENAME COLUMN "旧" TO "新"
ALTER TABLE "T" ALTER "列" SET DEFAULT 'Claris'   -- 既存行には影響しない
ALTER TABLE "T" ALTER "列" DROP DEFAULT
```

型変更の構文はない。型を変えたい場合は 新列 ADD → UPDATE でコピー → 旧列 DROP → RENAME COLUMN の手順を提案する。

### インデックス

```sql
CREATE INDEX ON "テーブル" ("列")
DROP INDEX ON "テーブル" ("列")
```

### システムテーブル・システム列

| オブジェクト | 用途 |
| --- | --- |
| `FileMaker_Tables` | 全テーブルオカレンス (TableName, BaseTableName, TableId, ModCount) |
| `FileMaker_BaseTables` | 基本テーブルのみ (BaseTableName, Source, ModCount) — 高速 |
| `FileMaker_Fields` / `FileMaker_BaseTableFields` | フィールド定義 (FieldName, FieldType, FieldClass, FieldReps) |
| `FileMaker_ValueLists` / `FileMaker_ValueList_<名前>` | 値一覧の定義と項目 |
| `ROWID` 列 | 全テーブルの各行に暗黙で存在。Get(レコード ID) と同値。WHERE でのピンポイント指定に最適 |
| `ROWMODID` 列 | レコードの編集確定回数。楽観ロック的な変更検知に使える |

## 安全プロトコル (DML / DDL)

破壊的操作は取り消せない (ODBC は基本オートコミット)。以下を必ず守る:

1. **UPDATE / DELETE の前に同じ WHERE 句で SELECT** を実行し、対象行数と内容をユーザーに提示して確認を取る。
   ```sql
   SELECT COUNT(*) FROM "顧客" WHERE "都道府県" = '東京都'   -- まず件数確認
   ```
2. **WHERE なしの UPDATE / DELETE、TRUNCATE TABLE、DROP TABLE / DROP INDEX、ALTER TABLE … DROP** は、ユーザーが明示的に指示した場合でも実行前に対象と影響を復唱して確認を取る。
3. スキーマ変更 (DDL) の前に `FileMaker_BaseTableFields` で現状の定義を取得して差分を明示する。
4. 特定行の更新には主キーか `ROWID` を使い、`ROWMODID` で更新前後の変更有無を検証できる。
5. 計算フィールド・集計フィールド (`FieldClass` ≠ `Normal`) への書き込みはエラーになるので INSERT / UPDATE の列リストから除外する。

## トラブルシューティング

- エラーコードが返ったら → 公式「FileMaker SQL エラーコード」を fetch して意味を確認。
- 「テーブルが見つからない」→ テーブルオカレンス名と基本テーブル名の混同が典型。`FileMaker_Tables` と `FileMaker_BaseTables` の両方を確認。ODBC 経由では基本テーブル名でアクセスする。
- 文字化け・識別子エラー → 日本語識別子のダブルクォート漏れを疑う。ドライバ側は Unicode API 対応だが、非対応ツール併用時は ASCII 名が推奨とされている。
- 構文は正しいのに失敗 → 予約語衝突 (要ダブルクォート)、サブクエリー内 OFFSET/FETCH、複数テーブル DML のいずれかが多い。

## 公式リファレンス (詳細が必要なときに URL を fetch する)

Claris FileMaker SQL リファレンス (markdown 版, ja)。ベース URL: `https://help.claris.com/markdown/ja/sql-reference/`

**ステートメント**
- `select-statement.md` / `insert-statement.md` / `update-statement.md` / `delete-statement.md`
- `create-table-statement.md` / `alter-table-statement.md` / `truncate-table-statement.md`
- `create-index-statement.md` / `drop-index-statement.md`
- `sql-statements.md` (総覧)

**句・演算子**
- `sql-clauses.md` / `from-clause.md` / `where-clause.md` / `group-by-clause.md` / `having-clause.md` / `order-by-clause.md` / `offset-and-fetch-first-clauses.md` / `for-update-clause.md` / `union-operator.md`
- `relational-operators.md` / `logical-operators.md` / `character-operators.md` / `date-operators.md` / `operator-precedence.md`

**関数・式・定数**
- `sql-functions.md` (総覧) / `functions-that-return-character-strings.md` / `functions-that-return-numbers.md` / `functions-that-return-dates.md` / `aggregate-functions.md` / `conditional-functions.md`
- `sql-expressions.md` / `constants.md`

**システムオブジェクト・その他**
- `filemaker-system-tables.md` / `filemaker-system-columns.md` / `filemaker-system-objects.md`
- `reserved-sql-keywords.md` (識別子エラー時に必読)
- `filemaker-sql-error-codes.md` (エラー時に必読)
- `using-filemaker-pro-database-as-data-source.md` (ODBC/JDBC ドライバの準拠仕様)
- `using-executesql-function.md` (FileMaker 内 ExecuteSQL との差異)
- `index.md` (全体目次)
