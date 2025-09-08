 # gpts-rss-supplement
-GPTs用のRSS補足API
+
+版元ドットコムの新刊/近刊情報を補足するための軽量RSS→JSON API。
+VercelのServerless Functions (Node.js) で動作します。
+
+本APIは[文献探索アシスタント](https://chatgpt.com/g/g-68b3bb13a53c8191b035f8777f7623be-wen-xian-tan-suo-asisutanto)などのGPTs追加アクションから呼び出され、関連する近刊・新刊書籍を補足情報として提示する用途を想定しています。
+
+## デプロイ手順
+1. このリポジトリをGitHub等に配置し、Vercelで新規プロジェクトとしてインポートします。
+2. ビルド設定は不要です。Node.jsランタイム（自動）でデプロイされます。
+3. デプロイ完了後、以下のエンドポイントで動作確認できます。
+   変更を反映したい場合は、GitHubへプッシュ後にVercelで再デプロイしてください（`vercel --prod` またはダッシュボードからの Redeploy）。
+
+## エンドポイント
+### `/api/fetch-test`
+外部アクセスの疎通確認用。example.comと版元公式RSSへのアクセス結果をJSONで返します。
+
+### `/api/rss-supplement`
+版元RSSを取得し、正規化したJSONを返します。主なクエリ:
+- `feeds`: `shinkan` (新刊) / `kinkan` (近刊)。複数指定可。省略時は両方。
+- `q`: キーワード。指定すると単純一致率 `match_score` でソート。
+- `days_window`: 新刊を発行日から何日以内に限定するか (1-90)。未指定で無効。
+- `limit`: 返却件数 (最大50)。
+- `debug=1`: デバッグ情報を含める。
+
+## 動作確認
+`<project>` はVercelのプロジェクト名。
+
+```bash
+https://<project>.vercel.app/api/fetch-test
+
+https://<project>.vercel.app/api/rss-supplement?feeds=shinkan&feeds=kinkan&limit=5&debug=1
+
+https://<project>.vercel.app/api/rss-supplement?q=文学&feeds=shinkan&limit=5
+
+https://<project>.vercel.app/api/rss-supplement?feeds=shinkan&days_window=90&limit=10
+```
+
+## 返却フィールド
+`feed`, `title`, `link`, `pubDate`, `isbn13`, `match_score`, `tag`。
+デバッグ時は到達URLや試行ログ (`attempts`) を併せて返却します。
+
+## 注意
+- 書影など画像URLは返しません。
+- 版元ドットコムの利用条件（販売・紹介目的）を守って利用してください。
