/**
 * Chrome Nano AI Chat - 静态资源随机哈希构建器 (Node.js 跨平台版本)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT_DIR = path.resolve(__dirname, '..');
const SRC_DIR = path.join(ROOT_DIR, 'src');
const ASSETS_DIR = path.join(ROOT_DIR, 'assets');
const CSS_DIR = path.join(ASSETS_DIR, 'css');
const JS_DIR = path.join(ASSETS_DIR, 'js');

function cleanOldBuildAssets() {
  console.log('🧹 清理旧版本静态构建文件...');
  const cleanDir = (dir, ext) => {
    if (!fs.existsSync(dir)) return;
    const files = fs.readdirSync(dir);
    for (const file of files) {
      if (file.endsWith(ext)) {
        const fullPath = path.join(dir, file);
        try {
          fs.unlinkSync(fullPath);
          console.log(`   已清理: ${path.relative(ROOT_DIR, fullPath)}`);
        } catch (e) {
          console.error(`   清理失败 ${fullPath}:`, e.message);
        }
      }
    }
  };
  cleanDir(CSS_DIR, '.css');
  cleanDir(JS_DIR, '.js');
}

function build() {
  const buildHash = crypto.randomBytes(4).toString('hex');
  const timestamp = new Date().toISOString();
  console.log(`⚡ 开始构建: 随机哈希标识 [${buildHash}]`);

  if (!fs.existsSync(CSS_DIR)) fs.mkdirSync(CSS_DIR, { recursive: true });
  if (!fs.existsSync(JS_DIR)) fs.mkdirSync(JS_DIR, { recursive: true });

  cleanOldBuildAssets();

  // 1. CSS
  const srcCssPath = path.join(SRC_DIR, 'css', 'style.css');
  const cssContent = fs.readFileSync(srcCssPath, 'utf-8');
  const outCssName = `style.${buildHash}.css`;
  fs.writeFileSync(path.join(CSS_DIR, outCssName), cssContent, 'utf-8');
  console.log(`✅ 生成样式表: assets/css/${outCssName}`);

  // 2. JS 模块
  const modules = {
    'chrome-ai.js': `chrome-ai.${buildHash}.js`,
    'presets.js': `presets.${buildHash}.js`,
    'storage.js': `storage.${buildHash}.js`,
  };

  for (const [srcName, outName] of Object.entries(modules)) {
    const srcPath = path.join(SRC_DIR, 'js', srcName);
    const content = fs.readFileSync(srcPath, 'utf-8');
    fs.writeFileSync(path.join(JS_DIR, outName), content, 'utf-8');
    console.log(`✅ 生成模块: assets/js/${outName}`);
  }

  // 3. 主程序 app.js
  const srcAppPath = path.join(SRC_DIR, 'js', 'app.js');
  let appContent = fs.readFileSync(srcAppPath, 'utf-8');
  appContent = appContent
    .replace(/(['"])\.\/chrome-ai(\.[a-zA-Z0-9_-]+)?\.js\1/g, `'./${modules['chrome-ai.js']}'`)
    .replace(/(['"])\.\/presets(\.[a-zA-Z0-9_-]+)?\.js\1/g, `'./${modules['presets.js']}'`)
    .replace(/(['"])\.\/storage(\.[a-zA-Z0-9_-]+)?\.js\1/g, `'./${modules['storage.js']}'`);

  const outAppName = `app.${buildHash}.js`;
  fs.writeFileSync(path.join(JS_DIR, outAppName), appContent, 'utf-8');
  console.log(`✅ 生成主程序: assets/js/${outAppName}`);

  // 4. 入口 index.html
  const srcHtmlPath = path.join(SRC_DIR, 'index.html');
  let htmlContent = fs.readFileSync(srcHtmlPath, 'utf-8');
  htmlContent = htmlContent
    .replace(/href=["']\.\/assets\/css\/style(\.[a-zA-Z0-9_-]+)?\.css["']/g, `href="./assets/css/${outCssName}"`)
    .replace(/src=["']\.\/assets\/js\/app(\.[a-zA-Z0-9_-]+)?\.js["']/g, `src="./assets/js/${outAppName}"`);

  fs.writeFileSync(path.join(ROOT_DIR, 'index.html'), htmlContent, 'utf-8');
  console.log(`✅ 更新入口文件: index.html ➔ 引用 ${outCssName} & ${outAppName}`);

  // 5. 版本清单 manifest.json
  const manifest = {
    buildHash,
    builtAt: timestamp,
    files: {
      'style.css': outCssName,
      'app.js': outAppName,
      'chrome-ai.js': modules['chrome-ai.js'],
      'presets.js': modules['presets.js'],
      'storage.js': modules['storage.js'],
    },
  };
  fs.writeFileSync(path.join(ASSETS_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8');
  console.log(`✅ 生成版本清单: assets/manifest.json`);

  console.log(`\n🎉 构建完成！所有业务 JS/CSS 文件已更新为全新随机文件名，EdgeOne 缓存将立即失效！`);
}

build();
