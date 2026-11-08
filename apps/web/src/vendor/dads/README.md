# デジタル庁の公式サンプルからの再利用

Source: https://github.com/digital-go-jp/design-system-example-components-html/tree/caa50d731cf515cfa5eae0093121f11ac5299235

MIT / Copyright (c) 2025 デジタル庁。LICENSEを同梱。

- tokens.css: src/global.css の :root トークンを抽出。値は変更しない。
- button.css: src/components/button/button.css を無変更で同梱。
- フォーム・見出し・余白などのアプリ側の調整は ../../style.css と docs/UI_DESIGN.md に記載。
- 読込はローカルバンドル。ランタイムのCDNやTailwind等の追加依存は使わない。
