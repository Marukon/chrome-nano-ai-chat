#!/usr/bin/env node
/**
 * Chrome Nano AI Chat - 静态资源版本化构建器 (Node.js, 零第三方依赖)
 *
 * 产物命名规则：<name>.v<package.version>.<8位随机哈希>.<ext>
 *   例：style.v1.1.0.3f9a2c1b.css / app.v1.1.0.3f9a2c1b.js
 *   - 版本号来自 package.json，便于线上排查与回滚定位；
 *   - 随机哈希保证每次构建文件名都不同，彻底击穿 EdgeOne / CDN 的 30 天强缓存。
 *
 * 用法：
 *   npm run build            # 构建
 *   npm run clean            # 仅清理构建产物
 *   node scripts/build.js    # 等价直接调用
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT_DIR = path.resolve(__dirname, '..');
const SRC_DIR = path.join(ROOT_DIR, 'src');
const ASSETS_DIR = path.join(ROOT_DIR, 'assets');
const CSS_DIR = path.join(ASSETS_DIR, 'css');
const JS_DIR = path.join(ASSETS_DIR, 'js');
const ENTRY_HTML = path.join(ROOT_DIR, 'index.html');
const MANIFEST = path.join(ASSETS_DIR, 'manifest.json');

/** 读取并清洗版本号，确保可安全用于文件名 */
function readVersion() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf-8'));
  const raw = String(pkg.version || '0.0.0');
  const safe = raw.replace(/[^a-zA-Z0-9._-]/g, '-');
  return safe.startsWith('v') ? safe : `v${safe}`;
}

function cleanDir(dir, ext) {
  if (!fs.existsSync(dir)) return;
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith(ext)) continue;
    const fullPath = path.join(dir, file);
    try {
      fs.unlinkSync(fullPath);
      console.log(`   已清理: ${path.relative(ROOT_DIR, fullPath)}`);
    } catch (e) {
      console.warn(`   清理失败 ${fullPath}: ${e.message}`);
    }
  }
}

/** 根目录下由构建复制生成的静态图标 */
const COPY_ASSETS = ['favicon.ico', 'apple-touch-icon.png'];

/** 清理历史构建产物（旧的哈希文件会被永久遗留，必须每次清空） */
function cleanOldBuildAssets() {
  console.log('🧹 清理旧版本构建产物...');
  cleanDir(CSS_DIR, '.css');
  cleanDir(JS_DIR, '.js');
  if (fs.existsSync(MANIFEST)) {
    fs.unlinkSync(MANIFEST);
    console.log(`   已清理: ${path.relative(ROOT_DIR, MANIFEST)}`);
  }
  for (const name of COPY_ASSETS) {
    const target = path.join(ROOT_DIR, name);
    if (fs.existsSync(target)) {
      fs.unlinkSync(target);
      console.log(`   已清理: ${name}`);
    }
  }
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

  cleanOldBuildAssets();

  // ---------- 1. CSS ----------
  const outCssName = `style.${versionTag}.css`;
  write(path.join(CSS_DIR, outCssName), read(path.join(SRC_DIR, 'css', 'style.css')));
  console.log(`✅ 样式表: assets/css/${outCssName}`);

  // ---------- 2. 独立 JS 模块 ----------
  const modules = {
    'chrome-ai.js': `chrome-ai.${versionTag}.js`,
    'presets.js': `presets.${versionTag}.js`,
    'storage.js': `storage.${versionTag}.js`,
  };
  for (const [srcName, outName] of Object.entries(modules)) {
    write(path.join(JS_DIR, outName), read(path.join(SRC_DIR, 'js', srcName)));
    console.log(`✅ 模块: assets/js/${outName}`);
  }

  // ---------- 3. 主程序 app.js（重写内部 ES 模块导入路径） ----------
  let appContent = read(path.join(SRC_DIR, 'js', 'app.js'));
  for (const [srcName, outName] of Object.entries(modules)) {
    const base = srcName.replace(/\.js$/, '');
    // 兼容形如 './chrome-ai.js' / './chrome-ai.<任意版本>.js'
    appContent = appContent.replace(
      new RegExp(`(['"])\\./${base}[^'"]*\\.js\\1`, 'g'),
      `'./${outName}'`
    );
  }
  const outAppName = `app.${versionTag}.js`;
  write(path.join(JS_DIR, outAppName), appContent);
  console.log(`✅ 主程序: assets/js/${outAppName}`);

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
  console.log(`✅ 入口文件: index.html ➔ ${outCssName} & ${outAppName}`);

  // ---------- 4.5 复制站点图标到根目录 ----------
  for (const name of COPY_ASSETS) {
    const src = path.join(SRC_DIR, name);
    if (!fs.existsSync(src)) {
      console.warn(`⚠️ 缺少 ${name}，跳过复制`);
      continue;
    }
    fs.copyFileSync(src, path.join(ROOT_DIR, name));
    console.log(`✅ 图标: ${name}`);
  }

  // ---------- 5. 版本清单 ----------
  write(MANIFEST, JSON.stringify({
    version,
    buildHash,
    versionTag,
    builtAt,
    files: {
      'style.css': outCssName,
      'app.js': outAppName,
      'chrome-ai.js': modules['chrome-ai.js'],
      'presets.js': modules['presets.js'],
      'storage.js': modules['storage.js'],
      'favicon.ico': 'favicon.ico',
      'apple-touch-icon.png': 'apple-touch-icon.png',
    },
  }, null, 2) + '\n');
  console.log(`✅ 版本清单: assets/manifest.json`);

  console.log(`\n🎉 构建完成！文件名已带版本号 ${version}，CDN 旧缓存将立即失效。`);
}

const args = process.argv.slice(2);
if (args.includes('--clean')) {
  cleanOldBuildAssets();
  console.log('✨ 仅清理完成（未构建）。');
} else {
  build();
}
