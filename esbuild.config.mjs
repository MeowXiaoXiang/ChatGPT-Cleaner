// esbuild.config.mjs
import { build, context } from "esbuild";
import { promises as fs } from "fs";
import path from "path";
import url from "url";
import { cyan, green, red, yellow, bold, gray } from "kleur/colors";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const isProd = process.env.NODE_ENV === "production";
const isWatch = process.env.WATCH === "1";
const outdir = path.resolve(__dirname, "dist");

// ---------- utils ----------
async function exists(p) {
	try {
		await fs.stat(p);
		return true;
	} catch {
		return false;
	}
}
async function rmrf(p) {
	try {
		await fs.rm(p, { recursive: true, force: true });
	} catch {}
}
function kb(n) {
	return (n / 1024).toFixed(1) + " KB";
}

// ---------- copy ----------
async function copyRecursive(src, dest) {
	const s = await fs.stat(src);
	if (s.isDirectory()) {
		await fs.mkdir(dest, { recursive: true });
		const entries = await fs.readdir(src);
		await Promise.all(
			entries.map((name) =>
				copyRecursive(path.join(src, name), path.join(dest, name))
			)
		);
	} else {
		await fs.mkdir(path.dirname(dest), { recursive: true });
		await fs.copyFile(src, dest);
	}
}

async function copyStatics() {
	const pairs = [
		["src/manifest.json", "dist/manifest.json"],
		["src/styles", "dist/styles"],
		["src/icons", "dist/icons"],
		["src/_locales", "dist/_locales"], // 唯一允許的底線資料夾
	];
	for (const [srcRel, destRel] of pairs) {
		const src = path.resolve(__dirname, srcRel);
		const dest = path.resolve(__dirname, destRel);
		if (await exists(src)) await copyRecursive(src, dest);
	}
	await writeBuildMeta();
	console.log(green("[copy-static] done"));
}

// ---------- build meta ----------
async function writeBuildMeta() {
	const pkg = JSON.parse(
		await fs.readFile(path.resolve(__dirname, "package.json"), "utf8")
	);
	const meta = {
		name: pkg.name,
		version: pkg.version,
		mode: isProd ? "production" : "development",
		builtAt: new Date().toISOString(),
	};
	await fs.mkdir(outdir, { recursive: true });
	await fs.writeFile(
		path.join(outdir, "build-info.json"),
		JSON.stringify(meta, null, 2),
		"utf8"
	);
}

// ---------- pretty print ----------
function printResult(result) {
	if (!result?.metafile) return;
	const outputs = Object.entries(result.metafile.outputs);
	const total = outputs.reduce((acc, [, o]) => acc + (o.bytes || 0), 0);
	const lines = outputs
		.filter(([file]) => file.startsWith(outdir))
		.map(
			([file, o]) =>
				` ${gray("•")} ${bold(path.basename(file))}: ${bold(
					kb(o.bytes || 0)
				)}`
		)
		.sort();

	const mode = isProd ? yellow("prod") : cyan("dev");
	console.log(
		`${bold("[build]")} ${mode} ${green("done")}. total: ${bold(
			kb(total)
		)}\n${lines.join("\n")}`
	);
}

// ---------- plugin：在每次 build/rebuild 結束後執行 ----------
const afterBuildPlugin = {
	name: "after-build",
	setup(buildApi) {
		buildApi.onEnd(async (result) => {
			if (result.errors?.length) {
				console.error(red("[build] failed with errors:"));
				result.errors.forEach((e) =>
					console.error(red(" -"), e.text || e)
				);
				return;
			}
			printResult(result);
			await copyStatics();
		});
	},
};

// ---------- esbuild base config ----------
const common = {
	entryPoints: {
		background: "src/background/background.ts",
		content: "src/content/main.ts",
	},
	outdir,
	bundle: true,
	minify: isProd,
	sourcemap: !isProd,
	target: ["es2023"],
	format: "iife",
	logLevel: "info",
	metafile: true,
	plugins: [afterBuildPlugin], // 用 onEnd 相容所有版本
};

// ---------- main ----------
if (isWatch) {
	await rmrf(outdir);
	const ctx = await context(common); // 建立 context
	await ctx.watch(); // 啟動 watch（初次也會觸發 onEnd）
	console.log(
		cyan(
			`[watch] building & watching… (${bold(
				isProd ? "production" : "development"
			)})`
		)
	);
} else {
	await rmrf(outdir);
	const result = await build(common).catch((err) => {
		console.error(red("[build] failed:"), err);
		process.exitCode = 1;
	});
	if (result) console.log(green("[build] complete"));
}
