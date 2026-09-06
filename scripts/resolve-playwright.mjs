// ESM 入口：与 scripts/resolve-playwright.cjs 同一解析逻辑（.mjs 测试脚本用）
import pw from './resolve-playwright.cjs';

export const { chromium } = pw;
export default pw;
