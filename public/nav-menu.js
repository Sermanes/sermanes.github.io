(function () {
  var btn = document.getElementById('nav-menu-toggle');
  var panel = document.getElementById('nav-menu-panel');
  if (!btn) return;
  btn.addEventListener('click', function () {
    var open = btn.getAttribute('aria-expanded') === 'true';
    btn.setAttribute('aria-expanded', String(!open));
    if (panel) panel.hidden = open;
  });
})();
