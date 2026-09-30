(function () {
  "use strict";

  var tg = window.Telegram ? window.Telegram.WebApp : null;
  if (tg) {
    tg.ready();
    tg.expand();
    // Раньше здесь стоял тёмно-зелёный (#0D332B) — на макете системная
    // шапка Telegram НЕ подкрашена, она обычная светлая, поэтому теперь
    // отдаём Telegram тот же кремовый тон, что и весь остальной фон, а не
    // отдельный акцентный цвет — снаружи (у Telegram) и внутри (наш body)
    // всё выглядит одной сплошной поверхностью, без цветной полосы сверху.
    try { tg.setHeaderColor("#F4EBDD"); } catch (e) {}
    try { tg.setBackgroundColor("#F4EBDD"); } catch (e) {}
  }

  var state = {
    screen: "home",
    home: null,          // отметка, что главная уже загружалась (использует profile+menu)
    profile: null,       // {registered, name, phone, zone, point, order_count, club, ...}
    menu: null,           // ответ /api/menu
    menuCategory: "all",  // выбранный чип категории на экране Меню
    feed: null,           // список постов ленты PAUSE Club (ответ /api/feed) — общий и для CLUB, и для Послания
    feedFilter: "all",    // "all" | один из config.FEED_POST_TYPES — фильтр экрана CLUB
    messagesFilter: "all", // тот же принцип, отдельный фильтр экрана Послания
  };

  // -------------------------------------------------------------------
  // API
  // -------------------------------------------------------------------

  function initData() { return tg ? tg.initData : ""; }

  // PAUSE App примонтирован под /pauseapp (см. bot.py: extra_subapps) — без
  // этого префикса fetch("/api/...") ушёл бы на корень сайта (там живёт
  // Mini App "Маршрут", с частично похожими, но другими путями), а не в
  // подприложение, из которого реально загружена эта страница.
  var API_BASE = "/pauseapp";

  function api(path, options) {
    options = options || {};
    var headers = options.headers || {};
    headers["X-Telegram-Init-Data"] = initData();
    if (options.body) headers["Content-Type"] = "application/json";
    return fetch(API_BASE + path, {
      method: options.method || "GET",
      headers: headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
    }).then(function (resp) {
      if (!resp.ok) {
        return resp.json().catch(function () { return {}; }).then(function (data) {
          var err = new Error(data.error || ("HTTP " + resp.status));
          err.code = data.error;
          err.status = resp.status;
          err.data = data;
          throw err;
        });
      }
      return resp.json();
    });
  }

  function apiUpload(path, blob, filename) {
    var fd = new FormData();
    fd.append("photo", blob, filename || "screenshot.jpg");
    return fetch(API_BASE + path, {
      method: "POST",
      headers: { "X-Telegram-Init-Data": initData() },
      body: fd,
    }).then(function (resp) {
      if (!resp.ok) {
        return resp.json().catch(function () { return {}; }).then(function (data) {
          throw new Error(data.error || ("HTTP " + resp.status));
        });
      }
      return resp.json();
    });
  }

  // -------------------------------------------------------------------
  // Утилиты
  // -------------------------------------------------------------------

  function toast(text) {
    var el = document.getElementById("toast");
    el.textContent = text;
    el.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { el.hidden = true; }, 2800);
  }

  function fmtSum(n) {
    return (n || 0).toLocaleString("ru-RU") + " сум";
  }

  function initials(name) {
    var parts = (name || "").trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return "?";
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }

  function haptic(kind) {
    if (!tg || !tg.HapticFeedback) return;
    try {
      if (kind === "select") tg.HapticFeedback.selectionChanged();
      else if (kind === "success") tg.HapticFeedback.notificationOccurred("success");
      else if (kind === "error") tg.HapticFeedback.notificationOccurred("error");
      else tg.HapticFeedback.impactOccurred("light");
    } catch (e) {}
  }

  function el(tag, className, html) {
    var e = document.createElement(tag);
    if (className) e.className = className;
    if (html !== undefined) e.innerHTML = html;
    return e;
  }

  var confirmCallback = null;
  function showConfirm(text, yesLabel, onYes) {
    document.getElementById("confirm-modal-text").textContent = text;
    document.getElementById("confirm-modal-yes").textContent = yesLabel;
    confirmCallback = onYes;
    document.getElementById("confirm-modal").hidden = false;
  }
  function hideConfirm() {
    document.getElementById("confirm-modal").hidden = true;
    confirmCallback = null;
  }

  // Плашка "только посмотреть" — статус клуба и подобные короткие справки,
  // где не нужен выбор Да/Нет (см. #info-modal в index.html).
  function showInfo(html) {
    document.getElementById("info-modal-body").innerHTML = html;
    document.getElementById("info-modal").hidden = false;
  }
  function hideInfo() {
    document.getElementById("info-modal").hidden = true;
  }
  document.getElementById("info-modal-ok").addEventListener("click", hideInfo);

  // Номер телефона в системе хранится как ввёл клиент (в боте это
  // свободный текст, см. handlers/start.py: got_phone) — где угодно могут
  // быть пробелы/дефисы/скобки, код страны может отсутствовать. Здесь
  // приводим показ к единому виду "+998 XX XXX XX XX" по требованию
  // пользователя, не трогая то, что реально хранится в таблице.
  function formatPhone(raw) {
    var digits = (raw || "").replace(/\D/g, "");
    if (digits.slice(0, 3) === "998") digits = digits.slice(3);
    digits = digits.slice(-9);
    if (digits.length < 9) return raw || "";
    return "+998 " + digits.slice(0, 2) + " " + digits.slice(2, 5) + " " + digits.slice(5, 7) + " " + digits.slice(7, 9);
  }

  // -------------------------------------------------------------------
  // Шапка экрана — своя на каждой вкладке, как на макете (единой сплошной
  // шапки на всё приложение больше нет, см. index.html). opts:
  //   logo   — true на Главной: "🌿 PAUSE." слева вместо кнопки "назад"
  //   back   — функция клика по стрелке "назад" слева (если есть)
  //   title  — текст заголовка
  //   center — true, если заголовок по центру (Меню/Профиль), иначе слева
  //            прижатый к началу (Pause Club/Послания — как на макете)
  //   right  — {icon, label, onClick} — иконка справа, необязательна
  // -------------------------------------------------------------------

  function screenHeader(containerId, opts) {
    var root = document.getElementById(containerId);
    root.innerHTML = "";
    var bar = el("div", "screen-header" + (opts.center ? " screen-header-center" : ""));
    var left = el("div", "screen-header-side screen-header-left");
    if (opts.back) {
      var backBtn = el("button", "header-icon-btn", ICON_BACK);
      backBtn.setAttribute("aria-label", "Назад");
      backBtn.addEventListener("click", function () { haptic("select"); opts.back(); });
      left.appendChild(backBtn);
    } else if (opts.logo) {
      left.appendChild(el("div", "screen-header-logo", "🌿 PAUSE."));
    }
    bar.appendChild(left);
    bar.appendChild(el("div", "screen-header-title", escapeHtml(opts.title || "")));
    var right = el("div", "screen-header-side screen-header-right");
    if (opts.right) {
      var rightBtn = el("button", "header-icon-btn", opts.right.icon);
      rightBtn.setAttribute("aria-label", opts.right.label || "");
      rightBtn.addEventListener("click", function () { haptic("select"); opts.right.onClick(); });
      right.appendChild(rightBtn);
    }
    bar.appendChild(right);
    root.appendChild(bar);
  }

  var ICON_BACK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" width="22" height="22"><path d="M15 5l-7 7 7 7"/></svg>';
  var ICON_BELL_HDR = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="21" height="21"><path d="M6 10a6 6 0 1 1 12 0c0 4 1.5 5.5 1.5 5.5h-15S6 14 6 10Z"/><path d="M10 18a2 2 0 0 0 4 0"/></svg>';
  // Стандартная, многократно проверенная иконка "шестерёнка" (Feather
  // Icons, settings) — прошлая версия была нарисована вручную и рендерилась
  // неровно (зубцы разного размера/шага), заменена на готовый, точный путь.
  var ICON_GEAR = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" width="21" height="21" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>';
  var ICON_KEBAB = '<svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20"><circle cx="12" cy="5" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="12" cy="19" r="1.8"/></svg>';

  // -------------------------------------------------------------------
  // Навигация — нижняя панель, 5 экранов
  // -------------------------------------------------------------------

  var SCREEN_NAMES = ["home", "menu", "club", "messages", "profile"];

  function showScreen(name) {
    state.screen = name;
    SCREEN_NAMES.forEach(function (s) {
      document.getElementById("screen-" + s).hidden = s !== name;
    });
    document.getElementById("content").scrollTop = 0;
    document.getElementById("bottom-nav").classList.remove("nav-hidden");
    Array.prototype.forEach.call(document.querySelectorAll(".nav-item"), function (b) {
      b.classList.toggle("active", b.dataset.screen === name);
    });
    // ВАЖНО: loadHome() попутно заполняет state.profile/state.menu для
    // своей промо-карточки (см. loadHome ниже) — если Профиль/Меню после
    // этого просто проверяют "данные уже есть, повторно не грузим", они
    // должны сами ОТРИСОВАТЬ то, что уже загружено, а не молча ничего не
    // делать (иначе первый заход именно в эти две вкладки показывал бы
    // вечный скелетон-плейсхолдер — так и было до этого исправления, ту
    // же ошибку, что и Послания уже обходили правильно строкой ниже).
    if (name === "home" && !state.home) loadHome();
    if (name === "profile") { if (state.profile) renderProfileScreen(); else loadProfile(); }
    if (name === "menu") { if (state.menu) renderMenuScreen(); else loadMenu(); }
    if (name === "club" && !state.feed) loadFeed();
    if (name === "club" && state.feed) renderFeedScreen();
    if (name === "messages" && !state.feed) loadFeed();
    if (name === "messages" && state.feed) renderMessagesFeedScreen();
  }

  // Нижняя панель прячется при прокрутке вниз и появляется обратно при
  // прокрутке вверх — как попросили, чтобы не загромождала контент на
  // длинных экранах (лента/меню), но оставалась под рукой при чтении назад.
  function initBottomNavScroll() {
    var content = document.getElementById("content");
    var nav = document.getElementById("bottom-nav");
    var lastY = 0;
    content.addEventListener("scroll", function () {
      var y = content.scrollTop;
      if (y > lastY && y > 40) {
        nav.classList.add("nav-hidden");
      } else {
        nav.classList.remove("nav-hidden");
      }
      lastY = y;
    }, { passive: true });
  }

  function initNav() {
    Array.prototype.forEach.call(document.querySelectorAll(".nav-item"), function (b) {
      b.addEventListener("click", function () {
        haptic("select");
        showScreen(b.dataset.screen);
      });
    });
  }

  // -------------------------------------------------------------------
  // Полноэкранный визард — общий каркас для заказа и для правки профиля
  // -------------------------------------------------------------------

  var wizardStack = [];
  var wizardPhaseEl = document.getElementById("wizard-steps");

  function openWizard(renderFirstStep) {
    wizardStack = [];
    document.getElementById("wizard").hidden = false;
    if (tg && tg.BackButton) {
      tg.BackButton.show();
      tg.BackButton.onClick(wizardBackOrClose);
    }
    wizardStep(renderFirstStep);
  }

  function closeWizard() {
    document.getElementById("wizard").hidden = true;
    wizardStack = [];
    wizardPhaseEl.innerHTML = "";
    if (tg && tg.BackButton) {
      tg.BackButton.offClick(wizardBackOrClose);
      tg.BackButton.hide();
    }
  }

  function wizardBackOrClose() {
    if (wizardStack.length > 1) wizardBack();
    else closeWizard();
  }

  function wizardStep(renderFn) {
    wizardStack.push(renderFn);
    renderWizardCurrent();
  }

  function wizardReplace(renderFn) {
    wizardStack[wizardStack.length - 1] = renderFn;
    renderWizardCurrent();
  }

  function wizardBack() {
    if (wizardStack.length > 1) {
      wizardStack.pop();
      renderWizardCurrent();
    }
  }

  function renderWizardCurrent() {
    var body = document.getElementById("wizard-body");
    body.innerHTML = "";
    body.scrollTop = 0;
    document.getElementById("wizard-back").style.visibility = wizardStack.length > 1 ? "visible" : "hidden";
    var fn = wizardStack[wizardStack.length - 1];
    fn(body);
  }

  function setWizardPhase(index, total) {
    wizardPhaseEl.innerHTML = "";
    if (!total) return;
    for (var i = 0; i < total; i++) {
      var dot = el("span", "wizard-step-dot" + (i === index ? " active" : i < index ? " done" : ""));
      wizardPhaseEl.appendChild(dot);
    }
  }

  document.getElementById("wizard-back").addEventListener("click", wizardBack);
  document.getElementById("wizard-close").addEventListener("click", function () {
    if (order.cart.length || order.point) {
      showConfirm("Прервать оформление заказа? Корзина не сохранится.", "Да, прервать", closeWizard);
    } else {
      closeWizard();
    }
  });

  // -------------------------------------------------------------------
  // ГЛАВНАЯ — приветствие + переход к разделам, всё на реальных данных
  // (профиль клиента + сегодняшнее меню, те же самые ответы API, что и у
  // экранов Меню/Профиль — просто дублируем их локально в state, чтобы
  // при заходе на сами эти вкладки не перезапрашивать то, что уже есть).
  // -------------------------------------------------------------------

  var QUICK_NAV = [
    { screen: "menu", label: "Меню", icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="4" y="4" width="16" height="16" rx="4"/><path d="M8 10h8M8 14h5"/></svg>' },
    { screen: "club", label: "Pause Club", icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M12 3c-2 2.5-3 4.7-3 6.6A3 3 0 0 0 12 12a3 3 0 0 0 3-3.4C15 7.7 14 5.5 12 3Z"/><path d="M12 12v9"/></svg>' },
    { screen: "messages", label: "Послания", icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="3.5" y="5.5" width="17" height="13" rx="2.5"/><path d="M4.5 7 12 12.5 19.5 7"/></svg>' },
    { screen: "profile", label: "Профиль", icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="12" cy="8" r="3.4"/><path d="M5 20c1.2-3.8 4-5.6 7-5.6s5.8 1.8 7 5.6"/></svg>' },
  ];

  function loadHome() {
    var root = document.getElementById("home-root");
    Promise.all([
      state.profile ? Promise.resolve(state.profile) : api("/api/profile"),
      state.menu ? Promise.resolve(state.menu) : api("/api/menu"),
    ]).then(function (results) {
      state.profile = results[0];
      state.menu = results[1];
      state.home = true;
      renderHomeScreen();
    }).catch(function (err) {
      root.innerHTML = "";
      root.appendChild(el("div", "empty-note", "Не удалось загрузить данные: " + err.message));
    });
  }

  function renderHomeScreen() {
    screenHeader("home-header", {
      logo: true,
      right: { icon: ICON_BELL_HDR, label: "Уведомления", onClick: function () { toast("Уведомления — скоро добавим"); } },
    });
    var root = document.getElementById("home-root");
    root.innerHTML = "";
    var p = state.profile;
    var m = state.menu;

    var firstName = (p && p.registered && p.name) ? p.name.trim().split(/\s+/)[0] : "";
    var hero = el("div", "home-hero");
    hero.innerHTML =
      '<h2>' + (firstName ? "Добро пожаловать, " + escapeHtml(firstName) : "Добро пожаловать") + '</h2>' +
      '<p>Вкусные обеды. Забота о тебе.</p>';
    root.appendChild(hero);

    var promo = el("div", "card home-promo");
    promo.addEventListener("click", function () { showScreen("menu"); });
    if (m.published && !m.cutoff_passed) {
      promo.innerHTML =
        '<div class="home-promo-icon">' + ICON_LEAF + '</div>' +
        '<div><div class="home-promo-title">Сегодняшнее меню</div>' +
        '<div class="home-promo-sub">На ' + escapeHtml(m.date || "") + ' — открыт приём заказов</div></div>' +
        '<div class="home-promo-arrow"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M9 6l6 6-6 6"/></svg></div>';
    } else {
      promo.innerHTML =
        '<div class="home-promo-icon">' + ICON_CLOCK + '</div>' +
        '<div><div class="home-promo-title">Меню сегодня</div>' +
        '<div class="home-promo-sub">' + (m.published ? "Приём заказов на сегодня закрыт" : "Готовим, скоро опубликуем") + '</div></div>';
    }
    root.appendChild(promo);

    var quickRow = el("div", "home-quick-row");
    QUICK_NAV.forEach(function (item) {
      var btn = el("button", "home-quick-item", item.icon + "<span>" + item.label + "</span>");
      btn.addEventListener("click", function () { haptic("select"); showScreen(item.screen); });
      quickRow.appendChild(btn);
    });
    root.appendChild(quickRow);

    // "Сегодня в меню" — вместо "Популярное" с макета: реальной статистики
    // популярности блюд в системе нет (не считается нигде), а показывать
    // выдуманный рейтинг — фиктивные данные; вместо этого честно берём то
    // же самое сегодняшнее меню, что и на вкладке Меню (первые несколько
    // позиций), той же самой карточкой (см. buildMenuSetCard).
    if (m.published && m.sets && m.sets.length) {
      root.appendChild(el("div", "profile-section-title", "Сегодня в меню"));
      var list = el("div", "menu-set-grid");
      m.sets.slice(0, 3).forEach(function (s) { list.appendChild(buildMenuSetCard(s)); });
      root.appendChild(list);
    }
  }

  // -------------------------------------------------------------------
  // МЕНЮ — показ сегодняшнего меню
  // -------------------------------------------------------------------

  function loadMenu() {
    var root = document.getElementById("menu-root");
    state.menuCategory = "all";
    api("/api/menu").then(function (data) {
      state.menu = data;
      renderMenuScreen();
    }).catch(function (err) {
      root.innerHTML = "";
      root.appendChild(el("div", "menu-state", "<p>Не получилось загрузить меню — временная проблема связи.</p>"));
      var retry = el("button", "btn-ghost", "Повторить");
      retry.style.marginTop = "14px";
      retry.addEventListener("click", loadMenu);
      root.appendChild(retry);
    });
  }

  function menuStateBlock(iconSvg, title, text) {
    var wrap = el("div", "menu-state");
    wrap.innerHTML =
      '<div>' + iconSvg + '</div><h2>' + title + '</h2><p>' + text + '</p>';
    return wrap;
  }

  var ICON_CLOCK = '<svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/></svg>';
  var ICON_LEAF = '<svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M5 19c8 0 14-6 14-14-8 0-14 6-14 14Z"/><path d="M5 19c3-6 6-9 12-12"/></svg>';

  function renderMenuScreen() {
    screenHeader("menu-header", {
      back: function () { showScreen("home"); },
      title: "Меню",
      center: true,
      right: { icon: ICON_SLIDERS, label: "Сортировка", onClick: function () { toast("Сортировка — скоро добавим"); } },
    });
    var root = document.getElementById("menu-root");
    root.innerHTML = "";
    var data = state.menu;

    if (!data.published) {
      root.appendChild(menuStateBlock(ICON_LEAF, "Меню скоро будет", "Мы ещё готовим сегодняшнее меню — загляните чуть позже 🌿"));
      return;
    }

    if (data.cutoff_passed) {
      root.appendChild(menuStateBlock(ICON_CLOCK, "Приём на сегодня закрыт", "Прием заказов на сегодня закрылся в " + data.cutoff_time + ". Загляните завтра — мы уже готовим следующее меню."));
      return;
    }

    if (data.caption) {
      var dateP = el("div", "pill gold menu-date-pill", "На " + (data.date || ""));
      root.appendChild(dateP);
      root.appendChild(el("div", "card menu-caption", escapeHtml(data.caption)));
    }

    var hero = el("div", "menu-hero");
    hero.appendChild(el("h2", null, "Выбери свою паузу на сегодня"));
    root.appendChild(hero);

    renderMenuCategoryChips(root);
    renderMenuSetCards(root);
  }

  function menuCategoriesInUse() {
    var seen = {};
    var result = [];
    (state.menu.sets || []).forEach(function (s) {
      var c = (s.category || "").trim();
      if (c && !seen[c]) { seen[c] = true; result.push(c); }
    });
    return result;
  }

  function renderMenuCategoryChips(root) {
    var categories = menuCategoriesInUse();
    // Если ни у одного сета категория ещё не проставлена в таблице —
    // чипы не показываем вовсе (см. отчёт: "фото/категории — загружу
    // позже"), чтобы не рисовать один бессмысленный чип "Все".
    if (!categories.length) return;
    var row = el("div", "feed-filters menu-category-chips");
    var allChip = el("button", "filter-chip" + (state.menuCategory === "all" ? " active" : ""), "Все");
    allChip.addEventListener("click", function () { state.menuCategory = "all"; renderMenuScreen(); });
    row.appendChild(allChip);
    categories.forEach(function (c) {
      var chip = el("button", "filter-chip" + (state.menuCategory === c ? " active" : ""), escapeHtml(c));
      chip.addEventListener("click", function () { state.menuCategory = c; renderMenuScreen(); });
      row.appendChild(chip);
    });
    root.appendChild(row);
  }

  function renderMenuSetCards(root) {
    var sets = (state.menu.sets || []).filter(function (s) {
      return state.menuCategory === "all" || (s.category || "") === state.menuCategory;
    });
    if (!sets.length) {
      root.appendChild(el("div", "menu-state", "<p>В этой категории пока пусто.</p>"));
      return;
    }
    var grid = el("div", "menu-set-grid");
    sets.forEach(function (s) { grid.appendChild(buildMenuSetCard(s)); });
    root.appendChild(grid);
  }

  function buildMenuSetCard(s) {
    // Горизонтальная карточка (миниатюра слева) — как в списке блюд на
    // макете; полноразмерное фото/детали — уже на отдельном экране
    // (см. openSetDetail), сама карточка в списке только открывает его.
    var card = el("div", "card menu-set-card");
    if (s.photo_url) {
      var img = el("img", "menu-set-thumb");
      img.src = s.photo_url;
      img.alt = "";
      img.loading = "lazy";
      img.addEventListener("error", function () { img.remove(); });
      card.appendChild(img);
    } else {
      card.appendChild(el("div", "menu-set-thumb menu-set-thumb-empty", ICON_LEAF));
    }
    var body = el("div", "menu-set-card-body");
    body.appendChild(el("div", "menu-set-card-name", escapeHtml(s.display_name)));
    if (s.is_variant_group) {
      var minP = Math.min.apply(null, s.variants.map(function (v) { return v.price; }));
      body.appendChild(el("div", "menu-set-card-price", "от " + fmtSum(minP)));
    } else {
      body.appendChild(el("div", "menu-set-card-price", fmtSum(s.price)));
      if (s.has_garnish) body.appendChild(el("div", "menu-set-card-note", "с выбором гарнира"));
    }
    card.appendChild(body);
    card.appendChild(el("div", "menu-set-card-chevron", '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M9 6l6 6-6 6"/></svg>'));
    card.addEventListener("click", function () { openSetDetail(s); });
    return card;
  }

  // --- Детальная карточка блюда (открывается по клику из списка/с
  // Главной) — отдельный экран перед визардом заказа, как на макете:
  // крупное фото, цена, кнопка "Заказать" запускает тот же самый
  // startOrderFromCard, что раньше вызывался прямо по клику на карточку. --

  function openSetDetail(s) {
    haptic("select");
    openWizard(function (body) {
      wizardPhaseEl.innerHTML = "";
      if (s.photo_url) {
        var img = el("img", "set-detail-photo");
        img.src = s.photo_url;
        img.alt = "";
        img.addEventListener("error", function () { img.remove(); });
        body.appendChild(img);
      }
      var favBtn = el("button", "set-detail-fav", ICON_HEART);
      // "Избранное" в системе пока нет (см. отчёт) — честная заглушка,
      // а не притворяющаяся рабочей кнопка.
      favBtn.addEventListener("click", function (e) { e.stopPropagation(); toast("Избранное — скоро добавим"); });
      body.appendChild(favBtn);

      var wrap = el("div", "set-detail-body");
      wrap.appendChild(el("h2", "wizard-title", s.display_name));
      if (s.is_variant_group) {
        var minP = Math.min.apply(null, s.variants.map(function (v) { return v.price; }));
        wrap.appendChild(el("div", "set-detail-price", "от " + fmtSum(minP)));
      } else {
        wrap.appendChild(el("div", "set-detail-price", fmtSum(s.price)));
        if (s.has_garnish) wrap.appendChild(el("div", "set-detail-note", "Гарнир выбирается на следующем шаге"));
      }
      body.appendChild(wrap);

      // Первая версия — только витрина реального сегодняшнего меню, сам
      // заказ через приложение пока не принимаем (см. договорённость:
      // "Заказать" -> уведомление, полноценный визард подключим отдельным
      // шагом). startOrderFromCard ниже уже готов и рабочий — просто не
      // вызывается из этой кнопки, пока владелец не попросит включить.
      var orderBtn = el("button", "btn-primary wizard-footer-btn", "Заказать");
      orderBtn.addEventListener("click", function () { toast("Сейчас недоступно для заказа"); });
      body.appendChild(orderBtn);
    });
  }

  function startOrderFromCard(s) {
    if (!state.profile || !state.profile.registered) {
      toast("Сначала зарегистрируйтесь в боте: наберите /start");
      return;
    }
    haptic("select");
    resetOrder();
    if (s.is_variant_group) {
      openWizard(function (body) { stepVariant(body, s); });
    } else {
      openWizard(function (body) {
        order.curSet = s;
        if (s.has_garnish && s.garnish_options.length) {
          stepGarnish(body, s);
        } else {
          order.curGarnish = "";
          stepQty(body);
        }
      });
    }
  }

  function escapeHtml(s) {
    var d = document.createElement("div");
    d.textContent = s;
    return d.innerHTML;
  }

  // -------------------------------------------------------------------
  // PAUSE CLUB — лента
  // -------------------------------------------------------------------

  var FEED_TYPE_LABELS = {
    photo: "Фото", message: "Послание", announcement: "Анонс",
    giveaway: "Розыгрыш", news: "Новость",
  };
  var FEED_TYPES_ORDER = ["photo", "message", "announcement", "giveaway", "news"];

  function apiUploadFeed(type, caption, files) {
    var fd = new FormData();
    fd.append("type", type);
    fd.append("caption", caption || "");
    files.forEach(function (f) { fd.append("photo", f, f.name); });
    return fetch(API_BASE + "/api/feed", {
      method: "POST",
      headers: { "X-Telegram-Init-Data": initData() },
      body: fd,
    }).then(function (resp) {
      if (!resp.ok) {
        return resp.json().catch(function () { return {}; }).then(function (data) {
          throw new Error(data.error || ("HTTP " + resp.status));
        });
      }
      return resp.json();
    });
  }

  // Картинки ленты идут через свой прокси-эндпоинт, который требует ту же
  // подпись initData, что и остальные запросы (см. pauseapp.py:
  // admin_auth_middleware — гейт на КАЖДЫЙ /api/*, без исключений). Обычный
  // <img src="..."> заголовков не шлёт, поэтому картинку сначала тянем
  // сами через fetch() с заголовком и превращаем в blob-URL — простое
  // кэширование в памяти, чтобы при повторном рендере ленты не качать те
  // же файлы заново.
  var _feedImageCache = {};
  function loadFeedImage(url, imgEl) {
    if (_feedImageCache[url]) {
      _feedImageCache[url].then(function (blobUrl) { imgEl.src = blobUrl; });
      return;
    }
    var p = fetch(url, { headers: { "X-Telegram-Init-Data": initData() } })
      .then(function (resp) { if (!resp.ok) throw new Error("HTTP " + resp.status); return resp.blob(); })
      .then(function (blob) { return URL.createObjectURL(blob); });
    _feedImageCache[url] = p;
    p.then(function (blobUrl) { imgEl.src = blobUrl; }).catch(function () { imgEl.style.display = "none"; });
  }

  function loadFeed() {
    var root = document.getElementById("feed-root");
    api("/api/feed").then(function (data) {
      state.feed = data.posts;
      // Один и тот же /api/feed кормит два экрана — CLUB (все типы) и
      // Послания (см. renderMessagesFeedScreen, без типа "photo") — оба
      // просто перерисовываются сразу, независимо от того, какой сейчас
      // виден; невидимый экран просто перерисуется молча, это дёшево.
      renderFeedScreen();
      renderMessagesFeedScreen();
    }).catch(function () {
      root.innerHTML = "";
      root.appendChild(el("div", "feed-empty", "Не удалось загрузить ленту — потяните вниз, чтобы попробовать снова."));
      var msgRoot = document.getElementById("messages-feed-root");
      msgRoot.innerHTML = "";
      msgRoot.appendChild(el("div", "feed-empty", "Не удалось загрузить послания — потяните вниз, чтобы попробовать снова."));
    });
  }

  function renderFeedFilters() {
    var root = document.getElementById("feed-filters");
    root.innerHTML = "";
    var counts = {};
    (state.feed || []).forEach(function (p) { counts[p.type] = (counts[p.type] || 0) + 1; });

    var allChip = el("button", "filter-chip" + (state.feedFilter === "all" ? " active" : ""), "Все");
    allChip.addEventListener("click", function () { state.feedFilter = "all"; renderFeedScreen(); });
    root.appendChild(allChip);

    FEED_TYPES_ORDER.forEach(function (t) {
      if (!counts[t]) return;
      var chip = el("button", "filter-chip" + (state.feedFilter === t ? " active" : ""), FEED_TYPE_LABELS[t]);
      chip.addEventListener("click", function () { state.feedFilter = t; renderFeedScreen(); });
      root.appendChild(chip);
    });
  }

  function renderFeedScreen() {
    screenHeader("club-header", {
      title: "Pause Club",
      right: { icon: ICON_KEBAB, label: "Ещё", onClick: function () { toast("Скоро добавим"); } },
    });
    renderFeedFilters();
    var root = document.getElementById("feed-root");
    root.innerHTML = "";
    var posts = (state.feed || []).filter(function (p) { return state.feedFilter === "all" || p.type === state.feedFilter; });

    if (!posts.length) {
      root.appendChild(el("div", "feed-empty", "<div>" + ICON_LEAF + "</div><p>Пока здесь тихо — самое время опубликовать первый пост.</p>"));
      return;
    }

    // Отдельный чип "Фото" — сеткой миниатюр (как на макете), а не
    // полноразмерными карточками; остальные фильтры (включая "Все") —
    // обычный вертикальный список карточек, как и раньше.
    if (state.feedFilter === "photo") {
      var grid = el("div", "feed-photo-grid");
      posts.forEach(function (post) {
        var url = (post.image_urls || [])[0];
        if (!url) return;
        var cell = el("div", "feed-photo-cell");
        var img = el("img", "feed-photo-thumb");
        img.alt = "";
        cell.appendChild(img);
        loadFeedImage(url, img);
        cell.addEventListener("click", function () { openFeedPostDetail(post); });
        grid.appendChild(cell);
      });
      root.appendChild(grid);
      return;
    }

    posts.forEach(function (post) { root.appendChild(buildFeedPostCard(post)); });
  }

  // Открывает один пост ленты крупно (из сетки миниатюр) — переиспользует
  // ровно ту же карточку, что и обычный список, просто в оверлее визарда.
  function openFeedPostDetail(post) {
    haptic("select");
    openWizard(function (body) {
      wizardPhaseEl.innerHTML = "";
      body.appendChild(buildFeedPostCard(post));
    });
  }

  // -------------------------------------------------------------------
  // Послания — отдельный экран нижней навигации (на макете это своя
  // вкладка, не фильтр внутри CLUB). Данные те же самые /api/feed, что и
  // у CLUB (см. loadFeed) — просто без типа "photo" (фото — только в
  // CLUB) и со своим набором чипов/своим выбранным фильтром.
  // -------------------------------------------------------------------

  var MESSAGES_TYPES_ORDER = ["message", "announcement", "giveaway", "news"];

  function messagesFeedPosts() {
    return (state.feed || []).filter(function (p) { return p.type !== "photo"; });
  }

  function renderMessagesFeedFilters() {
    var root = document.getElementById("messages-feed-filters");
    root.innerHTML = "";
    var counts = {};
    messagesFeedPosts().forEach(function (p) { counts[p.type] = (counts[p.type] || 0) + 1; });

    var allChip = el("button", "filter-chip" + (state.messagesFilter === "all" ? " active" : ""), "Все");
    allChip.addEventListener("click", function () { state.messagesFilter = "all"; renderMessagesFeedScreen(); });
    root.appendChild(allChip);

    MESSAGES_TYPES_ORDER.forEach(function (t) {
      if (!counts[t]) return;
      var chip = el("button", "filter-chip" + (state.messagesFilter === t ? " active" : ""), FEED_TYPE_LABELS[t]);
      chip.addEventListener("click", function () { state.messagesFilter = t; renderMessagesFeedScreen(); });
      root.appendChild(chip);
    });
  }

  function renderMessagesFeedScreen() {
    screenHeader("messages-header", {
      title: "Послания",
      right: { icon: ICON_KEBAB, label: "Ещё", onClick: function () { toast("Скоро добавим"); } },
    });
    var root = document.getElementById("messages-feed-root");
    renderMessagesFeedFilters();
    root.innerHTML = "";
    var posts = messagesFeedPosts().filter(function (p) {
      return state.messagesFilter === "all" || p.type === state.messagesFilter;
    });
    if (!posts.length) {
      root.appendChild(el("div", "feed-empty", "<div>" + ICON_LEAF + "</div><p>Пока никаких посланий нет.</p>"));
      return;
    }
    posts.forEach(function (post) { root.appendChild(buildFeedPostCard(post)); });
  }

  function buildFeedPostCard(post) {
    var card = el("div", "card feed-post feed-post-" + post.type);

    var delBtn = el("button", "feed-post-delete", "×");
    delBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      showConfirm("Удалить этот пост из ленты?", "Да, удалить", function () { deleteFeedPost(post.id); });
    });
    card.appendChild(delBtn);

    (post.image_urls || []).forEach(function (url) {
      var img = el("img", "feed-post-photo");
      img.alt = "";
      card.appendChild(img);
      loadFeedImage(url, img);
    });

    var body = el("div", "feed-post-body");
    if (post.type !== "message") {
      var typeRow = el("div", "feed-post-type-row");
      typeRow.appendChild(el("span", "pill" + (post.type === "giveaway" ? " gold" : " muted") + " feed-type-pill", FEED_TYPE_LABELS[post.type] || post.type));
      body.appendChild(typeRow);
    }
    if (post.caption) body.appendChild(el("div", "feed-post-caption", escapeHtml(post.caption)));
    var meta = el("div", "feed-post-meta");
    meta.innerHTML = '<span class="feed-post-date">' + escapeHtml(post.date) + '</span><span class="feed-post-author">' + escapeHtml(post.author) + '</span>';
    body.appendChild(meta);
    card.appendChild(body);

    return card;
  }

  function deleteFeedPost(id) {
    api("/api/feed/delete", { method: "POST", body: { id: id } }).then(function () {
      haptic("success");
      toast("Пост удалён");
      state.feed = (state.feed || []).filter(function (p) { return p.id !== id; });
      renderFeedScreen();
    }).catch(function (err) { toast("Не удалось удалить: " + err.message); });
  }

  document.getElementById("feed-compose-btn").addEventListener("click", openComposeFeed);

  function openComposeFeed() {
    var compose = { type: "photo", caption: "", files: [] };

    function renderComposeStep(body) {
      wizardPhaseEl.innerHTML = "";
      body.appendChild(el("h2", "wizard-title", "Новый пост"));

      var typeRow = el("div", "type-picker-row");
      FEED_TYPES_ORDER.forEach(function (t) {
        var chip = el("button", "type-picker-chip" + (compose.type === t ? " selected" : ""), FEED_TYPE_LABELS[t]);
        chip.addEventListener("click", function () { compose.type = t; wizardReplace(renderComposeStep); });
        typeRow.appendChild(chip);
      });
      body.appendChild(typeRow);

      var captionField = el("div", "field");
      captionField.innerHTML = '<label>' + (compose.type === "photo" ? "Подпись (необязательно)" : "Текст поста") + '</label><textarea id="feed-caption" rows="4"></textarea>';
      body.appendChild(captionField);
      body.querySelector("#feed-caption").value = compose.caption;
      body.querySelector("#feed-caption").addEventListener("input", function (e) { compose.caption = e.target.value; });

      if (compose.type === "photo") {
        var uploadZone = el("div", "upload-zone", "Нажмите, чтобы выбрать фото (можно несколько)");
        var input = el("input");
        input.type = "file"; input.accept = "image/*"; input.multiple = true; input.style.display = "none";
        uploadZone.appendChild(input);
        body.appendChild(uploadZone);
        var grid = el("div", "photo-picker-grid");
        body.appendChild(grid);
        uploadZone.addEventListener("click", function () { input.click(); });
        input.addEventListener("change", function () {
          compose.files = Array.prototype.slice.call(input.files);
          grid.innerHTML = "";
          compose.files.forEach(function (f) {
            var thumb = el("img", "photo-picker-thumb");
            thumb.src = URL.createObjectURL(f);
            grid.appendChild(thumb);
          });
        });
      }

      var submit = el("button", "btn-primary wizard-footer-btn", "Опубликовать");
      submit.addEventListener("click", function () {
        if (compose.type === "photo" && !compose.files.length) { toast("Выберите хотя бы одно фото"); return; }
        if (compose.type !== "photo" && !compose.caption.trim()) { toast("Напишите текст поста"); return; }
        submit.disabled = true;
        submit.textContent = "Публикую…";
        apiUploadFeed(compose.type, compose.caption, compose.files).then(function () {
          haptic("success");
          toast("Опубликовано");
          closeWizard();
          state.feed = null;
          loadFeed();
        }).catch(function (err) {
          submit.disabled = false;
          submit.textContent = "Опубликовать";
          toast("Не удалось опубликовать: " + err.message);
        });
      });
      body.appendChild(submit);
    }

    openWizard(renderComposeStep);
  }

  // -------------------------------------------------------------------
  // ЗАКАЗ — состояние корзины на время визарда
  // -------------------------------------------------------------------

  var order = {};
  function resetOrder() {
    order = { cart: [], zone: "", point: "", isNewPoint: false, comment: "", payment: "", screenshotFileId: null };
  }

  // --- Шаг: выбор сета (вторичный, изнутри визарда — см. "+ Ещё сет" в
  // stepCart; первичный вход теперь с самого экрана Меню, см.
  // startOrderFromCard) -------------------------------------------------

  function stepSets(body) {
    setWizardPhase(0, 4);
    body.appendChild(el("h2", "wizard-title", order.cart.length ? "Добавить ещё сет" : "Что будем заказывать?"));
    state.menu.sets.forEach(function (s) {
      var card = el("div", "card set-card");
      var main = el("div", "set-card-main");
      main.appendChild(el("div", "set-card-name", s.display_name));
      if (s.is_variant_group) {
        var minP = Math.min.apply(null, s.variants.map(function (v) { return v.price; }));
        main.appendChild(el("div", "set-card-price", "от " + fmtSum(minP)));
      } else {
        main.appendChild(el("div", "set-card-price", fmtSum(s.price)));
        if (s.has_garnish) main.appendChild(el("div", "set-card-garnish-note", "с выбором гарнира"));
      }
      card.appendChild(main);
      card.appendChild(el("div", "set-card-chevron", '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M9 6l6 6-6 6"/></svg>'));
      card.addEventListener("click", function () {
        haptic("select");
        if (s.is_variant_group) wizardStep(function (b) { stepVariant(b, s); });
        else chooseSet(s);
      });
      body.appendChild(card);
    });
    if (order.cart.length) {
      var doneBtn = el("button", "btn-ghost", "Дальше →");
      doneBtn.style.marginTop = "16px";
      doneBtn.addEventListener("click", function () { wizardStep(stepPoint); });
      body.appendChild(doneBtn);
    }
  }

  function stepVariant(body, group) {
    setWizardPhase(0, 4);
    body.appendChild(el("h2", "wizard-title", group.display_name));
    group.variants.forEach(function (v) {
      var row = el("div", "card option-row");
      row.appendChild(el("div", null, '<div class="option-row-label">' + v.label + '</div><div class="option-row-sub">' + fmtSum(v.price) + '</div>'));
      row.addEventListener("click", function () {
        haptic("select");
        chooseSet({ key: v.technical, display_name: group.display_name + " · " + v.label, price: v.price, has_garnish: v.has_garnish, garnish_options: v.garnish_options });
      });
      body.appendChild(row);
    });
  }

  function chooseSet(s) {
    order.curSet = s;
    if (s.has_garnish && s.garnish_options.length) {
      wizardStep(function (b) { stepGarnish(b, s); });
    } else {
      order.curGarnish = "";
      wizardStep(stepQty);
    }
  }

  function stepGarnish(body, s) {
    setWizardPhase(0, 4);
    body.appendChild(el("h2", "wizard-title", "Гарнир — " + s.display_name));
    s.garnish_options.forEach(function (g) {
      var row = el("div", "card option-row");
      row.appendChild(el("div", "option-row-label", g.display));
      row.addEventListener("click", function () {
        haptic("select");
        order.curGarnish = g.value;
        wizardStep(stepQty);
      });
      body.appendChild(row);
    });
  }

  function stepQty(body) {
    setWizardPhase(0, 4);
    var qty = 1;
    body.appendChild(el("h2", "wizard-title", "Сколько порций?"));
    var stepper = el("div", "stepper");
    var minus = el("button", "stepper-btn", "–");
    var value = el("div", "stepper-value", "1");
    var plus = el("button", "stepper-btn", "+");
    minus.addEventListener("click", function () { if (qty > 1) { qty--; value.textContent = qty; haptic(); } });
    plus.addEventListener("click", function () { qty++; value.textContent = qty; haptic(); });
    stepper.appendChild(minus); stepper.appendChild(value); stepper.appendChild(plus);
    body.appendChild(stepper);

    var nextBtn = el("button", "btn-primary wizard-footer-btn", "Добавить в заказ");
    nextBtn.addEventListener("click", function () {
      order.cart.push({ set: order.curSet.key, display: order.curSet.display_name, garnish: order.curGarnish || "", garnishDisplay: garnishDisplayFor(order.curSet, order.curGarnish), price: order.curSet.price || 0, qty: qty });
      order.curSet = null;
      order.curGarnish = "";
      wizardStep(stepCart);
    });
    body.appendChild(nextBtn);
  }

  function garnishDisplayFor(s, value) {
    if (!value || !s.garnish_options) return "";
    var found = s.garnish_options.filter(function (g) { return g.value === value; })[0];
    return found ? found.display : value;
  }

  function stepCart(body) {
    setWizardPhase(0, 4);
    body.appendChild(el("h2", "wizard-title", "Ваша корзина"));
    var card = el("div", "card");
    order.cart.forEach(function (item, idx) {
      var row = el("div", "cart-row");
      var left = el("div");
      left.appendChild(el("div", "cart-row-name", item.qty + "× " + item.display));
      if (item.garnishDisplay) left.appendChild(el("div", "cart-row-sub", item.garnishDisplay));
      row.appendChild(left);
      var right = el("div", null, '<span class="cart-row-sum">' + fmtSum(item.price * item.qty) + '</span>');
      var rm = el("button", "cart-row-remove", "×");
      rm.addEventListener("click", function () { order.cart.splice(idx, 1); wizardReplace(stepCart); });
      right.appendChild(rm);
      row.appendChild(right);
      card.appendChild(row);
    });
    var total = order.cart.reduce(function (s, i) { return s + i.price * i.qty; }, 0);
    var totalRow = el("div", "summary-total");
    totalRow.innerHTML = '<span class="summary-total-label">Итого</span><span class="summary-total-value">' + fmtSum(total) + '</span>';
    card.appendChild(totalRow);
    body.appendChild(card);

    var addMore = el("button", "btn-ghost", "+ Ещё сет");
    addMore.style.marginTop = "14px";
    addMore.addEventListener("click", function () { wizardStep(stepSets); });
    body.appendChild(addMore);

    var next = el("button", "btn-primary wizard-footer-btn", "Дальше →");
    next.addEventListener("click", function () { wizardStep(stepPoint); });
    body.appendChild(next);
  }

  // --- Шаг: точка доставки ---------------------------------------------

  function stepPoint(body) {
    setWizardPhase(1, 4);
    var profile = state.profile;
    var hasDefault = profile.zone && profile.point;

    if (hasDefault && !order._pointStepShown) {
      order.zone = profile.zone; order.point = profile.point; order.isNewPoint = false;
    }

    body.appendChild(el("h2", "wizard-title", "Куда доставить?"));

    if (order.zone && order.point) {
      var card = el("div", "card");
      card.innerHTML = '<div class="list-row-label" style="font-weight:600;color:var(--ink)">' + order.zone + '</div><div class="list-row-value" style="text-align:left;margin-top:2px">' + order.point + '</div>';
      body.appendChild(card);
      var change = el("button", "btn-text", "Изменить точку");
      change.style.marginTop = "10px";
      change.addEventListener("click", function () { order.zone = ""; order.point = ""; wizardReplace(stepPoint); });
      body.appendChild(change);

      var next = el("button", "btn-primary wizard-footer-btn", "Дальше →");
      next.addEventListener("click", function () { wizardStep(stepComment); });
      body.appendChild(next);
      return;
    }

    order._pointStepShown = true;
    renderZonePicker(body);
  }

  function renderZonePicker(body) {
    api("/api/zones").then(function (data) {
      data.zones.forEach(function (z) {
        var row = el("div", "card option-row");
        row.appendChild(el("div", "option-row-label", z));
        row.addEventListener("click", function () { haptic("select"); wizardStep(function (b) { renderPointPicker(b, z); }); });
        body.appendChild(row);
      });
      var otherRow = el("div", "card option-row");
      otherRow.appendChild(el("div", "option-row-label", "Другой район"));
      otherRow.addEventListener("click", function () { haptic("select"); wizardStep(function (b) { renderNewPointForm(b, ""); }); });
      body.appendChild(otherRow);
    });
  }

  function renderPointPicker(body, zone) {
    setWizardPhase(1, 4);
    body.appendChild(el("h2", "wizard-title", zone));
    api("/api/points?zone=" + encodeURIComponent(zone)).then(function (data) {
      if (!data.points.length) {
        renderNewPointForm(body, zone);
        return;
      }
      data.points.forEach(function (p) {
        var row = el("div", "card option-row");
        row.appendChild(el("div", "option-row-label", p));
        row.addEventListener("click", function () {
          haptic("select");
          order.zone = zone; order.point = p; order.isNewPoint = false;
          wizardStep(stepComment);
        });
        body.appendChild(row);
      });
      var otherRow = el("div", "card option-row");
      otherRow.appendChild(el("div", "option-row-label", "Другая точка"));
      otherRow.addEventListener("click", function () { haptic("select"); wizardStep(function (b) { renderNewPointForm(b, zone); }); });
      body.appendChild(otherRow);
    });
  }

  function renderNewPointForm(body, zone) {
    setWizardPhase(1, 4);
    body.appendChild(el("h2", "wizard-title", "Новая точка"));
    body.appendChild(el("p", null, "Впишите адрес или название места — мы уточним и добавим в справочник. Заказ примем сразу, как координатор подтвердит точку."));
    var field = el("div", "field");
    field.innerHTML = '<label>Адрес / название точки</label><input type="text" id="new-point-input" placeholder="Например: офис Malika Plaza, 4 этаж">';
    body.appendChild(field);
    if (!zone) {
      var zf = el("div", "field");
      zf.innerHTML = '<label>Район</label><input type="text" id="new-zone-input" placeholder="Например: Юнусабад">';
      body.insertBefore(zf, field);
    }
    var next = el("button", "btn-primary wizard-footer-btn", "Дальше →");
    next.addEventListener("click", function () {
      var pointVal = document.getElementById("new-point-input").value.trim();
      var zoneVal = zone || (document.getElementById("new-zone-input") || {}).value || "";
      zoneVal = zoneVal.trim();
      if (!pointVal || !zoneVal) { toast("Заполните район и точку"); return; }
      order.zone = zoneVal; order.point = pointVal; order.isNewPoint = true;
      wizardStep(stepComment);
    });
    body.appendChild(next);
  }

  // --- Шаг: комментарий --------------------------------------------------

  function stepComment(body) {
    setWizardPhase(2, 4);
    body.appendChild(el("h2", "wizard-title", "Комментарий к заказу"));
    body.appendChild(el("p", null, "Необязательно — например, код домофона или пожелание к доставке."));
    var field = el("div", "field");
    field.style.marginTop = "14px";
    field.innerHTML = '<textarea id="comment-input" rows="3" placeholder="Например: домофон 45К, позвонить за 5 минут">' + (order.comment || "") + '</textarea>';
    body.appendChild(field);
    var next = el("button", "btn-primary wizard-footer-btn", "Дальше →");
    next.addEventListener("click", function () {
      order.comment = document.getElementById("comment-input").value.trim();
      wizardStep(stepPayment);
    });
    body.appendChild(next);
  }

  // --- Шаг: оплата ---------------------------------------------------

  function stepPayment(body) {
    setWizardPhase(3, 4);
    body.appendChild(el("h2", "wizard-title", "Способ оплаты"));
    state.menu.payment_options.forEach(function (p) {
      var row = el("div", "card option-row" + (order.payment === p ? " selected" : ""));
      row.appendChild(el("div", "option-row-label", p));
      row.appendChild(el("div", "option-row-check"));
      row.addEventListener("click", function () {
        haptic("select");
        order.payment = p;
        if (/карт/i.test(p)) wizardStep(stepCardDecision);
        else { order.screenshotFileId = null; wizardStep(stepSummary); }
      });
      body.appendChild(row);
    });
  }

  function stepCardDecision(body) {
    setWizardPhase(3, 4);
    body.appendChild(el("h2", "wizard-title", "Реквизиты для оплаты"));
    body.appendChild(el("div", "requisites-box", escapeHtml(state.menu.card_requisites)));
    var now = el("button", "btn-primary", "Отправить скрин сейчас");
    now.addEventListener("click", function () { wizardStep(stepScreenshot); });
    var later = el("button", "btn-ghost", "Пришлю скрин позже");
    later.style.marginTop = "10px";
    later.addEventListener("click", function () { order.screenshotFileId = null; wizardStep(stepSummary); });
    body.appendChild(now);
    body.appendChild(later);
  }

  function stepScreenshot(body) {
    setWizardPhase(3, 4);
    body.appendChild(el("h2", "wizard-title", "Скрин оплаты"));
    var zone = el("div", "upload-zone", "Нажмите, чтобы выбрать фото скрина оплаты");
    var input = el("input");
    input.type = "file"; input.accept = "image/*"; input.style.display = "none";
    zone.appendChild(input);
    body.appendChild(zone);
    zone.addEventListener("click", function () { input.click(); });

    var next = el("button", "btn-primary wizard-footer-btn", "Загрузить и продолжить");
    next.disabled = true;
    body.appendChild(next);

    var chosenFile = null;
    input.addEventListener("change", function () {
      if (!input.files || !input.files[0]) return;
      chosenFile = input.files[0];
      var img = el("img", "upload-preview");
      img.src = URL.createObjectURL(chosenFile);
      zone.appendChild(img);
      zone.textContent = "";
      zone.appendChild(img);
      next.disabled = false;
    });

    next.addEventListener("click", function () {
      if (!chosenFile) return;
      next.disabled = true;
      next.textContent = "Загружаю…";
      apiUpload("/api/order/screenshot", chosenFile, chosenFile.name).then(function (data) {
        order.screenshotFileId = data.file_id;
        haptic("success");
        wizardStep(stepSummary);
      }).catch(function (err) {
        next.disabled = false;
        next.textContent = "Загрузить и продолжить";
        toast("Не удалось загрузить скрин: " + err.message);
      });
    });
  }

  // --- Шаг: сводка и подтверждение ---------------------------------------

  function stepSummary(body) {
    setWizardPhase(3, 4);
    body.appendChild(el("h2", "wizard-title", "Проверьте заказ"));
    var card = el("div", "card");
    order.cart.forEach(function (item) {
      var row = el("div", "cart-row");
      var left = el("div");
      left.appendChild(el("div", "cart-row-name", item.qty + "× " + item.display));
      if (item.garnishDisplay) left.appendChild(el("div", "cart-row-sub", item.garnishDisplay));
      row.appendChild(left);
      row.appendChild(el("span", "cart-row-sum", fmtSum(item.price * item.qty)));
      card.appendChild(row);
    });
    var total = order.cart.reduce(function (s, i) { return s + i.price * i.qty; }, 0);
    var totalRow = el("div", "summary-total");
    totalRow.innerHTML = '<span class="summary-total-label">Итого</span><span class="summary-total-value">' + fmtSum(total) + '</span>';
    card.appendChild(totalRow);
    body.appendChild(card);

    var info = el("div", "card");
    info.style.marginTop = "12px";
    var lines = [];
    lines.push('<div class="list-row"><span class="list-row-label">Куда</span><span class="list-row-value">' + escapeHtml(order.zone + ", " + order.point) + '</span></div>');
    lines.push('<div class="list-row"><span class="list-row-label">Оплата</span><span class="list-row-value">' + escapeHtml(order.payment) + (order.screenshotFileId ? " · скрин приложен" : "") + '</span></div>');
    if (order.comment) lines.push('<div class="list-row"><span class="list-row-label">Комментарий</span><span class="list-row-value">' + escapeHtml(order.comment) + '</span></div>');
    if (order.isNewPoint) lines.push('<div class="list-row"><span class="list-row-label">⚠️</span><span class="list-row-value">Новая точка — заказ подтвердит координатор</span></div>');
    info.innerHTML = lines.join("");
    body.appendChild(info);

    var confirmBtn = el("button", "btn-primary wizard-footer-btn", "Всё верно, отправить");
    confirmBtn.addEventListener("click", function () { submitOrder(confirmBtn); });
    body.appendChild(confirmBtn);

    var restart = el("button", "btn-ghost", "Начать заново");
    restart.style.marginTop = "10px";
    restart.addEventListener("click", function () { resetOrder(); wizardReplace(stepSets); });
    body.appendChild(restart);
  }

  function submitOrder(btn) {
    btn.disabled = true;
    btn.textContent = "Отправляю…";
    api("/api/order", {
      method: "POST",
      body: {
        cart: order.cart.map(function (i) { return { set: i.set, garnish: i.garnish, qty: i.qty }; }),
        zone: order.zone, point: order.point, is_new_point: order.isNewPoint,
        comment: order.comment, payment: order.payment, screenshot_file_id: order.screenshotFileId,
      },
    }).then(function (data) {
      haptic("success");
      if (data.status === "pending") wizardStep(function (b) { stepPendingSuccess(b); });
      else wizardStep(function (b) { stepDone(b, data.care); });
      state.menu = null; // при следующем открытии перечитаем актуальное меню
    }).catch(function (err) {
      btn.disabled = false;
      btn.textContent = "Всё верно, отправить";
      haptic("error");
      toast("Не удалось отправить заказ: " + err.message);
    });
  }

  function stepDone(body, care) {
    wizardPhaseEl.innerHTML = "";
    document.getElementById("wizard-back").style.visibility = "hidden";
    body.innerHTML =
      '<div style="text-align:center;padding:40px 10px 0">' +
      '<div style="color:var(--ink);margin-bottom:18px">' + ICON_LEAF + '</div>' +
      '<h2>Заказ отправлен 🌿</h2>' +
      (care ? '<p style="margin-top:14px;font-weight:600;font-size:17px;color:var(--ink)">«' + escapeHtml(care.phrase) + '»</p><p style="margin-top:6px;font-size:12px">послание № ' + care.number + ' из ' + care.total + '</p>' : "") +
      '</div>';
    var done = el("button", "btn-primary wizard-footer-btn", "Готово");
    done.addEventListener("click", function () { closeWizard(); state.profile = null; showScreen("menu"); loadMenu(); });
    body.appendChild(done);
  }

  function stepPendingSuccess(body) {
    wizardPhaseEl.innerHTML = "";
    document.getElementById("wizard-back").style.visibility = "hidden";
    body.innerHTML =
      '<div style="text-align:center;padding:40px 10px 0">' +
      '<div style="color:var(--ink);margin-bottom:18px">' + ICON_CLOCK + '</div>' +
      '<h2>Точка на проверке</h2>' +
      '<p style="margin-top:10px">Координатор уточнит адрес и подтвердит заказ — обычно это быстро. Мы напишем, как только всё готово.</p>' +
      '</div>';
    var done = el("button", "btn-primary wizard-footer-btn", "Готово");
    done.addEventListener("click", function () { closeWizard(); showScreen("menu"); });
    body.appendChild(done);
  }

  // -------------------------------------------------------------------
  // ПРОФИЛЬ
  // -------------------------------------------------------------------

  function loadProfile() {
    var root = document.getElementById("profile-root");
    // Заодно подгружаем ленту, если её ещё нет — нужна только для счётчика
    // "постов" в статистике (см. renderProfileScreen); если запрос не
    // удастся, профиль всё равно должен открыться, просто без этого
    // счётчика — поэтому свой catch, а не общий с профилем.
    var feedPromise = state.feed ? Promise.resolve() : api("/api/feed").then(function (data) { state.feed = data.posts; }).catch(function () {});
    Promise.all([api("/api/profile"), feedPromise]).then(function (results) {
      state.profile = results[0];
      renderProfileScreen();
    }).catch(function (err) {
      root.innerHTML = "";
      root.appendChild(el("div", "empty-note", "Не удалось загрузить профиль: " + err.message));
    });
  }

  function tgPhotoUrl() {
    try {
      var u = tg && tg.initDataUnsafe && tg.initDataUnsafe.user;
      return u && u.photo_url ? u.photo_url : null;
    } catch (e) { return null; }
  }

  function tgUsername() {
    try {
      var u = tg && tg.initDataUnsafe && tg.initDataUnsafe.user;
      return u && u.username ? u.username : null;
    } catch (e) { return null; }
  }

  // Иконки строк меню профиля — чисто декоративные, 20×20.
  var ICON_ORDERS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="20" height="20"><rect x="5" y="3" width="14" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/></svg>';
  // Стандартный симметричный контур сердца (Feather Icons, heart) —
  // прошлый путь был кривой ручной работы, левая и правая половины не
  // совпадали.
  var ICON_HEART = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" width="20" height="20" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>';
  var ICON_ENVELOPE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="20" height="20"><rect x="3.5" y="5.5" width="17" height="13" rx="2.5"/><path d="M4.5 7 12 12.5 19.5 7"/></svg>';
  var ICON_BELL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="20" height="20"><path d="M6 10a6 6 0 1 1 12 0c0 4 1.5 5.5 1.5 5.5h-15S6 14 6 10Z"/><path d="M10 18a2 2 0 0 0 4 0"/></svg>';
  var ICON_TAG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="20" height="20"><path d="M3 12 12 3h7v7l-9 9-7-7Z"/><circle cx="15.5" cy="7.5" r="1.2"/></svg>';
  var ICON_SLIDERS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="20" height="20"><path d="M4 7h11M4 12h16M4 17h8"/><circle cx="17" cy="7" r="1.6"/><circle cx="9" cy="17" r="1.6"/></svg>';
  var ICON_SUPPORT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="20" height="20"><circle cx="12" cy="12" r="9"/><path d="M9.3 9.7a2.7 2.7 0 1 1 3.7 2.5c-.7.3-1 .9-1 1.6v.3"/><circle cx="12" cy="16.8" r="0.6" fill="currentColor" stroke="none"/></svg>';

  // Иконки блока "Поддержка" — Telegram, Instagram, телефон.
  var ICON_TELEGRAM = '<svg viewBox="0 0 24 24" fill="currentColor" width="22" height="22"><path d="M21.4 3.5 2.9 10.9c-1.2.5-1.2 1.2-.2 1.5l4.7 1.5 1.8 5.6c.2.6.4.8.8.8.3 0 .5-.1.7-.3l2.5-2.4 4.9 3.6c.9.5 1.5.2 1.7-.8l3.2-15c.3-1.3-.4-1.8-1.6-1.4Zm-11.8 10.6-1.1-3.7 8.9-5.5c.4-.3.8-.1.5.2l-8.3 8.9Z"/></svg>';
  var ICON_INSTAGRAM = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" width="21" height="21"><rect x="3.5" y="3.5" width="17" height="17" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.2" cy="6.8" r="0.9" fill="currentColor" stroke="none"/></svg>';
  var ICON_PHONE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" width="21" height="21" stroke-linecap="round" stroke-linejoin="round"><path d="M6.6 10.8a15.5 15.5 0 0 0 6.6 6.6l2.2-2.2a1.5 1.5 0 0 1 1.5-.4c1.1.4 2.3.6 3.6.6a1.5 1.5 0 0 1 1.5 1.5V20a1.5 1.5 0 0 1-1.5 1.5C10.6 21.5 2.5 13.4 2.5 3.5A1.5 1.5 0 0 1 4 2h2.1a1.5 1.5 0 0 1 1.5 1.5c0 1.3.2 2.5.6 3.6a1.5 1.5 0 0 1-.4 1.5z"/></svg>';
  var ICON_STAR = '<svg viewBox="0 0 24 24" width="34" height="34"><path d="M12 2.5l2.9 6.3 6.8.7-5.1 4.7 1.5 6.8-6.1-3.6-6.1 3.6 1.5-6.8-5.1-4.7 6.8-.7Z"/></svg>';

  function buildProfileRow(icon, label, onClick) {
    var row = el("div", "profile-nav-row");
    row.innerHTML =
      '<span class="profile-nav-row-icon">' + icon + '</span>' +
      '<span class="profile-nav-row-label">' + escapeHtml(label) + '</span>' +
      '<span class="profile-nav-row-chevron"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M9 6l6 6-6 6"/></svg></span>';
    row.addEventListener("click", function () { haptic("select"); onClick(); });
    return row;
  }

  // Открывает содержимое одного раздела профиля в оверлее визарда —
  // loaderFn это уже существующие loadOrders/loadMessages(root), просто
  // теперь вызываются по тапу на строку, а не сразу все разом на экране.
  function openProfileSubscreen(title, loaderFn) {
    openWizard(function (body) {
      wizardPhaseEl.innerHTML = "";
      body.appendChild(el("h2", "wizard-title", title));
      var sub = el("div");
      sub.appendChild(el("div", "skeleton-block"));
      body.appendChild(sub);
      loaderFn(sub);
    });
  }

  function openSettingsSubscreen() {
    var p = state.profile;
    openWizard(function (body) {
      wizardPhaseEl.innerHTML = "";
      body.appendChild(el("h2", "wizard-title", "Настройки"));
      var pointCard = el("div", "card");
      pointCard.innerHTML =
        '<div class="list-row"><span class="list-row-label">Точка доставки</span><span class="list-row-value">' +
        escapeHtml((p.zone && p.point) ? (p.zone + ", " + p.point) : "не указана") + '</span></div>';
      body.appendChild(pointCard);
      var editBtn = el("button", "btn-ghost", "Редактировать профиль");
      editBtn.style.marginTop = "12px";
      editBtn.addEventListener("click", function () { editState = {}; openEditProfile(); });
      body.appendChild(editBtn);
    });
  }

  function buildContactRow(icon, label, value, href) {
    var row = el("a", "profile-nav-row contact-row");
    row.href = href;
    row.target = "_blank";
    row.rel = "noopener";
    row.innerHTML =
      '<span class="profile-nav-row-icon">' + icon + '</span>' +
      '<span class="profile-nav-row-label">' + escapeHtml(label) +
      '<span class="contact-row-value">' + escapeHtml(value) + '</span></span>' +
      '<span class="profile-nav-row-chevron"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M9 6l6 6-6 6"/></svg></span>';
    row.addEventListener("click", function () { haptic("select"); });
    return row;
  }

  function buildToggleRow(title, subtitle, initialOn, onChange) {
    var row = el("div", "toggle-row");
    var text = el("div", "toggle-row-text");
    text.innerHTML = '<div class="toggle-row-title">' + escapeHtml(title) + '</div><div class="toggle-row-sub">' + escapeHtml(subtitle) + '</div>';
    row.appendChild(text);
    var sw = el("button", "toggle-switch" + (initialOn ? " on" : ""));
    sw.setAttribute("aria-label", title);
    sw.addEventListener("click", function () {
      var next = !sw.classList.contains("on");
      sw.classList.toggle("on", next);
      onChange(next);
    });
    row.appendChild(sw);
    return row;
  }

  function openNotifySubscreen() {
    openWizard(function (body) {
      wizardPhaseEl.innerHTML = "";
      body.appendChild(el("h2", "wizard-title", "Уведомления"));
      var listWrap = el("div");
      listWrap.appendChild(el("div", "skeleton-block"));
      body.appendChild(listWrap);

      api("/api/notify").then(function (data) {
        listWrap.innerHTML = "";
        var card = el("div", "card");
        card.appendChild(buildToggleRow(
          "Утреннее напоминание",
          "Тёплое сообщение утром с напоминанием заказать",
          data.morning_on,
          function (on) {
            api("/api/notify", { method: "POST", body: { morning_on: on } })
              .then(function () { toast(on ? "Включено" : "Отключено"); })
              .catch(function () { toast("Не удалось сохранить"); });
          }
        ));
        card.appendChild(buildToggleRow(
          "О публикации меню",
          "Сообщение, когда на сегодня опубликовано новое меню",
          data.menu_on,
          function (on) {
            api("/api/notify", { method: "POST", body: { menu_on: on } })
              .then(function () { toast(on ? "Включено" : "Отключено"); })
              .catch(function () { toast("Не удалось сохранить"); });
          }
        ));
        listWrap.appendChild(card);
        listWrap.appendChild(el("p", "center-note", "Время рассылок пока общее для всех — своё время для каждого добавим отдельно, если понадобится."));
      }).catch(function () {
        listWrap.innerHTML = "";
        listWrap.appendChild(el("div", "empty-note", "Не удалось загрузить настройки уведомлений."));
      });
    });
  }

  function openSupportSubscreen() {
    openWizard(function (body) {
      wizardPhaseEl.innerHTML = "";
      body.appendChild(el("h2", "wizard-title", "Поддержка"));
      body.appendChild(el("p", null, "С любыми предложениями или проблемами обращайтесь сюда — мы всегда на связи и рады помочь."));

      body.appendChild(el("div", "profile-section-title", "Соцсети"));
      var social = el("div", "card profile-nav-list");
      social.appendChild(buildContactRow(ICON_TELEGRAM, "Telegram", "@ssaavveeyy", "https://t.me/ssaavveeyy"));
      social.appendChild(buildContactRow(ICON_INSTAGRAM, "Instagram", "@pause.tashkent", "https://instagram.com/pause.tashkent"));
      body.appendChild(social);

      body.appendChild(el("div", "profile-section-title", "Контакты"));
      var contacts = el("div", "card profile-nav-list");
      contacts.appendChild(buildContactRow(ICON_PHONE, "Телефон", "+998 91 776 34 09", "tel:+998917763409"));
      body.appendChild(contacts);
    });
  }

  function renderProfileScreen() {
    screenHeader("profile-header", {
      back: function () { showScreen("home"); },
      title: "Профиль",
      center: true,
      right: { icon: ICON_GEAR, label: "Настройки", onClick: openSettingsSubscreen },
    });
    var root = document.getElementById("profile-root");
    root.innerHTML = "";
    var p = state.profile;

    if (!p.registered) {
      root.appendChild(el("div", "empty-note", "Вы ещё не зарегистрированы. Наберите /start в чате с ботом, чтобы завести профиль."));
      return;
    }

    var head = el("div", "profile-head");
    var photo = tgPhotoUrl();
    if (photo) {
      var img = el("img", "avatar");
      img.src = photo;
      head.appendChild(img);
    } else {
      head.appendChild(el("div", "avatar", initials(p.name)));
    }
    head.appendChild(el("div", "profile-name", p.name || "Без имени"));
    head.appendChild(el("div", "profile-contact", formatPhone(p.phone)));

    // Статус клуба виден сразу, с первого заказа (даже на "🕊 Гость PAUSE",
    // 0 заказов) — не прячем, пока не наберётся хоть один, как было
    // раньше. По тапу — сколько осталось до следующего уровня (см.
    // sheets.get_club_level — та же самая чистая функция, что и в боте).
    var badge = el("button", "pill profile-club-badge", p.club.emoji + " Участник " + p.club.label);
    badge.addEventListener("click", function () {
      haptic("select");
      if (p.club.next_label) {
        var total = p.order_count + p.club.left;
        var pct = total ? Math.min(100, Math.round((p.order_count / total) * 100)) : 0;
        showInfo(
          '<div class="club-progress-label">До статуса «' + p.club.next_emoji + ' ' + escapeHtml(p.club.next_label) +
          '» осталось заказов: ' + p.club.left + '</div>' +
          '<div class="club-progress-track"><div class="club-progress-fill" style="width:' + pct + '%"></div></div>'
        );
      } else {
        showInfo('<div class="club-progress-label">Вы уже на высшем уровне PAUSE Club 🎉</div>');
      }
    });
    head.appendChild(badge);
    root.appendChild(head);

    // 3 плашки статистики — "заказов" и "постов" реальные (заказы из
    // профиля, посты — те же самые /api/feed, посчитанные по автору);
    // "акции" — тире, а не выдуманное число: участие в розыгрышах нигде
    // не считается (см. отчёт пользователю).
    var statRow = el("div", "profile-stat-row");
    var s1 = el("button", "profile-stat profile-stat-clickable");
    s1.innerHTML = '<div class="profile-stat-value">' + p.order_count + '</div><div class="profile-stat-label">заказов</div>';
    s1.addEventListener("click", function () { haptic("select"); openProfileSubscreen("Мои заказы", loadOrders); });
    var s2 = el("div", "profile-stat");
    s2.innerHTML = '<div class="profile-stat-value">—</div><div class="profile-stat-label">акции</div>';
    var s3 = el("div", "profile-stat");
    var postsCount = (state.feed || []).filter(function (post) { return post.author === p.name; }).length;
    s3.innerHTML = '<div class="profile-stat-value">' + postsCount + '</div><div class="profile-stat-label">постов</div>';
    statRow.appendChild(s1); statRow.appendChild(s2); statRow.appendChild(s3);
    root.appendChild(statRow);

    // Пять строк — ровно как на макете. "Настройки" (точка доставки,
    // имя/телефон) и "Мои послания" туда не входят: первое теперь
    // отдельная иконка-шестерёнка в шапке, второе — уже своя вкладка
    // нижней навигации (Послания), дублировать её здесь незачем.
    var rows = el("div", "card profile-nav-list");
    rows.appendChild(buildProfileRow(ICON_ORDERS, "Мои заказы", function () { openProfileSubscreen("Мои заказы", loadOrders); }));
    rows.appendChild(buildProfileRow(ICON_HEART, "Избранное", function () { toast("Избранное — скоро добавим"); }));
    rows.appendChild(buildProfileRow(ICON_BELL, "Уведомления", openNotifySubscreen));
    rows.appendChild(buildProfileRow(ICON_TAG, "Бонусы и промокоды", function () { toast("Бонусы и промокоды — скоро добавим"); }));
    rows.appendChild(buildProfileRow(ICON_SUPPORT, "Поддержка", openSupportSubscreen));
    root.appendChild(rows);

    if (tg) {
      var exitBtn = el("button", "btn-ghost profile-exit-btn", "Выйти");
      // Отдельного "логина" в системе нет — личность приходит из Telegram
      // автоматически при каждом открытии, выходить не из чего технически;
      // честный эквивалент "Выйти" здесь — просто закрыть Mini App.
      exitBtn.addEventListener("click", function () { tg.close(); });
      root.appendChild(exitBtn);
    }
  }

  // --- Мои заказы --------------------------------------------------------

  var ORDERS_PAY_FILTERS = [
    { key: "all", label: "Все" },
    { key: "paid", label: "Оплачено" },
    { key: "unpaid", label: "Не оплачено" },
  ];

  function loadOrders(root) {
    var payFilter = "all";
    api("/api/orders").then(function (data) {
      renderOrders();

      function renderOrders() {
        root.innerHTML = "";
        if (!data.pending.length && !data.orders.length) {
          root.appendChild(el("div", "empty-note", "Заказов пока не было."));
          return;
        }

        // Фильтр по оплате имеет смысл только для оформленных заказов —
        // "На рассмотрении" (pending, точка ещё не подтверждена) своего
        // статуса оплаты пока не имеет, показываем их только на "Все".
        if (data.orders.length) {
          var chips = el("div", "feed-filters");
          ORDERS_PAY_FILTERS.forEach(function (f) {
            var chip = el("button", "filter-chip" + (payFilter === f.key ? " active" : ""), f.label);
            chip.addEventListener("click", function () { payFilter = f.key; renderOrders(); });
            chips.appendChild(chip);
          });
          root.appendChild(chips);
        }

        if (payFilter === "all") {
          data.pending.forEach(function (p) {
            var card = el("div", "card");
            card.innerHTML =
              '<div class="order-card-head"><span class="order-card-date">' + p.date + '</span><span class="pill gold">На проверке</span></div>' +
              '<div class="order-card-items">' + itemsText(p.items) + '</div>';
            root.appendChild(card);
          });
        }

        data.orders.filter(function (g) {
          if (payFilter === "paid") return g.paid;
          if (payFilter === "unpaid") return !g.paid;
          return true;
        }).forEach(function (g) {
          var card = el("div", "card");
          var statusPill = g.canceled
            ? '<span class="pill muted">Отменён</span>'
            : g.complete ? '<span class="pill">Завершён</span>' : '<span class="pill gold">Готовится</span>';
          var payPill = '<span class="pill ' + (g.paid ? "paid" : "unpaid") + '">' + (g.paid ? "Оплачено" : "Не оплачено") + '</span>';
          card.innerHTML =
            '<div class="order-card-head"><span class="order-card-date">' + g.date + '</span>' +
            '<span class="order-card-pills">' + payPill + statusPill + '</span></div>' +
            '<div class="order-card-items">' + itemsText(g.items) + (g.is_debt ? " (в долг)" : "") + '</div>';
          if (g.can_cancel || (!g.canceled && g.row_for_feedback)) {
            var actions = el("div", "order-card-actions");
            if (g.can_cancel) {
              var cancelBtn = el("button", "btn-ghost", "Отменить");
              cancelBtn.addEventListener("click", function () {
                showConfirm("Отменить заказ на " + g.date + "?", "Да, отменить", function () { cancelOrder(root); });
              });
              actions.appendChild(cancelBtn);
            }
            if (!g.canceled && g.row_for_feedback) {
              var fbBtn = el("button", "btn-text", "★ Отзыв");
              fbBtn.addEventListener("click", function () { openFeedback(g); });
              actions.appendChild(fbBtn);
            }
            card.appendChild(actions);
          }
          root.appendChild(card);
        });

        if (data.debt > 0) {
          root.appendChild(el("div", "center-note", "Текущий долг: " + fmtSum(data.debt)));
        }
      }
    }).catch(function () {
      root.innerHTML = "";
      root.appendChild(el("div", "empty-note", "Не удалось загрузить заказы."));
    });
  }

  function itemsText(items) {
    return items.map(function (i) { return i.qty + "× " + i.set; }).join(", ");
  }

  function cancelOrder(ordersRoot) {
    api("/api/orders/cancel", { method: "POST", body: {} }).then(function () {
      toast("Заказ отменён");
      haptic("success");
      loadOrders(ordersRoot);
    }).catch(function (err) {
      var msg = "Не удалось отменить заказ";
      if (err.code === "too_late") msg = "Уже поздно для самостоятельной отмены — напишите в поддержку.";
      else if (err.code === "card_pending") msg = "Оплата картой уже в обработке — отмена через поддержку.";
      toast(msg);
    });
  }

  function openFeedback(group) {
    var label = group.date + " — " + itemsText(group.items);
    var stars = 0;
    openWizard(function (body) {
      wizardPhaseEl.innerHTML = "";
      body.appendChild(el("h2", "wizard-title", "Отзыв о заказе"));
      body.appendChild(el("p", null, label));

      var starsRow = el("div", "star-rating");
      var starBtns = [];
      for (var i = 1; i <= 5; i++) {
        (function (n) {
          var b = el("button", "star-btn", ICON_STAR);
          b.setAttribute("aria-label", n + " из 5");
          b.addEventListener("click", function () {
            haptic("select");
            stars = n;
            starBtns.forEach(function (sb, idx) { sb.classList.toggle("active", idx < stars); });
          });
          starBtns.push(b);
          starsRow.appendChild(b);
        })(i);
      }
      body.appendChild(starsRow);

      var field = el("div", "field");
      field.style.marginTop = "14px";
      field.innerHTML = '<textarea id="feedback-input" rows="4" placeholder="Комментарий — необязательно"></textarea>';
      body.appendChild(field);

      var send = el("button", "btn-primary wizard-footer-btn", "Отправить");
      send.addEventListener("click", function () {
        var text = document.getElementById("feedback-input").value.trim();
        // Можно отправить просто оценку без комментария, но не пустую
        // форму совсем — хотя бы звёзды или хотя бы текст.
        if (!stars && !text) { toast("Поставьте оценку или напишите пару слов"); return; }
        send.disabled = true;
        api("/api/feedback", { method: "POST", body: { text: text, stars: stars, order_label: label } }).then(function () {
          haptic("success");
          toast("Спасибо, что рассказали 🤎");
          closeWizard();
        }).catch(function (err) { send.disabled = false; toast("Не получилось отправить: " + err.message); });
      });
      body.appendChild(send);
    });
  }

  // --- Мои послания --------------------------------------------------------

  function loadMessages(root) {
    api("/api/messages").then(function (data) {
      root.innerHTML = "";
      if (!data.messages.length) {
        root.appendChild(el("div", "empty-note", "Посланий пока не было — они появляются после каждого заказа."));
        return;
      }
      data.messages.forEach(function (m) {
        var card = el("div", "card message-card");
        card.innerHTML =
          '<div class="message-card-num">№ ' + m.number + ' из ' + data.total + '</div>' +
          '<div class="message-card-text">«' + escapeHtml(m.text) + '»</div>' +
          '<div class="message-card-date">' + m.date + '</div>';
        root.appendChild(card);
      });
    }).catch(function () {
      root.innerHTML = "";
      root.appendChild(el("div", "empty-note", "Не удалось загрузить послания."));
    });
  }

  // --- Редактирование профиля ---------------------------------------------

  var editState = {};

  function openEditProfile() {
    var p = state.profile;
    openWizard(function (body) {
      wizardPhaseEl.innerHTML = "";
      body.appendChild(el("h2", "wizard-title", "Редактировать профиль"));

      var nameField = el("div", "field");
      nameField.innerHTML = '<label>Имя</label><input type="text" id="edit-name" value="' + escapeHtml(p.name || "") + '">';
      body.appendChild(nameField);

      var phoneField = el("div", "field");
      phoneField.innerHTML = '<label>Телефон</label><input type="tel" id="edit-phone" value="' + escapeHtml(p.phone || "") + '">';
      body.appendChild(phoneField);

      var curZone = editState.zone || p.zone || "";
      var curPoint = editState.point || p.point || "";
      var pointField = el("div", "field");
      pointField.innerHTML = '<label>Точка доставки</label>';
      var pointBtn = el("div", "card option-row selected");
      pointBtn.innerHTML = '<div class="option-row-label">' + escapeHtml((curZone && curPoint) ? (curZone + ", " + curPoint) : "Указать точку") + '</div>';
      pointBtn.addEventListener("click", function () {
        wizardStep(function (b) { renderZonePickerForEdit(b); });
      });
      pointField.appendChild(pointBtn);
      body.appendChild(pointField);

      var save = el("button", "btn-primary wizard-footer-btn", "Сохранить");
      save.addEventListener("click", function () {
        save.disabled = true;
        var body2 = {
          name: document.getElementById("edit-name").value.trim(),
          phone: document.getElementById("edit-phone").value.trim(),
          zone: editState.zone || "", point: editState.point || "", is_new_point: !!editState.isNewPoint,
        };
        api("/api/profile", { method: "POST", body: body2 }).then(function () {
          haptic("success");
          toast("Сохранено");
          closeWizard();
          state.profile = null;
          loadProfile();
        }).catch(function (err) { save.disabled = false; toast("Не удалось сохранить: " + err.message); });
      });
      body.appendChild(save);
    });
  }

  function renderZonePickerForEdit(body) {
    body.appendChild(el("h2", "wizard-title", "Район"));
    api("/api/zones").then(function (data) {
      data.zones.forEach(function (z) {
        var row = el("div", "card option-row");
        row.appendChild(el("div", "option-row-label", z));
        row.addEventListener("click", function () { wizardStep(function (b) { renderPointPickerForEdit(b, z); }); });
        body.appendChild(row);
      });
      var otherRow = el("div", "card option-row");
      otherRow.appendChild(el("div", "option-row-label", "Другой район"));
      otherRow.addEventListener("click", function () { wizardStep(function (b) { renderNewPointFormForEdit(b, ""); }); });
      body.appendChild(otherRow);
    });
  }

  function renderPointPickerForEdit(body, zone) {
    body.appendChild(el("h2", "wizard-title", zone));
    api("/api/points?zone=" + encodeURIComponent(zone)).then(function (data) {
      if (!data.points.length) { renderNewPointFormForEdit(body, zone); return; }
      data.points.forEach(function (pt) {
        var row = el("div", "card option-row");
        row.appendChild(el("div", "option-row-label", pt));
        row.addEventListener("click", function () {
          editState = { zone: zone, point: pt, isNewPoint: false };
          closeWizard();
          openEditProfile();
        });
        body.appendChild(row);
      });
      var otherRow = el("div", "card option-row");
      otherRow.appendChild(el("div", "option-row-label", "Другая точка"));
      otherRow.addEventListener("click", function () { wizardStep(function (b) { renderNewPointFormForEdit(b, zone); }); });
      body.appendChild(otherRow);
    });
  }

  function renderNewPointFormForEdit(body, zone) {
    body.appendChild(el("h2", "wizard-title", "Новая точка"));
    var field = el("div", "field");
    field.innerHTML = '<label>Адрес / название точки</label><input type="text" id="ep-new-point">';
    body.appendChild(field);
    if (!zone) {
      var zf = el("div", "field");
      zf.innerHTML = '<label>Район</label><input type="text" id="ep-new-zone">';
      body.insertBefore(zf, field);
    }
    var next = el("button", "btn-primary wizard-footer-btn", "Готово");
    next.addEventListener("click", function () {
      var pointVal = document.getElementById("ep-new-point").value.trim();
      var zoneVal = zone || (document.getElementById("ep-new-zone") || {}).value || "";
      zoneVal = zoneVal.trim();
      if (!pointVal || !zoneVal) { toast("Заполните район и точку"); return; }
      editState = { zone: zoneVal, point: pointVal, isNewPoint: true };
      closeWizard();
      openEditProfile();
    });
    body.appendChild(next);
  }

  // -------------------------------------------------------------------
  // Инициализация
  // -------------------------------------------------------------------

  document.getElementById("confirm-modal-yes").addEventListener("click", function () {
    var cb = confirmCallback;
    hideConfirm();
    if (cb) cb();
  });
  document.getElementById("confirm-modal-no").addEventListener("click", hideConfirm);
  document.getElementById("confirm-modal").addEventListener("click", function (e) {
    if (e.target.id === "confirm-modal") hideConfirm();
  });

  // Приветственный экран — один раз на устройство, дальше не мешает: сам
  // прогруз данных ниже не ждёт, пока его закроют, просто рисуется поверх.
  var SPLASH_KEY = "pauseapp_seen_splash_v1";
  function maybeShowSplash() {
    var seen = false;
    try { seen = localStorage.getItem(SPLASH_KEY) === "1"; } catch (e) {}
    if (seen) return;
    var splash = document.getElementById("splash");
    splash.hidden = false;
    document.getElementById("splash-start").addEventListener("click", function () {
      haptic("select");
      try { localStorage.setItem(SPLASH_KEY, "1"); } catch (e) {}
      splash.hidden = true;
    });
  }

  function init() {
    maybeShowSplash();
    resetOrder();
    editState = {};
    initNav();
    initBottomNavScroll();
    api("/api/me").then(function () {
      showScreen("home");
    }).catch(function (err) {
      var root = document.getElementById("home-root");
      root.innerHTML = "";
      if (err.status === 401 || err.status === 403) {
        root.appendChild(el("div", "menu-state", "<h2>Доступ ограничен</h2><p>PAUSE App пока открыт только для команды PAUSE.</p>"));
      } else {
        root.appendChild(el("div", "menu-state", "<h2>Небольшая заминка</h2><p>Не получилось связаться с сервером — потяните экран вниз или откройте приложение заново.</p>"));
      }
    });
  }

  document.addEventListener("DOMContentLoaded", init);
})();
