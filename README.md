# SQLTools 用 FileMaker (ODBC) ドライバー

SQLTools のコミュニティ製ドライバーです。[`odbc`](https://www.npmjs.com/package/odbc) Node パッケージを内部で使用し、ODBC 経由で FileMaker Pro / FileMaker Server のファイルに接続します。

## 前提条件

1. **FileMaker 側の設定**: 対象のファイルで ODBC/JDBC 共有が有効になっていること([ファイル] ＞ [共有設定] ＞ [ODBC/JDBC を有効にする])。また、接続に使用するアカウントに `fmxdbc` 拡張アクセス権が割り当てられている必要があります。
2. **FileMaker ODBC クライアントドライバー**がこのマシンにインストールされていること(FileMaker Pro/Server の「Extras/xDBC」フォルダ、または Claris のダウンロードページから入手できます)。
3. **ODBC DSN の設定**(システム DSN を推奨)が完了しており、対象の FileMaker ファイルを指していること。macOS では「ODBC Manager」、Windows では「ODBC データソースアドミニストレーター」を使用して作成します。
4. **macOS のみ**: Homebrew の iODBC が必要です。

   ```bash
   brew install libiodbc
   ```

## macOS では iODBC を使う(重要)

`odbc` npm パッケージは通常 unixODBC にリンクされますが、**このプロジェクトでは `npm install` 時に自動で iODBC にリンクし直します**(`scripts/rebuild-odbc-iodbc.js` が postinstall で実行されます)。理由は 2 つあります。

1. **FileMaker ODBC ドライバー (fmodbc.so) は unixODBC 経由だと、SQL 文が 1 つ失敗しただけで `SQLExecDirect` 内部で abort し、プロセスごと落ちます**(SQLTools の言語サーバーがクラッシュ・再起動を繰り返す原因はこれでした)。iODBC 経由ではエラーが正しい診断メッセージ(例: `FQL0002: The table named "..." does not exist.`)として返り、接続もそのまま使い続けられます。FileMaker が macOS 向けに iODBC ベースの「ODBC Manager」を配布しているとおり、このドライバーは iODBC でのみ正しく動作します(ドライバー 26.0.1.1 で確認)。
2. **iODBC は ODBC Manager が管理する `/Library/ODBC/odbc.ini` / `odbcinst.ini` を標準で読みます。** unixODBC 時代に必要だった `ODBCSYSINI` / `ODBCINI` 環境変数の設定や LaunchAgent、VSCode の完全再起動といった仕掛けは一切不要になりました。DSN は ODBC Manager で一元管理できます。

また、同スクリプトは odbc モジュールのソースにもパッチを当てます: FileMaker ドライバーの ANSI 版 `SQLDescribeCol` は日本語などの列名を壊れた UTF-8 で返す(結果の列見出しが「顧�」のように化ける)ため、正常に動くワイド版 `SQLDescribeColW` で列名を取得して UTF-8 に変換するよう変更しています(データ値には元々問題ありません)。

## 日本語のテーブル名・フィールド名が文字化けする場合

DSN のプロパティ(`/Library/ODBC/odbc.ini` の該当セクション、または ODBC Manager の DSN 設定画面)に以下を設定してください。特に `WideAPI` が未設定だと、識別子の取得に古い narrow API が使われ `�` に化けます。

```ini
UseLongVarchar     = Yes
WideAPI            = Yes
MultiByteEncoding  = UTF-8
```

接続文字列モードを使う場合は、同じキーを接続文字列に含めます(接続設定の「Additional ODBC parameters」欄でも可)。

## SSL 証明書エラー(`[08S01] self-signed certificate`)が出る場合

FileMaker のホスティングは自己署名証明書を使うため、ドライバーが既定で証明書検証に失敗して接続を拒否することがあります(特に Windows 版ドライバー)。DSN または接続文字列に以下を追加してください。

```ini
CertificateFailureType = None
```

macOS の ODBC Manager で作成した DSN にはこのキーが最初から入っていることがあります(`/Library/ODBC/odbc.ini` で確認できます)。

## SQLTools での接続設定

接続アシスタントで「FileMaker (ODBC)」を選び、次のいずれかで設定します。

- **DSN モード**(推奨): ODBC Manager で作成した DSN 名、FileMaker のアカウント名・パスワードを入力します。DSN がファイルを指定していない場合のみ「FileMaker file name」を入力します。
- **Connection String モード**: `Driver=/Library/ODBC/FileMaker ODBC.bundle/Contents/MacOS/fmodbc.so;Server=localhost;Database=MyFile;UID=Admin;PWD=secret` のような完全な接続文字列を直接指定します(DSN 不要)。

## FileMaker SQL の癖・制限事項

このドライバーが吸収している(あるいは利用者が知っておくべき)FileMaker の xDBC/SQL 層の特徴です。

- **テーブル一覧はテーブルオカレンスではなく物理テーブル**を表示します。`FileMaker_Tables.TableName` はリレーションシップグラフのオカレンス名であり、`FROM` 句や `FileMaker_Fields.TableName` には使えないため、`BaseTableName` を使用しています。
- **`WHERE 列 <> ''` は正しく動作しません**(該当行があっても 0 行になります)。`IS NOT NULL` を使ってください。
- **複数ステートメントの一括実行はできません。** エディタで複数の SQL を実行すると、ドライバーがセミコロン区切りで 1 文ずつ実行します。
- **`ALTER TABLE ... RENAME TO 新名` / `RENAME COLUMN 旧 TO 新` が使えます**(日本語名も可。FileMaker Pro 2025 で確認)。ただし FileMaker の仕様として、`RENAME TO` で変わるのは**テーブルオカレンス名だけで、物理テーブル名は変わりません**。一方 `RENAME COLUMN` はフィールド名を実際に変更します。改名後の SQL は新しいオカレンス名でのみ参照でき、旧名を `FROM` に使うとエラーになります。このドライバーのサイドバーは物理テーブル名(`BaseTableName`)で一覧するため、SQL で改名したオカレンスとは表示名がずれる点に注意してください(物理テーブル名を変えたい場合は FileMaker の [データベースの管理] で行います)。
- **FileMaker Pro を同一 Mac で 2 つ同時に起動しない**でください(例: FileMaker Pro 22 と 26)。xDBC のポート 2399 を取り合い、片方の listener が孤児プロセスとして残ると、正しいインスタンスが起動していても `(802): Unable to open file` で接続できなくなります。なお 802 は認証失敗・ファイル未共有・ファイル未オープンでも返る汎用エラーです。

## Claude Code 用スキル (filemaker-sql)

[.claude/skills/filemaker-sql/SKILL.md](.claude/skills/filemaker-sql/SKILL.md) に、Claude Code から FileMaker の SQL 方言 (FSQL) を扱うためのスキルを同梱しています。このリポジトリを Claude Code で開くと自動的に認識され、FileMaker と SQL が絡む依頼(スキーマ調査、クエリー作成、DML/DDL の実行)の際に次の内容に沿って動作します。

- **FSQL チートシート**: `LIMIT` の代わりに `FETCH FIRST`、`INFORMATION_SCHEMA` の代わりに `FileMaker_BaseTables` / `FileMaker_BaseTableFields`、識別子のダブルクォーテーション必須、`ALTER TABLE` の構文一覧など、標準 SQL との相違点のまとめ
- **安全プロトコル**: UPDATE / DELETE の前に同じ WHERE 句で SELECT して件数を確認する、WHERE なしの破壊的操作は実行前に影響範囲を提示する、といった運用ルール
- **公式リファレンスへのリンク**: Claris の SQL リファレンス (markdown 版) の URL 一覧。詳細が必要なときにスキルが自動で参照します

他のプロジェクトでも使いたい場合は、`~/.claude/skills/filemaker-sql/` にコピーするとユーザーレベルのスキルとして全プロジェクトで有効になります。

## はじめに(開発向け)

```bash
npm install     # postinstall で odbc モジュールが自動的に iODBC ビルドされます
npm run watch   # または: npm run compile
```

## パッケージング

SQLTools の標準的な driver-template 構成に従っています。この拡張は `node_modules` ごと vsix に同梱するため、**中のネイティブバイナリ(`odbc.node`)がインストール先の OS と一致している必要があります**。プラットフォームごとに `vsce package --target` で別々の vsix を作ります(すべて macOS 上で実行できます)。

### macOS (Apple Silicon) 用

```bash
npm run package   # → sqltools-filemaker-odbc-driver-darwin-arm64-<ver>.vsix
```

`npm install` の postinstall でビルドされた iODBC リンク版(ワイド列名パッチ入り)の `odbc.node` がそのまま入ります。

### Windows (x64) 用

```bash
npm run package:win   # → sqltools-filemaker-odbc-driver-win32-x64-<ver>.vsix
```

`scripts/package-win32.js` が次を自動で行います:

1. インストール中の `odbc` パッケージと同じバージョンの **IBM 公式ビルド済み win32-x64 バイナリ**を [node-odbc の GitHub Releases](https://github.com/IBM/node-odbc/releases) からダウンロード(`.cache/` にキャッシュ)
2. `node_modules/odbc/lib/bindings/napi-v8/odbc.node` を一時的に Windows 版へ差し替えて `vsce package --target win32-x64` を実行
3. 終了後(失敗時も)macOS 版バイナリを復元

> **注意**: Windows 版に入るのは IBM 公式バイナリなので、macOS 版に適用している `SQLDescribeColW` ワイド列名パッチは**含まれません**。Windows で日本語の列名が化ける場合は、上記「日本語のテーブル名・フィールド名が文字化けする場合」の DSN 設定(`WideAPI=Yes` など)で対処してください。

### インストール

生成された `.vsix` のうち **インストール先 OS に合った方**を VS Code の「Install from VSIX...」でインストールします。ファイル名の `darwin-arm64` / `win32-x64` はラベルであり、ローカルインストール時に OS チェックはされないため、取り違えないよう注意してください(間違えると `ERR_DLOPEN_FAILED: ... is not a valid Win32 application` などのエラーになります)。Marketplace への公開は任意で、個人・社内利用なら `.vsix` の直接インストールで十分です。
