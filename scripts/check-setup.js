#!/usr/bin/env node
/**
 * 构建期静态校验（npm run build 会自动执行）
 *
 * 1. app.js 中 setup() 的 return 块里导出的每个名字，必须在同一文件中有定义，
 *    否则运行时 setup 抛 ReferenceError，Vue 挂载失败会导致整页白屏。
 *    （历史上删除了某个 ref 却漏删 return 项，就是这样炸的）
 * 2. 模板里引用的标识符必须能从 setup 返回，或属于 v-for 迭代变量 / 内置关键字。
 * 3. 模板表达式必须是合法 JS（防止内联对象字面量等导致编译失败）。
 */

const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
const SRC_DIR = path.join(ROOT_DIR, 'src');
const APP_FILE = path.join(SRC_DIR, 'js', 'app.js');
const TEMPLATE_FILE = path.join(SRC_DIR, 'index.html');

const errors = [];

/* ---------------- 工具：括号配平取块 ---------------- */
function matchBrace(text, openIndex) {
  let depth = 0;
  for (let i = openIndex; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/* ---------------- 1. 校验 setup return ---------------- */
function checkSetupReturn() {
  const src = fs.readFileSync(APP_FILE, 'utf-8');

  // 只认「行首缩进的 return {」，排除 return { ... }[key] 之类的内联写法
  const retMatch = [...src.matchAll(/^[ \t]+return\s*\{/gm)].pop();
  if (!retMatch) {
    errors.push('app.js 中未找到 setup() 的 return 块');
    return new Set();
  }
  const openBrace = src.indexOf('{', retMatch.index);
  const closeBrace = matchBrace(src, openBrace);
  if (closeBrace === -1) {
    errors.push('setup() 的 return 块花括号不配平');
    return new Set();
  }
  const retObj = src.slice(openBrace, closeBrace + 1);

  // 只统计 return 块内部（去掉注释行）的 key
  const body = retObj
    .split('\n')
    .filter(line => !/^\s*\/\//.test(line))
    .join('\n');

  // 匹配 `name,` 或 `alias: name,`（不含函数表达式等复杂形式）
  const exported = new Set();
  for (const m of body.matchAll(/(?:^|[,{\s])([A-Za-z_$][\w$]*)\s*(?::\s*([A-Za-z_$][\w$]*))?\s*,/g)) {
    exported.add(m[1]);
  }

  // 文件内的声明：const / let / function / 解构
  const declared = new Set();
  for (const m of src.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) declared.add(m[1]);
  for (const m of src.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)/g)) declared.add(m[1]);
  for (const m of src.matchAll(/\bconst\s*\{([^}]*)\}\s*=/g)) {
    for (const part of m[1].split(',')) {
      const name = part.split(':').pop().trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) declared.add(name);
    }
  }
  for (const m of src.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g)) declared.add(m[1]);

  // 顶层 import 进来的名字
  for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from/g)) {
    for (const part of m[1].split(',')) {
      const name = part.split(/\s+as\s+/).pop().trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) declared.add(name);
    }
  }

  const missing = [...exported].filter(name => !declared.has(name));
  if (missing.length) {
    errors.push(
      `setup() return 中导出了未定义的名字（运行时会 ReferenceError 导致白屏）: ${missing.join(', ')}`
    );
  }
  return exported;
}

