<h1 align="center">Pet Companion</h1>

<p align="center">
  AI コーディングエージェント向けの、単体で動くアニメーション pet overlay。
</p>

<p align="center">
  <a href="README.md"><img src="https://img.shields.io/badge/english-document-white.svg" alt="EN doc"></a>
  <a href="README_JP.md"><img src="https://img.shields.io/badge/ドキュメント-日本語-white.svg" alt="JA doc"/></a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Python-3.10%2B-blue" alt="Python 3.10+">
  <img src="https://img.shields.io/badge/React-18-61dafb" alt="React 18">
  <img src="https://img.shields.io/badge/Vite-6-646cff" alt="Vite 6">
  <img src="https://img.shields.io/badge/GTK-3-green" alt="GTK 3">
  <img src="https://img.shields.io/badge/WebKit2-4.1-43a047" alt="WebKit2 4.1">
  <img src="https://img.shields.io/badge/Linux-overlay-black" alt="Linux overlay">
</p>

## ✨ 特徴

- Clippy、Dario、Tux、YoRHa 2B などの同梱 pet
- `~/.config/pet-companion/pets/` と `~/.codex/pets/` からのユーザー pet 自動検出
- Codex 8x9 atlas による idle、waving、running、jumping、failed、waiting、review の切り替え
- Linux 上でのデスクトップ全体ドラッグ対応 overlay
- 開発しやすい browser mode
- Server-Sent Events (SSE) によるリアルタイム反応
- `bubbleBg` と `bubbleText` による吹き出し色カスタマイズ
- Claude Code、Codex CLI、手動 `pet-companion emit` に対応

## 🚀 クイックスタート

```bash
cd pet-companion
pip install -e .

# Linux デスクトップ overlay を起動
pet-companion start

# 通常のブラウザタブで開く
pet-companion start --browser
```

デフォルトの `start` は GTK overlay を起動します。
従来のブラウザ表示を使いたい場合だけ `--browser` を付けてください。

## 🖥️ Overlay モードについて

overlay モードは Linux 固有のデスクトップ機能を使って実現しています。

- GTK3 による透明トップレベルウィンドウ
- WebKit2GTK による pet UI 描画
- X11 input shape によるクリック透過
- GTK のネイティブ drag handle による安定したドラッグ

補足:

- 現状の overlay 実装は Linux 前提です
- 透明 overlay を安定させるため `GDK_BACKEND=x11` を使っています
- 依存が足りない環境では browser mode がフォールバックになります

## 🧰 CLI

```bash
pet-companion start [--pet tux]                    # GTK overlay を起動
pet-companion start --browser [--pet tux]          # ブラウザで起動
pet-companion emit <event-type> [options]          # イベント送信
pet-companion list                                 # 利用可能な pet 一覧
pet-companion install-hooks <agent>                # hook 設定例を表示
```

### イベント種別

- `idle`
  セッション待機
- `thinking`
  ユーザー入力受付後の思考中
- `tool-use`
  ツール実行開始
- `tool-result`
  ツール終了。`--status success` か `--status error` を指定
- `failed`
  回復不能エラー
- `review`
  承認待ちやレビュー待ち

例:

```bash
pet-companion emit thinking --port 19822
pet-companion emit tool-use --port 19822
pet-companion emit tool-result --status error --message "Build failed" --port 19822
pet-companion emit idle --port 19822
```

## 🔌 Agent 連携

### Claude Code

`~/.claude/settings.json` の `hooks` に追加:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "pet-companion hook-emit user-prompt-submit --port 19822",
            "timeout": 30
          }
        ]
      }
    ],
    "PreToolUse": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "pet-companion hook-emit pre-tool-use --port 19822",
            "timeout": 30
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "pet-companion hook-emit post-tool-use --port 19822",
            "timeout": 30
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "pet-companion hook-emit stop --port 19822",
            "timeout": 30
          }
        ]
      }
    ]
  }
}
```

### Codex CLI

`~/.codex/hooks.json` の `hooks` に追加:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "pet-companion hook-emit user-prompt-submit --port 19822",
            "timeout": 5
          }
        ]
      }
    ],
    "PreToolUse": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "pet-companion hook-emit pre-tool-use --port 19822",
            "timeout": 5
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "pet-companion hook-emit post-tool-use --port 19822",
            "timeout": 5
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "pet-companion hook-emit stop --port 19822",
            "timeout": 5
          }
        ]
      }
    ]
  }
}
```

