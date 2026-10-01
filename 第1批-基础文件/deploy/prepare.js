// ============================================================
// 上线准备（一键做三件事）
//
// 用法：node deploy\prepare.js
//   （平时双击项目根目录的 上线准备.bat，它会调用这个文件）
//
// 【三件事，按顺序】
//   第 1 步：按当前数据重新画一遍网页（不动数据、不联网、几秒钟）
//            —— 这一步是给"刚填了备案号"准备的：填完必须重画，号码才会出现在页面上。
//   第 2 步：打包成 1 个 zip（deploy\pack.js），放到 deploy\dist\
//            ★ 打完包它会自己复验一遍：把包里每个文件解出来和 public\ 逐字节比，
//              再核对清单上写的指纹/大小。对不上就把包撤掉，绝不留给人上传。
//   第 3 步：上线前自检（deploy\preflight.js），把该看的一次看完
//
// 【★ 2026-09-16 晚为什么把"打包"挪到"自检"前面】
//   因为自检里新加了一条"dist\ 里的包和现在的网页是不是一回事"。
//   如果还按老顺序（重画 → 自检 → 打包），自检看到的永远是【上一次】那个包，
//   于是每次都会报"包过时了"—— 那是个假警报，会把真警报淹掉。
//   改成先打包再自检之后，自检审的是【这一次真正做出来的产物】，结论才有意义。
//   （"先重画再打包"这条规矩没有变：重画仍然是第 1 步。）
//
// 【注意】它不会去网上采集新数据 —— 想取最新数据先双击 更新数据.bat，再双击这个。
//         两个动作分开，是故意的：万一采集失败，你也不会把旧数据当成新数据传上去。
// ============================================================

const build = require('../src/build.js');
const { runPreflight } = require('./preflight.js');
const { pack } = require('./pack.js');

async function main() {
  console.log('============================================');
  console.log('  上线准备（重画网页 → 打包 → 自检）');
  console.log('============================================');

  console.log('');
  console.log('【第 1 步】按当前数据重新画一遍网页（不动数据、不联网）');
  const r = build.build({ log: m => console.log('  ' + m) });
  if (r.skipped) {
    console.log('  ⚠ 数据文件这次读不出来，所以【没有重画网页】——下面打的包还是上一次做好那批，');
    console.log('    里面不含任何"新"内容，也不会把好网页冲坏。修好数据（双击 更新数据.bat）再跑一次。');
  }

  console.log('');
  console.log('【第 2 步】打包');
  const p = await pack();

  console.log('');
  console.log('【第 3 步】上线前自检');
  const pre = runPreflight();

  console.log('');
  console.log('【结束】');
  if (pre.verdict === 'ready' && p.ok) {
    console.log('  ✔ 一切就绪：deploy\\dist\\' + p.name + ' 就是可以传上去的那一个文件。');
    console.log('     下一步照着 deploy\\上线清单.md 里的步骤做（宝塔上传 → 解压 → 解析域名 → 申请证书）。');
  } else if (pre.verdict === 'not-ready' && p.ok) {
    console.log('  ⚠ 包已经打好（deploy\\dist\\' + p.name + '），但【现在还不能开站】：' +
      (pre.beianReady ? '见上面 ✘ 的行' : '备案号还没下来 / 还没填。'));
    console.log('     你现在可以双击 预览上线效果.bat 先看看传上去会是什么样；');
    console.log('     等备案号下来，填进 site-config.js，再双击一次本文件，结论就会变成 ✔。');
  } else {
    console.log('  ✘ 这次没准备好：看上面的 ✘ 行，解决之后再双击一次本文件。');
  }

  process.exitCode = pre.verdict === 'blocked' ? 1 : 0;
}

main().catch(e => {
  console.error('上线准备出错：' + (e && e.stack ? e.stack : e));
  process.exitCode = 1;
});
