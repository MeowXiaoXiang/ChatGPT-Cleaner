# ChatGPT 訊息清理小工具

**🌐 語言選擇:** [English](../README.md) | [繁體中文](./README_zh-TW.md)

<!-- markdownlint-disable MD033 -->

<p align="center">
  <img src="../src/icons/chat-icon.svg" width="128" height="128" alt="icon" />
</p>
<!-- markdownlint-enable MD033 -->

輕量化清理 ChatGPT 對話：保留最新訊息，隱藏或刪除較舊內容，降低頁面負擔。

![version](https://img.shields.io/badge/version-1.0.0-2563EB)
![Manifest v3](https://img.shields.io/badge/Manifest-v3-334155)
![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript)
![License](https://img.shields.io/badge/License-MIT-10B981)

---

## 下載安裝

* **Chrome 線上應用程式商店**: (待新增)
* **Microsoft Edge 附加元件**: (待新增)

## 特色

* 模式選擇：

  * 隱藏（Hide）：將較舊訊息從畫面移除但保留於 DOM，可隨時還原
  * 刪除（Delete）：從 DOM 完整移除（`Element.remove()`），對超長對話特別有幫助
* 負載保護：偵測長任務密度與平均耗時，忙碌時自動暫停
* 空閒/批次：使用空閒時間處理，批次大小動態調整
* 自動調速：依平均耗時自適應延遲
* 顯示更多（Show previous）：需要時快速還原較舊內容
* 多語言：en / zh-TW / zh-CN

## 功能預覽

<!-- markdownlint-disable MD033 -->
<p align="center">
  <img src="docs/demo.png" alt="ChatGPT 訊息清理小工具展示" width="800" />
</p>
<!-- markdownlint-enable MD033 -->

---

## 適用範圍與設計考量

此工具著重於「前端視圖層的節流與整理」，藉由降低可見元素與 DOM 壓力來改善體感流暢度；同時尊重站點本身的運作機制。以下情境不直接涵蓋，改善幅度可能依站點設計而異：

* 模型/網路的先天耗時
* 站內全域狀態、虛擬清單、追蹤腳本等非 DOM 成本
* 服務端對話長度、同步/快取或非 DOM 記憶體占用

設計重點：

* 隱藏（Hide）：節點仍在 DOM，但移除視覺與互動（`aria-hidden`、`inert`），可快速還原。
* 刪除（Delete）：節點自 DOM 移除（`Element.remove()`），能釋放 DOM 記憶體；實際效果仍視站點整體行為而定。
* 負載保護：偵測繁忙時暫停，恢復後再補一次。

簡言之：本工具是「前端視圖層的整理員」，會盡量不與站內複雜機制對撞，也不碰你的帳號/雲端資料。若對話本身極大或站點當下負載很高，仍可能感到卡頓。

---

## 安裝（手動載入）

1. 取得程式碼並安裝依賴（推薦：Yarn v4 via Corepack；亦支援 npm/pnpm）

    ```bash
    git clone https://github.com/MeowXiaoXiang/ChatGPT-Cleaner.git
    cd ChatGPT-Cleaner

    # 推薦：使用 Corepack 啟用 Yarn v4（不強制）
    corepack enable
    corepack prepare yarn@stable --activate
    yarn install

    # 或者使用 npm / pnpm / Yarn v1
    # npm install
    # pnpm install
    ```

2. 建置（產出 dist/）

    ```bash
    yarn build
    # 或 npm run build / pnpm run build
    ```

3. 於 Chrome 載入（擴充功能 → 開發人員模式 → 載入未封裝項目）

    * 開啟 chrome://extensions
    * 開啟「開發人員模式」
    * 點擊「載入未封裝項目」，選擇 `dist/` 資料夾

> 開發模式可使用 `yarn dev` 進入 watch 模式（會自動重建並複製靜態資源到 dist）。

---

## 使用方式

* 工具列按鈕：點擊切換啟用/停用（徽章顯示 ON/OFF）。
* 懸浮球（右下）：點擊開啟面板設定 Keep up to / Mode（Hide 或 Delete）/ Notifications。
* 隱藏模式：對話頂部會出現「Show previous」以還原較舊訊息。

---

## 專案結構

```text
│  .gitignore              # Git 忽略規則
│  esbuild.config.mjs      # Esbuild 打包設定
│  LICENSE                 # 授權 (MIT)
│  package.json            # 套件與腳本定義
│  README.md               # 專案說明文件
│  tsconfig.json           # TypeScript 編譯設定
│
├─scripts                  # 輔助腳本
│      postinstall.js      # 安裝後自動執行 (SDK 註冊)
│      zip.js              # 打包 dist/ 成 zip
│
├─src
│  │  manifest.json        # Chrome 擴充功能設定 (Manifest v3)
│  │
│  ├─background            # 背景服務
│  │      background.ts
│  │
│  ├─content               # 前端注入腳本
│  │      debug.ts         # 除錯面板，即時指標與圖表監控
│  │      dom-utils.ts     # DOM 工具函式（選擇器、樣式、標記）
│  │      idle-utils.ts    # 空閒時間回調封裝，確保處理順暢
│  │      main.ts          # 主入口點與流程編排邏輯
│  │      observer.ts      # DOM 變更監聽器與路由偵測
│  │      trim-engine.ts   # 核心訊息隱藏/刪除演算法
│  │      types.ts         # 共享的 TypeScript 型別定義
│  │      ui.ts            # UI 元件（懸浮球、面板、提示框）
│  │
│  ├─icons                 # 擴充功能圖示
│  │      chat-icon-*.png / svg
│  │
│  ├─styles                # 注入樣式
│  │      content.css
│  │
│  └─_locales              # 多語言 (i18n)
│      ├─en
│      ├─zh_CN
│      └─zh_TW
│
└─tools
        convert-icons.py   # 產生不同尺寸圖示的工具
```

---

## 權限與隱私

* Manifest v3
* permissions: `scripting`, `tabs`
* host_permissions: `https://chat.openai.com/*`, `https://chatgpt.com/*`
* 僅在前端操作 DOM，不蒐集或上傳對話內容與個資。

---

## 開發

```bash
# 型別檢查
yarn typecheck

# 開發模式（watch）
yarn dev

# 產生發佈檔（dist/）
yarn build

# 壓縮打包 dist 為 zip
yarn zip
```

## 隱私權政策

本擴充功能尊重您的隱私權，不會收集任何個人資料。詳細資訊請參閱[隱私權政策](./PRIVACY.md)。

## 授權條款

[MIT License](../LICENSE)
