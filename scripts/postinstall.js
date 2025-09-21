// scripts/postinstall.mjs
import { execSync } from "node:child_process";

function run(cmd) {
  try {
    execSync(cmd, { stdio: "inherit" });
  } catch (e) {
    console.error("忽略錯誤:", e?.message || e);
  }
}

try {
  const ua = process.env.npm_config_user_agent || "";
  if (!ua.includes("yarn")) {
    console.log("偵測到非 Yarn（npm/pnpm），跳過 VSCode sdks 設定");
    process.exit(0);
  }

  const ver = execSync("yarn -v").toString().trim();
  if (!ver.startsWith("1.")) {
    console.log(`Yarn ${ver} → 執行 sdks 設定`);
    run("yarn dlx @yarnpkg/sdks vscode");
  } else {
    console.log("Yarn 1.x → 跳過 VSCode sdks 設定");
  }
} catch (e) {
  console.error("postinstall 檢查 Yarn 版本失敗（可忽略）:", e?.message || e);
}
