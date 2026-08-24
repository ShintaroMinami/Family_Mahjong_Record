# 家族麻雀 スコア記録

家族の麻雀（実卓中心）のスコアを登録・集計する Google Apps Script Web アプリ。
データは Google スプレッドシートに保存され、スマートフォンのブラウザから
URL ひとつで利用できる。

設計の詳細は [DESIGN.md](DESIGN.md) を参照。

## できること

- **登録** — 1半荘ごとに、席順・素点・チップを入力。素点合計をリアルタイム検証し、
  確定前に順位と収支をプレビュー
- **今日** — その日の対局一覧とプレイヤー別集計
- **履歴** — 期間で絞った対局一覧。誤入力の訂正・削除（論理削除）もここから
- **統計** — 通算成績（対局数・平均順位・着順分布・トップ率・ラス率・飛び率）と
  累積収支グラフ
- **設定** — ルールプリセットの管理。人数（4人/3人）・配給原点・返し点・ウマ・飛び賞を
  それぞれ独立に設定でき、オカとウマ合計は自動計算して検証される
- 4人麻雀 / 3人麻雀の両対応。ウマ・オカ・飛び賞・チップに対応
- ルールを変更しても、登録済みの対局は**登録時のルールのまま**集計される
  （対局ごとにルールのスナップショットを保存）
- 雀魂の牌譜IDを任意で保存し、牌譜へのリンクを生成
- **合言葉によるアクセス制御**（任意）。設定すると初回アクセス時に入力を求められる

## ディレクトリ構成

```
src/          Apps Script にデプロイされるコード
  Code.js       doGet / setup（エントリポイント）
  Schema.js     シート定義と値の正規化
  Domain.js     順位・ウマ・オカ・収支の計算（純粋関数）
  Stats.js      集計（純粋関数）
  Store.js      スプレッドシートへの読み書き
  Repo.js       ドメイン単位のCRUD
  Api.js        ブラウザから google.script.run で呼ぶ関数
  index.html / css.html / js.html   画面
dev/          ローカル開発用（デプロイされない）
  local-server.js  ローカルWebサーバー
  app-context.js   src/*.js をNodeに読み込む
  LocalStore.js    Store.js のローカル版（JSONファイル）
  server.js        HTTP層
  e2e-script.js    ブラウザ内E2Eシナリオ
tests/        テスト
```

## ローカルで動かす

Google へのデプロイなしに、ブラウザで動作確認できる。

```bash
npm install          # 型定義と clasp のみ。実行時依存はゼロ
npm run dev:reset    # サンプルデータ付きで起動（既存のローカルDBは消える）
# → http://localhost:8080
```

| コマンド | 内容 |
|---|---|
| `npm run dev` | 現在のローカルDBのまま起動 |
| `npm run dev:seed` | データが空ならサンプルを投入して起動 |
| `npm run dev:reset` | ローカルDBを作り直してサンプルを投入 |

ローカルDBは `dev/data/db.json`（Git管理外）。スプレッドシートの行をそのまま
配列で持つので、本番と同じ読み書き経路を通る。

## テスト

```bash
npm test           # 計算ロジック・集計・サーバーAPIの58件
npm run test:e2e   # ヘッドレスChromeで実UIを操作する2シナリオ48項目
npm run test:all   # 両方
npm run typecheck  # JSDocベースの型チェック
```

- `npm test` は `src/` の実コードを Node に読み込んで検証する（外部ライブラリ不要）
- `npm run test:e2e` は Chrome を自動で探す。見つからない場合はスキップされる。
  別の場所にある場合は `CHROME_PATH=/path/to/chrome npm run test:e2e`

## デプロイ

事前に https://script.google.com/home/usersettings で
「Google Apps Script API」をオンにしておく。

```bash
npx clasp login
npx clasp create --type standalone --title "家族麻雀 スコア記録" --rootDir src
mv src/.clasp.json .clasp.json    # ← 下記の注意を参照
npx clasp push
```

> **注意**: `--rootDir` を指定すると clasp は `.clasp.json` を **rootDir の中**
> （`src/.clasp.json`）に作る。しかし `clasp push` はカレントディレクトリの
> `.clasp.json` を探すため、そのままではプロジェクトルートで
> `No valid .clasp.json project file` になる。上記のように1つ上へ移動すること。
> `rootDir` の値は `"src"` のままでよい。

1. GAS エディタで `setup()` を **1度だけ実行**
   → スプレッドシートが新規作成され、初期シートとデフォルトルールが投入される
2. 「デプロイ > 新しいデプロイ > ウェブアプリ」を選択
   - 次のユーザーとして実行: **自分**
   - アクセスできるユーザー: **全員**
3. 発行された URL を家族に共有する

`.clasp.json` は Git 管理外。`.clasp.json.example` を参考に作成するか、
`clasp create` が生成したものをそのまま使う。

## 合言葉の設定

公開範囲は「全員（匿名アクセス可）」なので、家族はGoogleアカウントなしで使えるが、
URLを知っていれば誰でも開けてしまう。**設定タブの「合言葉」**から合言葉を決めておくと、
初回アクセス時に入力を求められるようになる。

- 未設定のうちは誰でもアクセスできる（セットアップ直後の状態）
- 4文字以上60文字以内
- 一度入力すればその端末には記憶される
- 変更すると他の端末では再入力が必要になる

守れるのは「URLが流出して第三者に開かれる」ケースまで。合言葉は端末に平文で
保存されるため、端末そのものを他人に触られる状況は想定していない。
詳しくは [DESIGN.md](DESIGN.md) §10 を参照。

## 運用メモ

- ルール（人数・配給原点・返し点・ウマ・飛び賞）はアプリの「設定」タブで変更できる。
  スプレッドシートの `Rules` シートを直接編集しても同じ
- ルールを変更しても過去の対局は影響を受けない。対局ごとに登録時のルールが
  `Games` シートに記録されている
- 対局の削除は論理削除。行はシートに残るため、誤削除は `deleted` 列を `FALSE` に
  戻せば復旧できる
- 収支は必ず合計 0 になる。合わない場合は素点の入力ミス（登録時に警告が出る）
