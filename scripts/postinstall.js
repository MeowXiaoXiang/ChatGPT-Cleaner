// scripts/postinstall.js
import { execSync } from "node:child_process";

function run(cmd) {
	try {
		execSync(cmd, { stdio: "inherit" });
		return true;
	} catch (e) {
		console.error("忽略錯誤:", e?.message || e);
		return false;
	}
}

try {
	const ua = process.env.npm_config_user_agent || "";
	if (!ua.includes("yarn")) {
		console.log(
			"未偵測到 Yarn，跳過 VS Code SDK 設定。本專案官方使用 Yarn 4 + Corepack。"
		);
		process.exit(0);
	}

	const ver = execSync("yarn -v").toString().trim();
	if (ver.startsWith("1.")) {
		console.log(
			`偵測到 Yarn ${ver}，請改用 Corepack 啟用 package.json 指定的 Yarn 4。`
		);
		console.log("例如：corepack enable && corepack install");
		process.exit(0);
	}

	console.log(`Yarn ${ver} → 設定 VS Code SDK`);
	const ok = run("yarn dlx @yarnpkg/sdks vscode");
	if (!ok) {
		console.log("可稍後手動執行：yarn dlx @yarnpkg/sdks vscode");
	}
} catch (e) {
	console.error("postinstall 設定 VS Code SDK 失敗（可忽略）:", e?.message || e);
}
