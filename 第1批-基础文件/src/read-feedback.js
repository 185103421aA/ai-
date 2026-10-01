// ============================================================
// 看意见：把观众从"意见信箱"里提交的意见，打印到这个黑窗口里
//
// 用法：双击 看意见.bat（等价于 node src\read-feedback.js）
//
// 【意见存在哪】data\feedback.jsonl —— 一行一条，记事本也能直接打开看
//   （但记事本里格式难看，所以有了这个文件：排好版、最新的排最前）。
//
// 【为什么读不出来也要照样打印】这份文件是"一条一条追加"写进去的，
//   正常情况下不会坏；万一最后一行写到一半断电了，也只坏那一行。
//   所以读不出来的行【不当成没发生】，原样打印出来让人自己看
//   —— 意见丢了比格式乱更要紧。
// ============================================================

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'data', 'feedback.jsonl');
const LINE = '────────────────────────────────────────────';

function two(n) { return String(n).padStart(2, '0'); }

function fmtTime(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso || '（没有记下时间）');
  return d.getFullYear() + '-' + two(d.getMonth() + 1) + '-' + two(d.getDate()) +
    ' ' + two(d.getHours()) + ':' + two(d.getMinutes());
}

function main() {
  console.log('');

  if (!fs.existsSync(FILE)) {
    console.log('【意见信箱】还没有人留过意见。');
    console.log('');
    console.log('想试一下：双击 启动网站.bat 打开网站，点右下角那个"意见信箱"，');
    console.log('随便写一句点"提交"，然后再双击一次本文件，那条意见就会出现在这里。');
    console.log('');
    console.log('（意见存的位置：' + FILE + '）');
    console.log('');
    return;
  }

  const raw = fs.readFileSync(FILE, 'utf8');
  const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);

  const good = [];
  const bad = [];
  for (const l of lines) {
    try {
      good.push(JSON.parse(l));
    } catch (e) {
      bad.push(l);
    }
  }

  console.log('【意见信箱】共 ' + good.length + ' 条' +
    (bad.length ? '（另有 ' + bad.length + ' 行读不出来，放在最后）' : '') +
    '　·　最新的排最前');
  console.log(LINE);

  if (!good.length && !bad.length) {
    console.log('');
    console.log('（文件在，但里面还没有内容。）');
  }

  // 最新的排最前：观众刚提交的那条一眼就能看见
  good.reverse();
  good.forEach((r, i) => {
    console.log('');
    console.log('第 ' + (i + 1) + ' 条　' + fmtTime(r.at));
    if (r.contact) console.log('  怎么联系他：' + r.contact);
    if (r.page) {
      console.log('  他当时在看：' + r.page + (r.viewport ? '（窗口 ' + r.viewport + '）' : ''));
    }
    console.log('  ······');
    const body = String(r.text || '（这条没有内容）');
    for (const line of body.split('\n')) console.log('  ' + line);
  });

  if (bad.length) {
    console.log('');
    console.log('【下面这些行读不出来】可能上次写的时候断电了。');
    console.log('内容原样贴出来，没有丢：');
    bad.forEach((l, i) => {
      console.log('');
      console.log('  ' + (i + 1) + ') ' + l);
    });
  }

  console.log('');
  console.log(LINE);
  console.log('原始文件（记事本也能打开）：' + FILE);
  console.log('');
}

main();
