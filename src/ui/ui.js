(function () {
  const DARK_MODE_KEY = 'darkMode';

  // Base path prefix when served behind a path-routing reverse proxy.
  // Injected into HTML by nginx as window.BASE_PATH ('@@BASE_PATH@@' when unset).
  const rawBase = typeof window.BASE_PATH === 'string' ? window.BASE_PATH : '';
  const BASE_PATH = (rawBase && rawBase !== '@@BASE_PATH@@')
    ? rawBase.replace(/\/+$/, '')
    : '';
  function withBase(path) {
    if (/^[a-z]+:\/\//i.test(path)) return path;
    return BASE_PATH + (path.startsWith('/') ? path : '/' + path);
  }
  window.BASE_PATH = BASE_PATH;
  window.withBase = withBase;

  const navItems = [
    ['dashboard', 'Dashboard', '/dashboard.html'],
    ['results', 'Results', '/results.html'],
    ['validate', 'Inspect', '/validate.html'],
    ['rules', 'Rules', '/rules.html'],
    ['settings', 'Settings', '/settings.html'],
    ['test', 'Test', '/test.html'],
  ];

  function preferredDarkMode() {
    const saved = localStorage.getItem(DARK_MODE_KEY);
    if (saved === '1') return true;
    if (saved === '0') return false;
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function escapeAttr(value) {
    return escapeHtml(value).replace(/"/g, '&quot;');
  }

  const moonIcon = '<svg data-theme-icon="moon" xmlns="http://www.w3.org/2000/svg" class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/></svg>';
  const sunIcon = '<svg data-theme-icon="sun" xmlns="http://www.w3.org/2000/svg" class="w-4 h-4 hidden" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>';

  function setTheme(dark, persist) {
    document.documentElement.classList.toggle('dark', dark);
    if (persist) localStorage.setItem(DARK_MODE_KEY, dark ? '1' : '0');
    document.querySelectorAll('[data-theme-toggle]').forEach(button => {
      button.setAttribute('aria-pressed', String(dark));
      button.setAttribute('aria-label', dark ? '切換為淺色模式' : '切換為深色模式');
      button.setAttribute('title', dark ? '切換為淺色模式' : '切換為深色模式');
    });
    document.querySelectorAll('[data-theme-icon="moon"]').forEach(icon => icon.classList.toggle('hidden', dark));
    document.querySelectorAll('[data-theme-icon="sun"]').forEach(icon => icon.classList.toggle('hidden', !dark));
  }

  function toggleDark() {
    setTheme(!document.documentElement.classList.contains('dark'), true);
  }

  function themeButton(className) {
    return `<button type="button" data-theme-toggle onclick="window.toggleDark()" class="${className}" aria-label="切換深色模式" aria-pressed="false" title="切換深色模式">${moonIcon}${sunIcon}</button>`;
  }

  function renderNav(container) {
    const active = container.dataset.appNav || '';
    const links = navItems.map(([key, label, href], index) => {
      const classes = key === active ? 'text-blue-300 font-medium' : 'hover:text-gray-300';
      const spacer = index === 4 ? ' ml-auto' : '';
      return `<a href="${withBase(href)}" class="${spacer}${spacer ? ' ' : ''}${classes}">${label}</a>`;
    }).join('');

    container.innerHTML = `<nav class="bg-gray-800 dark:bg-gray-950 text-white px-6 py-3 flex items-center gap-6">
      <span class="font-bold">IUA/SMART Validator</span>
      ${links}
      ${themeButton('hover:text-gray-300')}
      <button type="button" data-app-logout class="text-sm hover:text-gray-300">Logout</button>
    </nav>`;
  }

  function initUi() {
    document.querySelectorAll('[data-app-nav]').forEach(renderNav);
    document.querySelectorAll('[data-login-theme-toggle]').forEach(container => {
      container.innerHTML = themeButton('fixed top-4 right-4 text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200');
    });
    document.addEventListener('click', event => {
      if (event.target.closest('[data-app-logout]') && typeof window.logout === 'function') {
        window.logout();
      }
    });
    setTheme(document.documentElement.classList.contains('dark'), false);
  }

  setTheme(preferredDarkMode(), false);
  window.ui = { escapeHtml, escapeAttr, setTheme, toggleDark };
  window.toggleDark = toggleDark;
  window.escapeHtml = escapeHtml;
  window.escapeAttr = escapeAttr;
  document.addEventListener('DOMContentLoaded', initUi);
}());
