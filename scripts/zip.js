// scripts/zip.js
import archiver from "archiver";
import { createWriteStream, promises as fs } from "fs";
import path from "path";
import url from "url";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const dist = path.join(root, "dist");

async function exists(p) {
	try {
		await fs.stat(p);
		return true;
	} catch {
		return false;
	}
}

async function main() {
	const pkg = JSON.parse(
		await fs.readFile(path.join(root, "package.json"), "utf8")
	);
	const ver = pkg.version || "0.0.0";

	// 確認 dist 存在
	if (!(await exists(dist))) {
		console.error("[zip] dist/ not found. Run `yarn build` first.");
		process.exit(1);
	}

	const outName = `chatgpt-cleaner-v${ver}.zip`;
	const outPath = path.join(root, outName);

	// 若已存在同名 zip，先刪除（OneDrive 偶爾鎖檔，retry 一次）
	if (await exists(outPath)) {
		console.log(`[zip] ${outName} already exists, removing...`);
		try {
			await fs.rm(outPath, { force: true });
		} catch {
			// 等 200ms 再試一次，避免 OneDrive 或防毒短暫占用
			await new Promise((r) => setTimeout(r, 200));
			await fs.rm(outPath, { force: true });
		}
	}

	console.log(`[zip] creating ${outName} from dist/ ...`);

	// 使用 archiver 壓縮 dist/ 內容（不包一層 dist 資料夾）
	await new Promise((resolve, reject) => {
		const output = createWriteStream(outPath);
		const archive = archiver("zip", { zlib: { level: 9 } });

		output.on("close", resolve);
		archive.on("error", reject);

		archive.pipe(output);
		// 將 dist/ 內容直接壓到 zip 根層
		archive.directory(dist, false);
		archive.finalize();
	});

	console.log(`[zip] done -> ${outPath}`);

	// 額外提示：顯示 zip 位於哪個資料夾（灰字）
	console.log(`[zip] location: ${path.dirname(outPath)}`);
}

main().catch((e) => {
	console.error("[zip] failed:", e);
	process.exit(1);
});
