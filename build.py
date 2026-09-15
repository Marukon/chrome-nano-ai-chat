#!/usr/bin/env python3
"""
Chrome Nano AI Chat - 静态资源随机哈希构建器
防止 EdgeOne 等 CDN 节点对 js/css 的 30 天强缓存，每次构建生成全新文件名并重写引用。
"""

import sys
import os
import re
import glob
import secrets
import json
from datetime import datetime

# 确保在 Windows 控制台输出 utf-8 编码
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')

ROOT_DIR = os.path.dirname(os.path.abspath(__file__))
SRC_DIR = os.path.join(ROOT_DIR, 'src')
ASSETS_DIR = os.path.join(ROOT_DIR, 'assets')
CSS_DIR = os.path.join(ASSETS_DIR, 'css')
JS_DIR = os.path.join(ASSETS_DIR, 'js')

def clean_old_build_assets():
    """清理 assets/css 与 assets/js 目录下的历史构建产物"""
    print("[Clean] 清理旧版本静态构建文件...")
    for pattern in [os.path.join(CSS_DIR, '*.css'), os.path.join(JS_DIR, '*.js')]:
        for filepath in glob.glob(pattern):
            try:
                os.remove(filepath)
                print(f"   已清理: {os.path.relpath(filepath, ROOT_DIR)}")
            except Exception as e:
                print(f"   清理失败 {filepath}: {e}")

def build():
    # 1. 生成 8 字符的唯一随机哈希
    build_hash = secrets.token_hex(4)
    timestamp = datetime.now().isoformat()
    print(f"[Build] 开始构建: 随机哈希标识 [{build_hash}]")

    os.makedirs(CSS_DIR, exist_ok=True)
    os.makedirs(JS_DIR, exist_ok=True)

    # 2. 清理旧产物
    clean_old_build_assets()

    # 3. 处理 CSS
    src_css_path = os.path.join(SRC_DIR, 'css', 'style.css')
    with open(src_css_path, 'r', encoding='utf-8') as f:
        css_content = f.read()
    
    out_css_name = f"style.{build_hash}.css"
    out_css_path = os.path.join(CSS_DIR, out_css_name)
    with open(out_css_path, 'w', encoding='utf-8') as f:
        f.write(css_content)
    print(f"[OK] 生成样式表: assets/css/{out_css_name}")

    # 4. 处理 JS 独立模块
    modules = {
        'chrome-ai.js': f'chrome-ai.{build_hash}.js',
        'presets.js': f'presets.{build_hash}.js',
        'storage.js': f'storage.{build_hash}.js'
    }

    for src_name, out_name in modules.items():
        src_path = os.path.join(SRC_DIR, 'js', src_name)
        out_path = os.path.join(JS_DIR, out_name)
        with open(src_path, 'r', encoding='utf-8') as f:
            content = f.read()
        with open(out_path, 'w', encoding='utf-8') as f:
            f.write(content)
        print(f"[OK] 生成模块: assets/js/{out_name}")

    # 5. 处理主入口 app.js 并重写模块 import 路径
    src_app_path = os.path.join(SRC_DIR, 'js', 'app.js')
    with open(src_app_path, 'r', encoding='utf-8') as f:
        app_content = f.read()

    # 替换内部相对模块引用为最新的哈希文件
    app_content = re.sub(r"(['\"])\./chrome-ai(\.[a-zA-Z0-9_-]+)?\.js\1", f"'./{modules['chrome-ai.js']}'", app_content)
    app_content = re.sub(r"(['\"])\./presets(\.[a-zA-Z0-9_-]+)?\.js\1", f"'./{modules['presets.js']}'", app_content)
    app_content = re.sub(r"(['\"])\./storage(\.[a-zA-Z0-9_-]+)?\.js\1", f"'./{modules['storage.js']}'", app_content)

    out_app_name = f"app.{build_hash}.js"
    out_app_path = os.path.join(JS_DIR, out_app_name)
    with open(out_app_path, 'w', encoding='utf-8') as f:
        f.write(app_content)
    print(f"[OK] 生成主程序: assets/js/{out_app_name}")

    # 6. 处理根入口 index.html
    src_html_path = os.path.join(SRC_DIR, 'index.html')
    with open(src_html_path, 'r', encoding='utf-8') as f:
        html_content = f.read()

    # 替换样式表外链
    html_content = re.sub(
        r'href=["\']\./assets/css/style(\.[a-zA-Z0-9_-]+)?\.css["\']',
        f'href="./assets/css/{out_css_name}"',
        html_content
    )

    # 替换主程序外链
    html_content = re.sub(
        r'src=["\']\./assets/js/app(\.[a-zA-Z0-9_-]+)?\.js["\']',
        f'src="./assets/js/{out_app_name}"',
        html_content
    )

    out_html_path = os.path.join(ROOT_DIR, 'index.html')
    with open(out_html_path, 'w', encoding='utf-8') as f:
        f.write(html_content)
    print(f"[OK] 更新入口文件: index.html -> 引用 {out_css_name} & {out_app_name}")

    # 7. 生成版本清单 manifest.json
    manifest = {
        "buildHash": build_hash,
        "builtAt": timestamp,
        "files": {
            "style.css": out_css_name,
            "app.js": out_app_name,
            "chrome-ai.js": modules['chrome-ai.js'],
            "presets.js": modules['presets.js'],
            "storage.js": modules['storage.js']
        }
    }
    manifest_path = os.path.join(ASSETS_DIR, 'manifest.json')
    with open(manifest_path, 'w', encoding='utf-8') as f:
        json.dump(manifest, f, indent=2, ensure_ascii=False)
    print(f"[OK] 生成版本清单: assets/manifest.json")

    print(f"\n[Done] 构建完成！所有业务 JS/CSS 文件已更新为全新随机文件名，EdgeOne 缓存将立即失效！")

if __name__ == '__main__':
    build()
