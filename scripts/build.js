#!/usr/bin/env node
/**
 * Chrome Nano AI Chat - 静态资源版本化构建器 (Node.js, 零第三方依赖)
 *
 * 产物命名规则：<name>.v<package.version>.<8位随机哈希>.<ext>
 *   例：style.v1.1.0.3f9a2c1b.css / app.v1.1.0.3f9a2c1b.js
 *   - 版本号来自 package.json，便于线上排查与回滚定位；
 *   - 随机哈希保证每次构建文件名都不同，彻底击穿 CDN 的强缓存。
 *
 * 输出目录：dist/（自包含，可直接托管）
 *   dist/index.html
 *   dist/favicon.ico、dist/apple-touch-icon.png
 *   dist/assets/css/style.<版本>.css
 *   dist/assets/js/*.js
 *   dist/assets/vendor/**  (从 assets/vendor 复制)
 *   dist/assets/manifest.json
 *
 * 用法：
 *   npm run build            # 构建到 dist/
 *   npm run clean            # 仅清理 dist/
 *   node scripts/build.js    # 等价直接调用
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT_DIR = path.resolve(__dirname, '..');
const SRC_DIR = path.join(ROOT_DIR, 'src');
const ASSETS_DIR = path.join(ROOT_DIR, 'assets');
const VENDOR_DIR = path.join(ASSETS_DIR, 'vendor');

const DIST_DIR = path.join(ROOT_DIR, 'dist');
const DIST_ASSETS_DIR = path.join(DIST_DIR, 'assets');
const DIST_CSS_DIR = path.join(DIST_ASSETS_DIR, 'css');
const DIST_JS_DIR = path.join(DIST_ASSETS_DIR, 'js');
const ENTRY_HTML = path.join(DIST_DIR, 'index.html');
const MANIFEST = path.join(DIST_ASSETS_DIR, 'manifest.json');

/** 从 src/ 复制到 dist/ 根目录的站点图标 */
const COPY_ASSETS = ['favicon.ico', 'apple-touch-icon.png'];

/** 读取并清洗版本号，确保可安全用于文件名 */
function readVersion() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf-8'));
  const raw = String(pkg.version || '0.0.0');
  const safe = raw.replace(/[^a-zA-Z0-9._-]/g, '-');
  return safe.startsWith('v') ? safe : `v${safe}`;
}

function removeDir(dir) {
  if (!fs.existsSync(dir)) return;
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`   已清理: ${path.relative(ROOT_DIR, dir)}/`);
}

/** 递归复制目录 */
function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const srcPath = path.join(from, entry.name);
    const destPath = path.join(to, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/** 清理构建产物 */
function cleanBuild() {
  console.log('🧹 清理构建产物...');
  removeDir(DIST_DIR);
}

function read(file) {
  return fs.readFileSync(file, 'utf-8');
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf-8');
}

function build() {
  const version = readVersion();
  const buildHash = crypto.randomBytes(4).toString('hex'); // 8 位随机哈希
  const versionTag = `${version}.${buildHash}`;
  const builtAt = new Date().toISOString();

  console.log(`⚡ 开始构建  [版本 ${version}]  [哈希 ${buildHash}]`);

  cleanBuild();

  // ---------- 1. CSS ----------
  const outCssName = `style.${versionTag}.css`;
  write(path.join(DIST_CSS_DIR, outCssName), read(path.join(SRC_DIR, 'css', 'style.css')));
  console.log(`✅ 样式表: dist/assets/css/${outCssName}`);

  // ---------- 2. 独立 JS 模块 ----------
  const modules = {
    'chrome-ai.js': `chrome-ai.${versionTag}.js`,
    'presets.js': `presets.${versionTag}.js`,
    'storage.js': `storage.${versionTag}.js`,
  };
  for (const [srcName, outName] of Object.entries(modules)) {
    write(path.join(DIST_JS_DIR, outName), read(path.join(SRC_DIR, 'js', srcName)));
    console.log(`✅ 模块: dist/assets/js/${outName}`);
  }

  // ---------- 3. 主程序 app.js ----------
  const outAppName = `app.${versionTag}.js`;
  write(path.join(DIST_JS_DIR, outAppName), read(path.join(SRC_DIR, 'js', 'app.js')));
  console.log(`✅ 主程序: dist/assets/js/${outAppName}`);

  // ---------- 3.5 统一重写模块间引用（含 storage.js → presets.js） ----------
  for (const outName of [...Object.values(modules), outAppName]) {
    const filePath = path.join(DIST_JS_DIR, outName);
    let content = read(filePath);
    for (const [srcName, modOut] of Object.entries(modules)) {
      const base = srcName.replace(/\.js$/, '');
      // 兼容形如 './chrome-ai.js' / './chrome-ai.<任意版本>.js'
      content = content.replace(
        new RegExp(`(['"])\\./${base}[^'"]*\\.js\\1`, 'g'),
        `'./${modOut}'`
      );
    }
    write(filePath, content);
  }
  console.log(`✅ 模块引用重写完成`);

  // ---------- 4. 入口 index.html（重写外链） ----------
  let htmlContent = read(path.join(SRC_DIR, 'index.html'));
  htmlContent = htmlContent
    .replace(
      /href=["']\.\/assets\/css\/style[^"']*\.css["']/g,
      `href="./assets/css/${outCssName}"`
    )
    .replace(
      /src=["']\.\/assets\/js\/app[^"']*\.js["']/g,
      `src="./assets/js/${outAppName}"`
    );
  write(ENTRY_HTML, htmlContent);
  console.log(`✅ 入口文件: dist/index.html`);

  // ---------- 5. 站点图标 ----------
  for (const name of COPY_ASSETS) {
    const src = path.join(SRC_DIR, name);
    if (!fs.existsSync(src)) {
      console.warn(`⚠️ 缺少 ${name}，跳过复制`);
      continue;
    }
    fs.copyFileSync(src, path.join(DIST_DIR, name));
    console.log(`✅ 图标: dist/${name}`);
  }

  // ---------- 6. 复制本地自托管依赖 (Vue / marked / KaTeX / highlight.js) ----------
  if (fs.existsSync(VENDOR_DIR)) {
    copyDir(VENDOR_DIR, path.join(DIST_ASSETS_DIR, 'vendor'));
    console.log(`✅ 依赖库: dist/assets/vendor/`);
  } else {
    console.warn(`⚠️ 未找到 assets/vendor/，dist 将缺少依赖库`);
  }

  // ---------- 7. 版本清单 ----------
  write(MANIFEST, JSON.stringify({
    version,
    buildHash,
    versionTag,
    builtAt,
    outputDir: 'dist',
    files: {
      'index.html': 'index.html',
      'style.css': `assets/css/${outCssName}`,
      'app.js': `assets/js/${outAppName}`,
      'chrome-ai.js': `assets/js/${modules['chrome-ai.js']}`,
      'presets.js': `assets/js/${modules['presets.js']}`,
      'storage.js': `assets/js/${modules['storage.js']}`,
      'favicon.ico': 'favicon.ico',
      'apple-touch-icon.png': 'apple-touch-icon.png',
    },
  }, null, 2) + '\n');
  console.log(`✅ 版本清单: dist/assets/manifest.json`);

  console.log(`\n🎉 构建完成！输出目录 dist/ ，可直接托管。`);
}

const args = process.argv.slice(2);
if (args.includes('--clean')) {
  cleanBuild();
  console.log('✨ 仅清理完成（未构建）。');
} else {
  build();
}
