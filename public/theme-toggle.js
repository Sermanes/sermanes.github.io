(function () {
  var btn = document.getElementById('theme-toggle');
  function sync() {
    var dark = document.documentElement.getAttribute('data-theme') === 'dark';
    if (btn) btn.setAttribute('aria-pressed', String(dark));
  }
  sync();
  if (btn) {
    btn.addEventListener('click', function () {
      var root = document.documentElement;
      var next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      root.setAttribute('data-theme', next);
      try { localStorage.setItem('theme', next); } catch (e) {}
      sync();
    });
  }
})();