動作の仕組み:

- Codex の command hook は `stdin` で 1 個の JSON オブジェクトを渡します
- `pet-companion hook-emit ...` はその hook JSON を直接読みます
- `PostToolUse` では `tool_name`, `tool_input`, `tool_response` などから tool 情報とメッセージを抽出します
- `tool_response.message` があれば、その文字列をそのまま吹き出しに流します

つまり、たとえば次のような hook 入力:

```json
{
  "tool_name": "Bash",
  "tool_response": {
    "success": false,
    "message": "Build failed"
  }
}
```

は内部的に次と同等の emit に変換されます:

```bash
pet-companion emit tool-result --status error --message "Build failed" --port 19822
```

## 🐾 カスタム pet

次の場所から pet を探索します。

- `~/.config/pet-companion/pets/<pet-id>/`
- `~/.codex/pets/<pet-id>/`

最低限必要な構成:

```text
<pet-id>/
  pet.json
  spritesheet.webp
```

例:

```json
{
  "id": "jovithulhu",
  "displayName": "Jovithulhu",
  "description": "A strange Codex pet fused from Saturn, Jupiter, and a cute eldritch Cthulhu avatar.",
  "spritesheetPath": "spritesheet.webp",
  "kind": "object"
}
```

同じ pet ID が両方にある場合は `~/.config/pet-companion/pets/` を優先します。

## ⚙️ 設定

メイン設定は `~/.config/pet-companion/pet.json` に保存されます。

```json
{
  "adopted": true,
  "enabled": true,
  "petId": "jovithulhu",
  "petScale": 1.5,
  "custom": {
    "name": "Buddy",
    "glyph": "🐾",
    "accent": "#c96442",
    "greeting": "Hi! I'm here to help.",
    "bubbleBg": "#1f2430",
    "bubbleText": "#f5f7ff"
  }
}
```

主な項目:

- `petId`
  選択中の pet ID。`pet-companion list` で確認
- `petScale`
  overlay の倍率。`1` が標準、`1.5` が 150%、`2` が 200%
- `custom.accent`
  吹き出し枠線やアクセント色
- `custom.bubbleBg`
  吹き出し背景色
- `custom.bubbleText`
  吹き出し本文文字色

例:

```bash
pet-companion start --pet tux
pet-companion start --pet jovithulhu
pet-companion start --browser --pet jovithulhu
```

```json
{
  "petScale": 2
}
```

## 🧪 開発

```bash
# フロントエンド開発サーバ
cd frontend
npm install
npm run dev

# ビルドして pet_static へ出力
cd frontend
npm run build

# overlay モードを verbose で起動
python -m petcompanion start --verbose

# browser モードを verbose で起動
python -m petcompanion start --browser --verbose
```

## 🧱 アーキテクチャ

```text
Agent hook -> pet-companion emit -> POST /api/event -> EventHub -> SSE -> React frontend
                                                   \-> Linux GTK overlay
```

- `petcompanion/`
  Python バックエンド、設定、asset 探索、CLI、GTK overlay
- `frontend/`
  React/Vite フロントエンド
- `petcompanion/pet_static/`
  Python サーバが配信するビルド済み資産
- `hooks/`
  各エージェント向け hook テンプレート

## 🛠️ トラブルシュート

- `pet-companion list` には出るが `--pet <id>` で見た目が変わらない
  実行中のサーバや overlay を再起動してください
- browser mode ではページ内だけしかドラッグできない
  Linux overlay のデフォルト起動を使ってください
- overlay が開かない
  `sudo apt install gir1.2-webkit2-4.1 python3-gi`
- custom pet が検出されるのに表示されない
  `pet.json` と `spritesheetPath` の参照先が揃っているか確認してください

## 🙏 謝辞

このプロジェクトの pet 機能は
[`nexu-io/open-design`](https://github.com/nexu-io/open-design)
の pet 機能をベースに構築しています。

## 📄 License

MIT
