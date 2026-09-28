(function () {
  "use strict";

  var tg = window.Telegram ? window.Telegram.WebApp : null;
  if (tg) {
    tg.ready();
    tg.expand();
    try { tg.setHeaderColor("#0D332B"); } catch (e) {}
    try { tg.setBackgroundColor("#F4EBDD"); } catch (e) {}
  }

  var state = {
    screen: "menu",
    profile: null,     // {registered, name, phone, zone, point, order_count, club, ...}
    menu: null,         // ответ /api/menu
    menuCategory: "all", // выбранный чип категории на экране Меню
    feed: null,         // список постов ленты PAUSE Club (ответ /api/feed)
    feedFilter: "all",  // "all" | один из config.FEED_POST_TYPES
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

  // -------------------------------------------------------------------
  // Навигация — нижняя панель, 3 экрана
  // -------------------------------------------------------------------

  var TITLES = { menu: "Меню", club: "Pause Club", profile: "Профиль" };

  function showScreen(name) {
    state.screen = name;
    ["menu", "club", "profile"].forEach(function (s) {
      document.getElementById("screen-" + s).hidden = s !== name;
    });
    document.getElementById("header-title").textContent = TITLES[name];
    Array.prototype.forEach.call(document.querySelectorAll(".nav-item"), function (b) {
      b.classList.toggle("active", b.dataset.screen === name);
    });
    if (name === "profile" && !state.profile) loadProfile();
    if (name === "menu" && !state.menu) loadMenu();
    if (name === "club" && !state.feed) loadFeed();
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
    var card = el("div", "card menu-set-card");
    if (s.photo_url) {
      card.classList.add("has-photo");
      var img = el("img", "menu-set-photo");
      img.src = s.photo_url;
      img.alt = "";
      img.loading = "lazy";
      // Если ссылка окажется битой (например, админ ещё вставляет фото и
      // вставил не то) — просто скрываем блок, а не показываем "битую
      // картинку" на премиальном экране.
      img.addEventListener("error", function () { img.remove(); card.classList.remove("has-photo"); });
      card.appendChild(img);
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
    card.addEventListener("click", function () { startOrderFromCard(s); });
    return card;
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
      renderFeedScreen();
    }).catch(function () {
      root.innerHTML = "";
      root.appendChild(el("div", "feed-empty", "Не удалось загрузить ленту — потяните вниз, чтобы попробовать снова."));
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
    renderFeedFilters();
    var root = document.getElementById("feed-root");
    root.innerHTML = "";
    var posts = (state.feed || []).filter(function (p) { return state.feedFilter === "all" || p.type === state.feedFilter; });

    if (!posts.length) {
      root.appendChild(el("div", "feed-empty", "<div>" + ICON_LEAF + "</div><p>Пока здесь тихо — самое время опубликовать первый пост.</p>"));
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

      var submit = el("button", "btn-gold wizard-footer-btn", "Опубликовать");
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

    var nextBtn = el("button", "btn-gold wizard-footer-btn", "Добавить в заказ");
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

    var next = el("button", "btn-gold wizard-footer-btn", "Дальше →");
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
      card.innerHTML = '<div class="list-row-label" style="font-weight:600;color:var(--forest)">' + order.zone + '</div><div class="list-row-value" style="text-align:left;margin-top:2px">' + order.point + '</div>';
      body.appendChild(card);
      var change = el("button", "btn-text", "Изменить точку");
      change.style.marginTop = "10px";
      change.addEventListener("click", function () { order.zone = ""; order.point = ""; wizardReplace(stepPoint); });
      body.appendChild(change);

      var next = el("button", "btn-gold wizard-footer-btn", "Дальше →");
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
    var next = el("button", "btn-gold wizard-footer-btn", "Дальше →");
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
    var next = el("button", "btn-gold wizard-footer-btn", "Дальше →");
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
    var now = el("button", "btn-gold", "Отправить скрин сейчас");
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

    var next = el("button", "btn-gold wizard-footer-btn", "Загрузить и продолжить");
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

    var confirmBtn = el("button", "btn-gold wizard-footer-btn", "Всё верно, отправить");
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
      '<div style="color:var(--gold);margin-bottom:18px">' + ICON_LEAF + '</div>' +
      '<h2>Заказ отправлен 🌿</h2>' +
      (care ? '<p style="margin-top:14px;font-family:var(--font-serif);font-style:italic;font-size:18px;color:var(--forest)">«' + escapeHtml(care.phrase) + '»</p><p style="margin-top:6px;font-size:12px">послание № ' + care.number + ' из ' + care.total + '</p>' : "") +
      '</div>';
    var done = el("button", "btn-gold wizard-footer-btn", "Готово");
    done.addEventListener("click", function () { closeWizard(); state.profile = null; showScreen("menu"); loadMenu(); });
    body.appendChild(done);
  }

  function stepPendingSuccess(body) {
    wizardPhaseEl.innerHTML = "";
    document.getElementById("wizard-back").style.visibility = "hidden";
    body.innerHTML =
      '<div style="text-align:center;padding:40px 10px 0">' +
      '<div style="color:var(--gold);margin-bottom:18px">' + ICON_CLOCK + '</div>' +
      '<h2>Точка на проверке</h2>' +
      '<p style="margin-top:10px">Координатор уточнит адрес и подтвердит заказ — обычно это быстро. Мы напишем, как только всё готово.</p>' +
      '</div>';
    var done = el("button", "btn-gold wizard-footer-btn", "Готово");
    done.addEventListener("click", function () { closeWizard(); showScreen("menu"); });
    body.appendChild(done);
  }

  // -------------------------------------------------------------------
  // ПРОФИЛЬ
  // -------------------------------------------------------------------

  function loadProfile() {
    var root = document.getElementById("profile-root");
    api("/api/profile").then(function (data) {
      state.profile = data;
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

  function renderProfileScreen() {
    var root = document.getElementById("profile-root");
    root.innerHTML = "";
    var p = state.profile;

    if (!p.registered) {
      root.appendChild(el("div", "empty-note", "Вы ещё не зарегистрированы. Наберите /start в чате с ботом, чтобы завести профиль."));
      return;
    }

    var hero = el("div", "screen-hero");
    hero.appendChild(el("h2", null, "Твоё пространство"));
    hero.appendChild(el("p", null, "всё, что связано с тобой в PAUSE"));
    root.appendChild(hero);

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
    var username = tgUsername();
    if (username) head.appendChild(el("div", "profile-username", "@" + username));
    head.appendChild(el("div", "profile-contact", p.phone || "Телефон не указан"));
    root.appendChild(head);

    root.appendChild(el("div", "profile-section-title", "PAUSE CLUB"));
    var statRow = el("div", "profile-stat-row");
    var s1 = el("div", "profile-stat");
    s1.innerHTML = '<div class="profile-stat-value">' + p.order_count + '</div><div class="profile-stat-label">заказов</div>';
    var s2 = el("div", "profile-stat");
    s2.innerHTML = '<div class="profile-stat-value">' + p.club.emoji + '</div><div class="profile-stat-label">' + p.club.label + '</div>';
    statRow.appendChild(s1); statRow.appendChild(s2);
    root.appendChild(statRow);

    if (p.club.next_label) {
      var total = p.order_count + p.club.left;
      var pct = total ? Math.min(100, Math.round((p.order_count / total) * 100)) : 0;
      var prog = el("div", "card");
      prog.innerHTML =
        '<div class="club-progress-label">До статуса «' + p.club.next_emoji + ' ' + p.club.next_label + '» осталось ' + p.club.left + '</div>' +
        '<div class="club-progress-track"><div class="club-progress-fill" style="width:' + pct + '%"></div></div>';
      root.appendChild(prog);
    }

    root.appendChild(el("div", "profile-section-title", "Настройки"));
    var pointCard = el("div", "card");
    pointCard.innerHTML =
      '<div class="list-row"><span class="list-row-label">Точка доставки</span><span class="list-row-value">' +
      escapeHtml((p.zone && p.point) ? (p.zone + ", " + p.point) : "не указана") + '</span></div>';
    root.appendChild(pointCard);

    var editBtn = el("button", "btn-ghost", "Редактировать профиль");
    editBtn.style.marginTop = "12px";
    editBtn.addEventListener("click", function () { editState = {}; openEditProfile(); });
    root.appendChild(editBtn);

    root.appendChild(el("div", "profile-section-title", "Мои заказы"));
    var ordersRoot = el("div");
    ordersRoot.appendChild(el("div", "skeleton-block"));
    root.appendChild(ordersRoot);
    loadOrders(ordersRoot);

    root.appendChild(el("div", "profile-section-title", "Мои послания"));
    var msgRoot = el("div");
    msgRoot.appendChild(el("div", "skeleton-block"));
    root.appendChild(msgRoot);
    loadMessages(msgRoot);

    root.appendChild(el("div", "profile-section-title", "Поддержка"));
    var supportCard = el("div", "card");
    supportCard.innerHTML = 'Что-то пошло не так или есть вопрос? Напишите нам напрямую — <span class="link-inline">@ssaavveeyy</span>.';
    root.appendChild(supportCard);
  }

  // --- Мои заказы --------------------------------------------------------

  function loadOrders(root) {
    api("/api/orders").then(function (data) {
      root.innerHTML = "";
      if (!data.pending.length && !data.orders.length) {
        root.appendChild(el("div", "empty-note", "Заказов пока не было."));
        return;
      }
      data.pending.forEach(function (p) {
        var card = el("div", "card");
        card.innerHTML =
          '<div class="order-card-head"><span class="order-card-date">' + p.date + '</span><span class="pill gold">На проверке</span></div>' +
          '<div class="order-card-items">' + itemsText(p.items) + '</div>';
        root.appendChild(card);
      });
      data.orders.forEach(function (g) {
        var card = el("div", "card");
        var statusPill = g.canceled
          ? '<span class="pill muted">Отменён</span>'
          : g.complete ? '<span class="pill">Завершён</span>' : '<span class="pill gold">Готовится</span>';
        card.innerHTML =
          '<div class="order-card-head"><span class="order-card-date">' + g.date + '</span>' + statusPill + '</div>' +
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
    openWizard(function (body) {
      wizardPhaseEl.innerHTML = "";
      body.appendChild(el("h2", "wizard-title", "Отзыв о заказе"));
      body.appendChild(el("p", null, label));
      var field = el("div", "field");
      field.style.marginTop = "14px";
      field.innerHTML = '<textarea id="feedback-input" rows="4" placeholder="Что понравилось, что стоит поправить?"></textarea>';
      body.appendChild(field);
      var send = el("button", "btn-gold wizard-footer-btn", "Отправить");
      send.addEventListener("click", function () {
        var text = document.getElementById("feedback-input").value.trim();
        if (!text) { toast("Напишите пару слов"); return; }
        send.disabled = true;
        api("/api/feedback", { method: "POST", body: { text: text, order_label: label } }).then(function () {
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

      var save = el("button", "btn-gold wizard-footer-btn", "Сохранить");
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
    var next = el("button", "btn-gold wizard-footer-btn", "Готово");
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

  function init() {
    resetOrder();
    editState = {};
    initNav();
    api("/api/me").then(function () {
      showScreen("menu");
    }).catch(function (err) {
      var root = document.getElementById("menu-root");
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