/* ---------------- 2/3. 校验模板表达式与标识符 ---------------- */
function checkTemplate(exported) {
  const html = fs.readFileSync(TEMPLATE_FILE, 'utf-8');

  const startIdx = html.indexOf('<div id="app"');
  if (startIdx === -1) {
    errors.push('index.html 中未找到 <div id="app">');
    return;
  }
  // 用 div 标签配平切出 #app
  let depth = 0;
  let end = -1;
  const tagRe = /<(\/?)div\b[^>]*?(\/?)>/g;
  tagRe.lastIndex = startIdx;
  let m;
  while ((m = tagRe.exec(html))) {
    if (m[2] === '/') continue;
    if (m[1] === '/') {
      depth--;
      if (depth === 0) { end = tagRe.lastIndex; break; }
    } else depth++;
  }
  if (end === -1) {
    errors.push('#app 的 <div> 标签不配平（会导致 Vue 挂载失败白屏）');
    return;
  }
  const template = html.slice(startIdx, end);

  // 收集表达式
  const exprs = new Set();
  for (const mm of template.matchAll(/\{\{([\s\S]*?)\}\}/g)) exprs.add(mm[1].trim());

  // 属性类绑定：:foo="expr" / v-bind:foo="expr" / v-if="expr" 等
  for (const mm of template.matchAll(
    /(?::|v-bind:|v-if=|v-else-if=|v-for=|v-show=|v-model[.\w]*=)"([^"]*)"/g
  )) exprs.add(mm[1].trim());

  // 事件绑定：@click="expr" / v-on:click="expr" / @mouseenter="expr"
  // 注意：这里必须取「值」而不是「事件名」，否则模板调用了未导出的方法也检查不出来
  for (const mm of template.matchAll(
    /(?:@|v-on:)[\w.:-]+="([^"]*)"/g
  )) {
    // 多个语句用 ; 分隔，逐个收集
    for (const stmt of mm[1].split(';')) {
      const t = stmt.trim();
      if (t) exprs.add(t);
    }
  }

  // v-for 迭代变量
  const loopVars = new Set();
  for (const mm of template.matchAll(/v-for="\s*\(?([^)"]*?)\)?\s+(?:in|of)\s+[^"]*"/g)) {
    for (const v of mm[1].split(',')) loopVars.add(v.trim());
  }
  for (const mm of template.matchAll(/#\w+="\s*([^"]*)"/g)) {
    for (const v of mm[1].split(/[{}:,]/)) {
      const t = v.trim();
      if (t) loopVars.add(t);
    }
  }

  const RESERVED = new Set([
    'true', 'false', 'null', 'undefined', 'in', 'of', 'if', 'else', 'return', 'new',
    'typeof', 'void', 'delete', 'instanceof', 'this', 'Math', 'Number', 'String',
    'Boolean', 'Array', 'Object', 'JSON', 'Date', 'console', 'window', 'parseInt',
    'parseFloat', 'isNaN', 'encodeURIComponent', 'decodeURIComponent', '$event',
    // $event 被标识符正则拆出的裸词，属于模板内置变量
    'event',
  ]);

  const used = new Set();
  for (const raw of exprs) {
    let expr = raw;
    const forMatch = expr.match(/^\(?([^)]*?)\)?\s+(?:in|of)\s+(.+)$/);
    if (forMatch) expr = forMatch[2];

    // 3. 必须是合法 JS 表达式
    try {
      // eslint-disable-next-line no-new-func
      new Function('return (' + expr.replace(/\$event/g, 'undefined') + ')');
    } catch (e) {
      errors.push(`模板表达式语法非法: "${raw}" → ${e.message}`);
    }

    // 2. 收集标识符（排除属性访问 .foo 与对象字面量 key）
    const cleaned = expr
      .replace(/\.\s*[A-Za-z_$][\w$]*/g, '')       // 属性访问
      .replace(/'[^']*'|"[^"]*"|`[^`]*`/g, '')     // 字符串
      .replace(/\{[^{}]*\}/g, '')                  // 对象字面量整体
      .replace(/\[[^\]]*\]/g, '');                 // 计算属性
    for (const w of cleaned.matchAll(/\b([A-Za-z_$][\w$]*)\b/g)) used.add(w[1]);
  }

  const missing = [...used].filter(
    x => !RESERVED.has(x) && !loopVars.has(x) && !exported.has(x)
  );
  if (missing.length) {
    errors.push(`模板引用了 setup() 未提供的名字: ${missing.join(', ')}`);
  }
}

/* ---------------- 执行 ---------------- */
const exported = checkSetupReturn();
checkTemplate(exported || new Set());

if (errors.length) {
  console.error('\n❌ 静态校验未通过：');
  errors.forEach(e => console.error('  - ' + e));
  console.error('\n提示：这类问题会在运行时报 ReferenceError 并导致整页白屏。\n');
  process.exit(1);
}
console.log('✅ 静态校验通过（setup 导出项 / 模板表达式 / 模板标识符）');
