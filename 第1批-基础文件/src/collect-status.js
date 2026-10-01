// ============================================================
// 采集结果记录（配合 collect.js 的两道"安全闸"使用）
//
// 【为什么需要这个文件】
//   采集有三种结局：顺利、部分数据源失败、一条都没采到。
//   后两种情况必须在网页上如实写出来，但网页是从
//   data\competitions.json 画出来的 —— 而"一条都没采到"时
//   那个文件【故意不写】（写了就把好数据覆盖坏了），
//   所以失败信息没法放在它里面，只能单独记一份。
//
//   记在这里的内容长这样（data\last-collect.json）：
//     status            : 'ok' | 'partial' | 'no_data'
//     at                : 本次采集的时间
//     keep_generated_at : 没采到时，页面上显示的那份数据是什么时候采的
//     failed_sources    : 失败的数据源和失败原因
//     retained_sources  : 半失败时，从上次数据里原样保留下来的是哪些源、几条
//     note              : 可选的补充说明（例如"备份没做成，为安全起见没覆盖"）
//
// 【重要】这个文件读不出来（没写过 / 内容坏了）时，readStatus() 返回 null，
//         网页就当"一切正常"来画 —— 绝不让这份记录影响网站能不能打开。
// ============================================================

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const STATUS_FILE = path.join(__dirname, '..', 'data', 'last-collect.json');

function readStatus() {
  try {
    const s = JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8'));
    return (s && typeof s === 'object') ? s : null;
  } catch (e) {
    return null;
  }
}

function writeStatus(status) {
  const tempFile = path.join(path.dirname(STATUS_FILE), '.last-collect.json.' + randomUUID() + '.tmp');
  let fd;
  try {
    fs.mkdirSync(path.dirname(STATUS_FILE), { recursive: true });
    fd = fs.openSync(tempFile, 'wx');
    fs.writeFileSync(fd, JSON.stringify(status, null, 2), 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tempFile, STATUS_FILE);
    return true;
  } catch (e) {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch (_) { /* 保留原始写入失败结果 */ }
    }
    try { if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile); } catch (_) { /* 稍后人工清理 */ }
    return false;
  }
}

module.exports = { STATUS_FILE, readStatus, writeStatus };
