// ============================================================
// 所有"要显示给用户看的话"，统一放在这里
//
// 【为什么要有这个文件】（这是踩坑之后的经验，别改回去）
//   .bat 文件里如果直接写中文，Windows 的命令行会按本地编码去读它，
//   结果是乱码，严重时会把中文里的字当成命令去执行，报
//   "'需要' is not recognized as an internal or external command"。
//   所以现在：.bat 里只有纯英文骨架，一句中文都不放；
//   所有对用户说的话，都由 Node 程序输出（Node 能正确输出中文）。
//
// 【为什么还有英文】
//   这个网站以后要放到公网上，来看的人不一定用中文 Windows。
//   系统语言是中文 → 显示中文；其它语言 → 显示英文。
// ============================================================

const MESSAGES = {
  zh: {
    collecting: '正在去官网采集最新数据...',
    waiting: '（大约需要 5-10 秒，请稍等）',
    collectFailed: '采集这一步没成功，原因写在上面的文字里。如果以前采集成功过，网站还能打开、看上次的数据。',
    opening: '正在打开网站，浏览器会自动弹出...',
    serveHint: '网站地址：http://127.0.0.1:8000',
    stopHint: '想关掉网站时，直接关掉这个黑色窗口就行。',
    updateHint: '想更新数据：双击 更新数据.bat',
    dailyHint: '想每天自动更新：双击 每日自动采集.bat（保持窗口开着）',
    nodeMissing: '找不到 Node.js 程序，网站起不来。请确认这台电脑装过 Node.js。',
    updating: '正在去官网重新取一次最新数据，大约需要 10 秒...',
    updateOk: '数据已更新，网页已重新生成。如果网站正开着，刷新一下浏览器就能看到新内容。',
    updatePartial: '数据更新完成，但有数据源没成功：失败那个源仍显示上一次采到的数据，网页顶部有说明，卡片上也标了"这条是上次的数据"。等下次采集会自动重试。',
    updateFail: '这次一条都没采到。好消息是：原来的数据没有被覆盖，网站还是能打开看上次的数据（网页顶部会写明这件事）。',
    needBuild: '还没生成过网页文件，先跑一次采集：src\\build.js 或 更新数据.bat',
  },
  en: {
    collecting: 'Collecting the latest data from the official sites...',
    waiting: '(takes about 5-10 seconds, please wait)',
    collectFailed: 'Collection failed; the reason is printed above. If it worked before, the site still opens with the previous data.',
    opening: 'Opening the site; your browser should pop up automatically...',
    serveHint: 'Site address: http://127.0.0.1:8000',
    stopHint: 'To stop the site, just close this black window.',
    updateHint: 'To refresh data: double-click the "update data" .bat file',
    dailyHint: 'To refresh daily: double-click the "daily collect" .bat file and keep it open',
    nodeMissing: 'Cannot find Node.js, so the site cannot start. Please make sure Node.js is installed on this computer.',
    updating: 'Re-fetching the latest data from the official sites (about 10 seconds)...',
    updateOk: 'Data updated and the web page regenerated. If the site is open, refresh your browser to see it.',
    updatePartial: 'Update finished, but one data source failed: that source still shows its previous data. See the notice at the top of the page; the cards are labelled "data from the previous run". It will be retried next time.',
    updateFail: 'Nothing was collected this time. Good news: your previous data was NOT overwritten, so the site still opens with the last good data (the page says so at the top).',
    needBuild: 'No generated page yet. Run a collection first (see the update-data .bat file).',
  },
};

// 系统语言是中文就用中文，其它一律英文
function pickLang() {
  const env = process.env.DSH_LANG || process.env.LANG || '';
  const intl = (Intl.DateTimeFormat().resolvedOptions().locale) || '';
  const all = [env, intl, process.platform === 'win32' ? (process.env.LC_ALL || '') : ''].join(' ');
  return /zh|chinese|中文/i.test(all) ? 'zh' : 'en';
}

function makeMessages(lang) {
  const table = MESSAGES[lang] || MESSAGES.en;
  return key => (table[key] !== undefined ? table[key] : (MESSAGES.en[key] || key));
}

module.exports = { pickLang, makeMessages, MESSAGES };
