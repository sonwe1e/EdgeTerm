(function () {
  var btn = document.getElementById('langBtn');
  var TITLES = {
    home: {
      en: 'EdgeTerm — Terminal, SSH, FTP & Serial Client',
      zh: 'EdgeTerm — 终端、SSH、FTP 与串口客户端'
    },
    tutorial: {
      en: 'EdgeTerm Tutorial — a hands-on guide to every feature',
      zh: 'EdgeTerm 使用教程 — 每个功能的实操指南'
    }
  };
  function apply(lang) {
    document.body.setAttribute('data-lang', lang);
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
    btn.textContent = lang === 'zh' ? 'EN' : '中文';
    var page = /tutorial\.html$/.test(location.pathname) ? TITLES.tutorial : TITLES.home;
    document.title = page[lang];
    try { localStorage.setItem('edgeterm-lang', lang); } catch (e) {}
  }
  var saved = null;
  try { saved = localStorage.getItem('edgeterm-lang'); } catch (e) {}
  apply(saved || (/^zh/i.test(navigator.language || '') ? 'zh' : 'en'));
  btn.addEventListener('click', function () {
    apply(document.body.getAttribute('data-lang') === 'zh' ? 'en' : 'zh');
  });
})();
