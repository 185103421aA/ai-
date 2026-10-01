// ============================================================
// 每日自动采集：让电脑在每天凌晨自动去官网取一次最新数据，
//               取完自动重新生成网页文件（public/index.html）
//
// 【设计取舍，说明给以后接手的人】
//   1. 为什么用"常驻小程序"而不是系统计划任务？
//      Windows 的 schtasks 命令经常需要管理员权限，用户是不懂编程的人，
//      一旦失败会卡住。这个做法只用 Node 自己，双击就能跑，不需要任何权限，
//      也不往系统里写任何东西（用的是相对路径，不写死盘符）。
//      代价：得开着这个窗口；电脑关机/重启后要重新双击一次。
//      在"上线版"里，这项工作会交给服务器自己的定时任务（cron），
//      这个脚本就只用于本机测试。
//   2. 每天只跑一次，时间默认凌晨 3:00，可用环境变量改：
//         set COLLECT_AT=04:30 && node src\scheduler.js
//   3. 采集本身失败【不会】退出程序，它会等到第二天再试。
//      每次跑的结果都会追加记录到 data\collect-log.txt。
// ============================================================

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { readStatus } = require('./collect-status.js');

const COLLECT_AT = process.env.COLLECT_AT || '03:00';
const LOG_FILE = path.join(__dirname, '..', 'data', 'collect-log.txt');
const COLLECT_SCRIPT = path.join(__dirname, 'collect.js');
const NODE_EXE = process.execPath; // 正在跑本程序的这个 node，路径不会写错

function stamp() {
  return new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
}

function writeLog(line) {
  const text = '[' + stamp() + '] ' + line + '\r\n';
  process.stdout.write(text);
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, text, 'utf8');
  } catch (e) {
    // 日志写不进去也不能让采集停摆
    process.stdout.write('（日志文件写不进去：' + e.message + '）\r\n');
  }
}

// 算出"下一个 HH:MM"距离现在还有多少毫秒
function msUntilNext(hhmm) {
  const m = String(hhmm).match(/^(\d{1,2}):(\d{2})$/);
  if (!m) throw new Error('时间格式不对：' + hhmm + '（应该像 03:00 这样）');
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) throw new Error('时间超出范围：' + hhmm);

  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

function runCollect() {
  return new Promise(resolve => {
    writeLog('开始采集...');
    const startedAt = Date.now();
    const child = spawn(NODE_EXE, [COLLECT_SCRIPT], { cwd: path.join(__dirname, '..'), stdio: 'inherit' });
    child.on('error', err => {
      writeLog('采集程序起不来：' + err.message);
      resolve(false);
    });
    child.on('exit', code => {
      const st = readStatus();
      const current = st && Number.isFinite(Date.parse(st.at)) && Date.parse(st.at) >= startedAt;
      if (current && st.status === 'partial') {
        const names = (st.failed_sources || []).map(s => s.source_name).join('、');
        const kept = st.retained_sources || [];
        writeLog('采集完成，但有数据源没成功：' + (names || '（原因见网页顶部）'));
        if (kept.length > 0) {
          writeLog('  这些源仍显示上一次采到的数据：' +
                   kept.map(k => k.source_name + '(' + k.count + ' 条)').join('、'));
        }
        writeLog('  网页顶部也写明了这件事，卡片上标了"这条是上次的数据"。');
        resolve(false);
      } else if (code === 0 && current && st.status === 'ok') {
        writeLog('采集完成 ✔（数据已更新，网页文件已重新生成）');
        resolve(true);
      } else {
        if (current && st.status === 'no_data') {
          writeLog('采集没跑成功（退出码 ' + code + '）：这次一条都没采到，' +
                   '【已有的数据没有被覆盖】，网站仍显示上一次的内容。');
        } else {
          writeLog('采集没跑成功（退出码 ' + code + '，状态未确认或未完整更新）——请检查采集日志，明天再试。');
        }
        resolve(false);
      }
    });
  });
}

async function main() {
  // 启动时先校验一下用户填的时间对不对，免得白等一整天
  msUntilNext(COLLECT_AT);

  writeLog('每日自动采集已启动。每天 ' + COLLECT_AT + ' 自动跑一次。');
  writeLog('日志文件：' + LOG_FILE);
  writeLog('想停止：关掉这个窗口，或按 Ctrl+C。');

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const wait = msUntilNext(COLLECT_AT);
    const at = new Date(Date.now() + wait);
    writeLog('下一次采集时间：' + at.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) +
             '（还有 ' + Math.round(wait / 60000) + ' 分钟）');

    await new Promise(r => setTimeout(r, wait));
    await runCollect();
    // 采集完稍微歇一下，避免在同一分钟内反复触发
    await new Promise(r => setTimeout(r, 60000));
  }
}

main().catch(e => {
  writeLog('定时程序出错，退出了：' + (e && e.message ? e.message : e));
  process.exitCode = 1;
});
