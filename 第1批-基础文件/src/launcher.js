// ============================================================
// 双击用的"总开关"（由 .bat 文件调用）
//
// 【为什么要有这个文件】
//   .bat 里不能放中文（Windows 命令行会按本地编码读，中文会变乱码，
//   甚至被当成命令去执行）。所以 .bat 只保留纯英文骨架，负责找到
//   Node 并调用本文件；所有要对用户说的话，都在这里输出。
//
// 用法（由 .bat 自动调用，平时不用手敲）：
//   node src\launcher.js serve    ← 打开网站（没有网页文件就先采集）
//   node src\launcher.js update   ← 重新采集一次并重新生成网页
//   node src\launcher.js daily    ← 每日自动采集（常驻）
// ============================================================

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { pickLang, makeMessages } = require('./messages.js');
const { readStatus } = require('./collect-status.js');
// 网站名字只在 render.js 里写一次，这里引用它，避免两处名字对不上
const { SITE_NAME } = require('./render.js');

const ROOT = path.join(__dirname, '..');
const NODE = process.execPath;
const PAGE_FILE = path.join(ROOT, 'public', 'index.html');

const lang = pickLang();
const t = makeMessages(lang);

function run(scriptRelPath) {
  return new Promise(resolve => {
    const child = spawn(NODE, [path.join(ROOT, scriptRelPath)], { cwd: ROOT, stdio: 'inherit' });
    child.on('error', () => resolve(1));
    child.on('exit', code => resolve(code === null ? 1 : code));
  });
}

async function main() {
  const action = (process.argv[2] || 'serve').toLowerCase();

  // 自检：这几行中文如果显示成乱码，说明命令行窗口的编码没对上
  // （.bat 里已经执行了 chcp 65001，正常情况下应该是正常的）
  if (lang === 'zh') {
    console.log('============================================');
    console.log('  ' + SITE_NAME);
    console.log('============================================');
    console.log('');
  } else {
    console.log('============================================');
    console.log('  AI Competition Info Hub');
    console.log('============================================');
    console.log('');
  }

  if (action === 'update') {
    console.log('');
    console.log(t('updating'));
    console.log('');
    const startedAt = Date.now();
    const code = await run(path.join('src', 'collect.js'));
    console.log('');
    const st = readStatus();
    const current = st && Number.isFinite(Date.parse(st.at)) && Date.parse(st.at) >= startedAt;
    if (current && st.status === 'partial') {
      console.log(t('updatePartial'));
    } else if (code !== 0 || !current || st.status !== 'ok') {
      console.log(t('updateFail'));
    } else {
      console.log(t('updateOk'));
    }
    return code;
  }

  if (action === 'daily') {
    return await run(path.join('src', 'scheduler.js'));
  }

  // ---- serve：打开网站 ----
  // 已经有生成好的网页 → 直接开；没有 → 先采集（采集会自动生成网页）
  if (!fs.existsSync(PAGE_FILE)) {
    console.log('');
    console.log('[1/2] ' + t('collecting'));
    console.log('      ' + t('waiting'));
    console.log('');
    const code = await run(path.join('src', 'collect.js'));
    if (code !== 0) {
      console.log('');
      console.log(t('collectFailed'));
      console.log('');
    }
  }

  console.log('[2/2] ' + t('opening'));
  console.log('');
  console.log(t('serveHint'));
  console.log('');
  console.log(t('stopHint'));
  console.log(t('updateHint'));
  console.log(t('dailyHint'));
  console.log('');

  // 网站程序自己会和用户交互（Ctrl+C 停），所以直接接管终端
  return await run(path.join('src', 'server.js'));
}

main().then(code => { process.exitCode = code || 0; })
  .catch(e => {
    console.error('启动失败 / failed to start: ' + (e && e.message ? e.message : e));
    process.exitCode = 1;
  });
