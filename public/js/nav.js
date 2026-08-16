// nav.js — injects the shared top bar into #siteNav on every page,
// guards pages that require login, handles the dark/light toggle, and pops
// up any unread admin messages as toasts.
(function () {
  function getToken() { return localStorage.getItem('rh_token'); }

  async function fetchMe() {
    const token = getToken();
    if (!token) return null;
    try {
      const res = await fetch('/api/auth/me', { headers: { Authorization: 'Bearer ' + token } });
      if (!res.ok) return null;
      const data = await res.json();
      return data.user;
    } catch (e) { return null; }
  }

  /* ---------------- dark mode ---------------- */

  function getTheme() { return localStorage.getItem('rh_theme') === 'dark' ? 'dark' : 'light'; }

  function applyTheme(theme) {
    if (theme === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
    else document.documentElement.removeAttribute('data-theme');
  }

  function toggleTheme() {
    const next = getTheme() === 'dark' ? 'light' : 'dark';
    localStorage.setItem('rh_theme', next);
    applyTheme(next);
    const btn = document.getElementById('hubThemeToggle');
    if (btn) btn.textContent = next === 'dark' ? '☀' : '☾';
  }

  /* ---------------- admin message toasts ---------------- */

  function ensureToastWrap() {
    let wrap = document.getElementById('hubToastWrap');
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.id = 'hubToastWrap';
      wrap.className = 'hub-toast-wrap';
      document.body.appendChild(wrap);
    }
    return wrap;
  }

  function showToast(msg, token) {
    const wrap = ensureToastWrap();
    const el = document.createElement('div');
    el.className = 'hub-toast';
    el.innerHTML =
      '<button class="hub-toast-close" aria-label="Dismiss">✕</button>' +
      '<div class="hub-toast-title">Message from admin</div>' +
      '<div class="hub-toast-body"></div>';
    el.querySelector('.hub-toast-body').textContent = msg.body; // textContent, not innerHTML — avoids XSS from message content
    el.querySelector('.hub-toast-close').addEventListener('click', function () {
      el.remove();
      fetch('/api/messages/' + msg.id + '/read', { method: 'POST', headers: { Authorization: 'Bearer ' + token } }).catch(function () {});
    });
    wrap.appendChild(el);
  }

  async function checkMessages(token) {
    try {
      const res = await fetch('/api/messages/unread', { headers: { Authorization: 'Bearer ' + token } });
      if (!res.ok) return;
      const data = await res.json();
      (data.messages || []).forEach(function (m) { showToast(m, token); });
    } catch (e) { /* silent — a missed popup isn't worth surfacing an error for */ }
  }

  /* ---------------- nav bar ---------------- */

  function render(user, activePage) {
    const mount = document.getElementById('siteNav');
    if (!mount) return;
    const links = [
      { href: '/index.html', label: 'Home', key: 'home' },
      { href: '/matrix.html', label: 'Matrix', key: 'matrix' },
      { href: '/reasoning.html', label: 'Reasoning Lab', key: 'reasoning' },
      { href: '/prep30.html', label: '30-Day Prep', key: 'prep30' },
      { href: '/files.html', label: 'My Files', key: 'files' },
      { href: '/public-files.html', label: 'Public Files', key: 'public-files' },
      { href: '/reader.html', label: 'Reader', key: 'reader' },
      { href: '/account.html', label: 'Account', key: 'account' }
    ];
    if (user && user.role === 'admin') links.push({ href: '/admin.html', label: 'Admin', key: 'admin' });

    mount.innerHTML =
      '<div class="hub-nav-inner">' +
        '<a class="hub-nav-brand" href="/index.html">Reasoning Hub</a>' +
        '<div class="hub-nav-links">' +
          links.map(function (l) {
            return '<a href="' + l.href + '" class="' + (l.key === activePage ? 'active' : '') + '">' + l.label + '</a>';
          }).join('') +
        '</div>' +
        '<div class="hub-nav-user">' +
          '<button id="hubThemeToggle" type="button" aria-label="Toggle dark mode">' + (getTheme() === 'dark' ? '☀' : '☾') + '</button>' +
          (user ? ('<span class="hub-nav-email">' + user.email + (user.role === 'admin' ? ' <em>admin</em>' : '') + '</span><button id="hubLogoutBtn">Log out</button>') : '<a href="/login.html">Log in</a>') +
        '</div>' +
      '</div>';

    var logoutBtn = document.getElementById('hubLogoutBtn');
    if (logoutBtn) {
      logoutBtn.addEventListener('click', function () {
        localStorage.removeItem('rh_token');
        location.href = '/login.html';
      });
    }
    var themeBtn = document.getElementById('hubThemeToggle');
    if (themeBtn) themeBtn.addEventListener('click', toggleTheme);
  }

  window.HubNav = {
    // Call once per page. requireAuth=true redirects to /login.html if not signed in.
    init: async function (activePage, requireAuthFlag) {
      applyTheme(getTheme());
      const user = await fetchMe();
      if (requireAuthFlag && !user) {
        const next = encodeURIComponent(location.pathname);
        location.href = '/login.html?next=' + next;
        return null;
      }
      render(user, activePage);
      if (user) {
        var token = getToken();
        if (token) checkMessages(token);
      }
      return user;
    }
  };
})();
