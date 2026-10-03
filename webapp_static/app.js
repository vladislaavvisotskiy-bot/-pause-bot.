(function () {
  "use strict";

  var tg = window.Telegram ? window.Telegram.WebApp : null;
  if (tg) {
    tg.ready();
    tg.expand();
  }

  var state = {
    role: "",
    tgId: null,
    screen: "route",   // "route" | "profile" — какой раздел сейчас показан (см. showScreen)
    points: [],
    date: null,        // DD.MM.YYYY — сейчас выбранная в переключателе дата
    activeDate: null,   // DD.MM.YYYY — "сегодня" по активному меню, для подписи в переключателе
    dates: [],          // доступные для выбора даты (см. loadRouteDates)
    depot: null,        // {name, address, lat, lon} — точка отправления (кухня), только для карты
    visible: true,      // видит ли КУРЬЕР маршрут на state.date (см. api_route_get, "visible")
    expanded: {},      // point -> bool
    map: null,
    markers: [],
    polyline: null,
    couriers: [],       // [{tg_id, name, status}] — только для админа, см. loadCouriers
    splitView: false,   // флаг ROUTE_SPLIT_VIEW с сервера (см. /api/me) — пробное разделение
                         // курьеров на экране "Маршрут"; при false всё как было раньше
    courierTab: "all",  // "all" | tg_id курьера — какая вкладка сейчас активна (только админ)
    isRouteAdmin: false, // видит ли "Профиль" как у админа (центр управления) —
                          // true и для основного админа бота, и для админов Mini App
                          // "Маршрут" (см. config.ROUTE_ADMIN_IDS), не меняется при
                          // переключении "Режима" (иначе некому было бы его переключить назад)
    canToggleMode: false, // может ли менять "Режим" ("Администратор"/"Курьер") — только у
                           // админов именно этого Mini App, не у основного админа бота
    logisticsDateISO: null,
  };

  // Тёплая палитра для цветов курьеров на вкладке "Все" (см. renderMap,
  // courierColor) — цвет назначается по порядковому номеру курьера в
  // /api/couriers, зациклен по модулю, если курьеров больше, чем цветов.
  var COURIER_PALETTE = ["#b8563f", "#c9962b", "#8a6a3f", "#9c5b6b", "#5f7a52", "#a8452e"];

  function courierColor(tgId) {
    var idx = state.couriers.map(function (c) { return c.tg_id; }).indexOf(tgId);
    return COURIER_PALETTE[(idx === -1 ? 0 : idx) % COURIER_PALETTE.length];
  }

  // Точки, которые сейчас должны быть показаны на карте/в списке — ВСЕ (на
  // вкладке "Все" или когда ROUTE_SPLIT_VIEW выключен/роль не админ), либо
  // только точки одного курьера (на его вкладке). Порядок сохраняется тем
  // же, что и в state.points (уже отсортирован по общему столбцу
  // "Порядок") — просто отфильтрован, поэтому нумерация 1,2,3 внутри
  // вкладки курьера получается автоматически его личным относительным
  // порядком, без отдельного столбца в таблице.
  function visiblePoints() {
    if (!state.splitView || state.role !== "admin" || state.courierTab === "all") {
      return state.points;
    }
    var tab = state.courierTab;
    return state.points.filter(function (p) { return p.courier_tg_ids.indexOf(tab) !== -1; });
  }

  // Переносит новый ОТНОСИТЕЛЬНЫЙ порядок отображаемого поднабора точек
  // (newSubsetOrder — имена точек в новом порядке, например только точки
  // одного курьера с его вкладки) в ПОЛНЫЙ список fullList, не трогая
  // позиции остальных точек — единственный способ тащить карточки только
  // внутри вкладки курьера, продолжая хранить ОДИН общий столбец "Порядок"
  // в листе "Маршрут" (структуру листа менять нельзя, см. ROUTE_SPLIT_VIEW
  // в config.py). Если newSubsetOrder содержит вообще все точки (вкладка
  // "Все" или флаг выключен) — результат совпадает с прежним поведением
  // "просто пронумеровать DOM-порядок подряд".
  function mergeSubsetOrder(fullList, newSubsetOrder) {
    var subsetSet = {};
    newSubsetOrder.forEach(function (name) { subsetSet[name] = true; });
    var slots = [];
    fullList.forEach(function (p, idx) {
      if (subsetSet[p.point]) slots.push(idx);
    });
    var merged = fullList.map(function (p) { return p.point; });
    slots.forEach(function (slotIdx, i) { merged[slotIdx] = newSubsetOrder[i]; });
    var order = {};
    merged.forEach(function (name, idx) { order[name] = idx + 1; });
    return order;
  }

  // -------------------------------------------------------------------
  // Утилиты
  // -------------------------------------------------------------------

  function initData() {
    return tg ? tg.initData : "";
  }

  function api(path, options) {
    options = options || {};
    var headers = options.headers || {};
    headers["X-Telegram-Init-Data"] = initData();
    if (options.body) {
      headers["Content-Type"] = "application/json";
    }
    return fetch(path, {
      method: options.method || "GET",
      headers: headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
    }).then(function (resp) {
      if (!resp.ok) {
        return resp.json().catch(function () { return {}; }).then(function (data) {
          var err = new Error(data.error || ("HTTP " + resp.status));
          err.status = resp.status;
          throw err;
        });
      }
      return resp.json();
    });
  }

  // Аватарка курьера (см. ICON_COURIERS ниже) идёт через свой прокси-
  // эндпоинт, который требует ту же подпись initData, что и /api/* —
  // обычный <img src="..."> заголовков не шлёт, поэтому картинку сначала
  // тянем сами через fetch() и превращаем в blob-URL, с кэшем в памяти по
  // URL (тот же приём, что и в PAUSE App, см. pauseapp_static/app.js:
  // fetchAuthedImageBlobUrl — отдельный файл, общего JS-модуля у двух
  // Mini App нет, поэтому продублировано).
  var _authedImageCache = {};
  function fetchAuthedImageBlobUrl(url) {
    if (!_authedImageCache[url]) {
      _authedImageCache[url] = fetch(url, { headers: { "X-Telegram-Init-Data": initData() } })
        .then(function (resp) { if (!resp.ok) throw new Error("HTTP " + resp.status); return resp.blob(); })
        .then(function (blob) { return URL.createObjectURL(blob); });
    }
    return _authedImageCache[url];
  }

  function toast(text) {
    var el = document.getElementById("toast");
    el.textContent = text;
    el.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { el.hidden = true; }, 2600);
  }

  function isoToRu(iso) {
    // "2026-09-08" -> "08.09.2026"
    var parts = iso.split("-");
    return parts[2] + "." + parts[1] + "." + parts[0];
  }

  function ruToIso(ru) {
    // "08.09.2026" -> "2026-09-08"
    var parts = ru.split(".");
    return parts[2] + "-" + parts[1] + "-" + parts[0];
  }

  function fmtSum(n) {
    return (n || 0).toLocaleString("ru-RU") + " сум";
  }

  // el()/escapeHtml()/haptic() — та же тройка маленьких хелперов, что и в
  // PAUSE App (pauseapp_static/app.js), намеренно продублирована здесь:
  // у двух Mini App нет общего JS-модуля, см. уже существующее дублирование
  // SET_DISPLAY_NAMES ниже.
  function el(tag, className, html) {
    var e = document.createElement(tag);
    if (className) e.className = className;
    if (html !== undefined) e.innerHTML = html;
    return e;
  }

  function escapeHtml(s) {
    var d = document.createElement("div");
    d.textContent = s == null ? "" : String(s);
    return d.innerHTML;
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

  function initials(name) {
    var parts = (name || "").trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return "?";
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }

  // Фото и имя — прямо из Telegram WebApp initData (как в PAUSE App, см.
  // pauseapp_static/app.js: tgPhotoUrl/tgUsername) — серверу для этого
  // ничего отдельно спрашивать не нужно, имя/роль на права не влияют.
  function tgPhotoUrl() {
    try {
      var u = tg && tg.initDataUnsafe && tg.initDataUnsafe.user;
      return u && u.photo_url ? u.photo_url : null;
    } catch (e) { return null; }
  }

  function tgDisplayName() {
    try {
      var u = tg && tg.initDataUnsafe && tg.initDataUnsafe.user;
      if (!u) return "";
      return [u.first_name, u.last_name].filter(Boolean).join(" ") || u.username || "";
    } catch (e) { return ""; }
  }

  // Клиентские названия сетов — только для отображения в Mini App (то же
  // самое, что texts.SET_DISPLAY_NAMES/display_set_name на стороне бота,
  // просто продублировано здесь, т.к. у фронтенда нет доступа к Python).
  // В таблицу и в API-запросы техническое название не подменяется —
  // используется только здесь, при сборке текста для показа.
  var SET_DISPLAY_NAMES = {
    "Блюдо дня": "Пауза дня.",
    "Сет стандарт": "Для тебя.",
    "Боул": "Пауза в балансе.",
    "Самса": "Пауза дуо.",
    "Самса без компота": "Пауза дуо.",
    "Chicken bowl": "Chicken bowl.",
    "Beef bowl": "Beef bowl.",
  };

  function displaySetName(name) {
    return SET_DISPLAY_NAMES[name] || name;
  }

  function itemsText(items) {
    return items.map(function (i) {
      return i.qty + "× " + displaySetName(i.set);
    }).join(", ");
  }

  function telHref(contact) {
    // Номера в таблице — свободный текст вида "90 978 52 45" (без кода
    // страны). tel: ссылке нужен реальный телефонный номер — считаем, что
    // 9-значный номер без кода это узбекский местный формат и дописываем
    // 998 спереди; более длинный номер (уже с кодом страны) оставляем как
    // есть. "Неизвестно"/пусто — не ссылка.
    var digits = (contact || "").replace(/\D/g, "");
    if (!digits) return null;
    if (digits.length === 9) digits = "998" + digits;
    return "tel:+" + digits;
  }

  function copyToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    // Старые WebView без Clipboard API — запасной способ через невидимый
    // <textarea> и document.execCommand("copy").
    return new Promise(function (resolve, reject) {
      try {
        var ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        var ok = document.execCommand("copy");
        document.body.removeChild(ta);
        if (ok) resolve(); else reject(new Error("execCommand('copy') failed"));
      } catch (err) {
        reject(err);
      }
    });
  }

  // -------------------------------------------------------------------
  // Маршрут — карта
  // -------------------------------------------------------------------

  function numberedIcon(num, done, colorInfo) {
    // colorInfo — цвет курьера (см. ROUTE_SPLIT_VIEW/markerColorFor): либо
    // строка (один назначенный курьер), либо массив строк (точка назначена
    // нескольким курьерам сразу — рисуем маркер несколькими секторами,
    // "особая отметка" по ТЗ). Сданная точка (done) всегда красится
    // обычным цветом "сдано" — статус важнее принадлежности курьеру.
    var style = "";
    if (!done && colorInfo) {
      if (Array.isArray(colorInfo)) {
        var pct = 100 / colorInfo.length;
        var stops = colorInfo.map(function (c, i) {
          return c + " " + (i * pct) + "% " + ((i + 1) * pct) + "%";
        }).join(", ");
        style = ' style="background: conic-gradient(' + stops + ');"';
      } else {
        style = ' style="background:' + colorInfo + ';"';
      }
    }
    return L.divIcon({
      className: "",
      html: '<div class="marker-badge' + (done ? " done" : "") + '"' + style + '>' + num + "</div>",
      iconSize: [26, 26],
      iconAnchor: [13, 13],
    });
  }

  // Цвет маркера этой точки для карты — null означает "обычный вид, без
  // изменений" (флаг выключен, роль не админ, или точка вообще без
  // назначенного курьера). См. ROUTE_SPLIT_VIEW в config.py.
  function markerColorFor(point) {
    if (!state.splitView || state.role !== "admin") return null;
    var ids = point.courier_tg_ids || [];
    if (!ids.length) return null;
    if (ids.length === 1) return courierColor(ids[0]);
    return ids.map(courierColor);
  }

  function depotIcon() {
    return L.divIcon({
      className: "",
      html: '<div class="marker-badge depot">🏠</div>',
      iconSize: [30, 30],
      iconAnchor: [15, 15],
    });
  }

  function arrowIcon(angleDeg) {
    return L.divIcon({
      className: "",
      html: '<div class="route-arrow" style="transform: rotate(' + angleDeg + 'deg);"></div>',
      iconSize: [12, 12],
      iconAnchor: [6, 6],
    });
  }

  // Азимут a->b в градусах (0 = север, по часовой стрелке) — плоское
  // приближение, для масштаба одного города точности более чем достаточно.
  function bearingDeg(a, b) {
    var dy = b.lat - a.lat;
    var dx = (b.lng - a.lng) * Math.cos(a.lat * Math.PI / 180);
    return Math.atan2(dx, dy) * 180 / Math.PI;
  }

  // Раздвигает визуально слипшиеся метки (одно здание, соседние входы) —
  // только положение самих значков на экране, порядок и данные маршрута
  // не меняются.
  //
  // ВАЖНО: расстояние между точками меряем в пикселях НЕ текущего вида
  // карты (map.latLngToLayerPoint), а фиксированного "уличного" масштаба
  // REF_ZOOM через map.project/unproject. Раньше это был баг: при
  // fitBounds на разбросанный по городу маршрут карта часто открывается
  // на низком зуме (весь день на одном экране) — на нём 26px могли
  // означать сотни метров и даже больше километра, из-за чего разные,
  // ничем не связанные точки (соседние кварталы, а не "один дом")
  // принимались за слипшиеся и разъезжались на реальные сотни метров от
  // своего истинного адреса — ровно то место, куда ведёт кнопка
  // "Поехали", переставало совпадать с меткой на карте. project/unproject
  // считают то же самое пиксельное расстояние на фиксированном REF_ZOOM
  // независимо от того, на каком зуме сейчас открыта карта, поэтому и
  // вызывать эту функцию можно в любой момент, до или после fitBounds/
  // setView — на результат это больше не влияет.
  function declutterLatLngs(map, latlngs) {
    var THRESHOLD = 26; // px на REF_ZOOM — чуть больше диаметра бейджа (24px)
    var REF_ZOOM = 17; // масштаб "одного дома/квартала", как и задумано
    var pts = latlngs.map(function (ll) { return map.project(ll, REF_ZOOM); });
    var used = new Array(pts.length).fill(false);
    var groups = [];
    for (var i = 0; i < pts.length; i++) {
      if (used[i]) continue;
      var group = [i];
      used[i] = true;
      for (var j = i + 1; j < pts.length; j++) {
        if (used[j]) continue;
        if (pts[i].distanceTo(pts[j]) < THRESHOLD) {
          group.push(j);
          used[j] = true;
        }
      }
      groups.push(group);
    }
    groups.forEach(function (group) {
      if (group.length < 2) return;
      var cx = 0, cy = 0;
      group.forEach(function (idx) { cx += pts[idx].x; cy += pts[idx].y; });
      cx /= group.length;
      cy /= group.length;
      var radius = Math.max(15, 9 + group.length * 3);
      group.forEach(function (idx, k) {
        var angle = (2 * Math.PI * k) / group.length - Math.PI / 2;
        pts[idx] = L.point(cx + radius * Math.cos(angle), cy + radius * Math.sin(angle));
      });
    });
    return pts.map(function (pt) { return map.unproject(pt, REF_ZOOM); });
  }

  function renderMap(points) {
    if (typeof L === "undefined") {
      // Leaflet не подгрузился (например, нет связи с CDN) — карту просто
      // не показываем, но карточки ниже всё равно должны работать.
      document.getElementById("map").hidden = true;
      return;
    }
    document.getElementById("map").hidden = false;

    var withCoords = points.filter(function (p) {
      return p.lat && p.lon && !isNaN(parseFloat(p.lat)) && !isNaN(parseFloat(p.lon));
    });

    if (!state.map) {
      state.map = L.map("map", { zoomControl: false, attributionControl: true });
      // CartoDB (basemaps.cartocdn.com) к 2026 году требует API-ключ —
      // без него отдаёт водяной знак "API KEY REQUIRED" вместо тайлов, на
      // любом стиле (Voyager/Positron/Dark Matter — домен один и тот же).
      // Esri "World Light Gray Canvas" — тот же бесплатный сервис без
      // ключа, что и тёмный вариант, который уже был проверен рабочим,
      // только светлая палитра: два слоя, базовый (заливка/геометрия
      // улиц и кварталов) и Reference поверх (подписи улиц и
      // ориентиров). Лёгкий тёплый фильтр (см. styles.css #map
      // .leaflet-tile-pane) подстраивает нейтральный светло-серый под
      // тёплую айвори-палитру PAUSE, не размывая подписи.
      L.tileLayer(
        "https://services.arcgisonline.com/arcgis/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}",
        { maxZoom: 16, attribution: "Tiles &copy; Esri" }
      ).addTo(state.map);
      L.tileLayer(
        "https://services.arcgisonline.com/arcgis/rest/services/Canvas/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}",
        { maxZoom: 16 }
      ).addTo(state.map);
    }

    state.markers.forEach(function (m) { state.map.removeLayer(m); });
    state.markers = [];
    if (state.polyline) { state.map.removeLayer(state.polyline); state.polyline = null; }

    // Собираем ИСТИННЫЕ координаты по порядку: точка отправления (если
    // есть) первой, затем точки доставки — используются для выставления
    // масштаба карты (fitBounds), чтобы геометрическая рамка была точной.
    // Метки на экране после этого чуть раздвигаются (см. declutterLatLngs),
    // если легли бы друг на друга — сам маршрут при этом не искажается.
    var trueLatLngs = [];
    var depot = state.depot;
    if (depot && depot.lat && depot.lon) {
      trueLatLngs.push(L.latLng(parseFloat(depot.lat), parseFloat(depot.lon)));
    }
    withCoords.forEach(function (p) {
      trueLatLngs.push(L.latLng(parseFloat(p.lat), parseFloat(p.lon)));
    });

    if (!trueLatLngs.length) {
      state.map.setView([41.311081, 69.240562], 12); // Ташкент, центр — по умолчанию
      return;
    }

    if (trueLatLngs.length === 1) {
      state.map.setView(trueLatLngs[0], 15);
    } else {
      state.map.fitBounds(L.latLngBounds(trueLatLngs), { padding: [30, 30] });
    }

    var placedLatLngs = declutterLatLngs(state.map, trueLatLngs);
    var cursor = 0;

    if (depot && depot.lat && depot.lon) {
      var depotMarker = L.marker(placedLatLngs[cursor], { icon: depotIcon() }).addTo(state.map);
      depotMarker.bindPopup(depot.name + (depot.address ? " — " + depot.address : ""));
      state.markers.push(depotMarker);
      cursor++;
    }

    withCoords.forEach(function (p, idx) {
      var marker = L.marker(placedLatLngs[cursor], {
        icon: numberedIcon(idx + 1, p.status === "Сдано", markerColorFor(p)),
      }).addTo(state.map);
      marker.bindPopup(p.address || p.point);
      state.markers.push(marker);
      cursor++;
    });

    if (placedLatLngs.length > 1) {
      // Тонкая приглушённая пунктирная линия — просто ощущение
      // направления пути, а не акцент карты (акцент — сами точки).
      state.polyline = L.polyline(placedLatLngs, {
        color: "#6b5c48", weight: 2, opacity: 0.55, dashArray: "1 8", lineCap: "round",
      }).addTo(state.map);

      for (var i = 0; i < placedLatLngs.length - 1; i++) {
        var a = placedLatLngs[i], b = placedLatLngs[i + 1];
        var mid = L.latLng((a.lat + b.lat) / 2, (a.lng + b.lng) / 2);
        var arrow = L.marker(mid, { icon: arrowIcon(bearingDeg(a, b)), interactive: false }).addTo(state.map);
        state.markers.push(arrow);
      }
    }
  }

  // -------------------------------------------------------------------
  // Маршрут — карточки
  // -------------------------------------------------------------------

  function yandexMapsUrl(point) {
    var lat = parseFloat(point.lat), lon = parseFloat(point.lon);
    if (point.lat && point.lon && !isNaN(lat) && !isNaN(lon)) {
      return "https://yandex.ru/maps/?pt=" + lon + "," + lat + "&z=17&l=map";
    }
    return "https://yandex.ru/maps/?text=" + encodeURIComponent(point.address || point.point);
  }

  function openLink(url) {
    if (tg && tg.openLink) {
      tg.openLink(url);
    } else {
      window.open(url, "_blank");
    }
  }

  function activePointName(points) {
    var mine = points; // уже отфильтровано сервером для курьера
    for (var i = 0; i < mine.length; i++) {
      if (mine[i].status !== "Сдано") return mine[i].point;
    }
    return null;
  }

  var ICON_CHEVRON_DOWN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><path d="M6 9l6 6 6-6"/></svg>';

  function statusTag(point, isActive) {
    if (point.status === "Сдано") {
      return '<span class="card-status-tag done">Сдано ' + point.delivered_at + '</span>';
    }
    if (isActive && state.role === "courier") {
      return '<span class="card-status-tag active">Следующая</span>';
    }
    return "";
  }

  function buildCard(point, index, active) {
    var totalPeople = point.people.length;
    var card = document.createElement("div");
    card.className = "card" + (point.status === "Сдано" ? " done" : "") + (point.pinned ? " pinned" : "");
    card.dataset.point = point.point;

    var head = document.createElement("div");
    head.className = "card-head";

    if (state.role === "admin") {
      var handle = document.createElement("div");
      handle.className = "drag-handle";
      handle.textContent = "☰";
      head.appendChild(handle);
    }

    var num = document.createElement("div");
    num.className = "card-num";
    num.textContent = index + 1;
    head.appendChild(num);

    var main = document.createElement("div");
    main.className = "card-main";
    // Название точки — всегда первой и чётко видной строкой (раньше сюда
    // подставлялся адрес, а если его не было — то же название точки уходило
    // во вторую строку, и было непонятно, что именно за точка перед
    // глазами). Адрес — под ним, если он есть в каталоге "Точки доставки".
    var addr = document.createElement("div");
    addr.className = "card-address";
    addr.textContent = point.point;
    // Только админ должен видеть, что у точки нет координат в каталоге
    // "Точки доставки" — курьеру это не нужно (у него и так есть рабочий
    // резерв: кнопка "Поехали" открывает Яндекс.Карты по текстовому адресу,
    // см. yandexMapsUrl), а вот админу нужно узнать об этом ДО того, как
    // курьер поедет, чтобы успеть вписать координаты в справочник.
    if (state.role === "admin" && (!point.lat || !point.lon)) {
      var warnIcon = document.createElement("span");
      warnIcon.className = "card-no-coords-warn";
      warnIcon.textContent = " ⚠️";
      warnIcon.title = "Нет координат в «Точки доставки» — впишите широту/долготу";
      addr.appendChild(warnIcon);
    }
    var sub = document.createElement("div");
    sub.className = "card-sub";
    var subParts = [];
    if (point.address) subParts.push(point.address);
    subParts.push(totalPeople + (totalPeople === 1 ? " человек" : " человек(а)"));
    sub.textContent = subParts.join(" · ");
    main.appendChild(addr);
    main.appendChild(sub);
    head.appendChild(main);

    var tagHtml = statusTag(point, active);
    if (tagHtml) {
      var tagWrap = document.createElement("div");
      tagWrap.innerHTML = tagHtml;
      head.appendChild(tagWrap.firstChild);
    }

    var chevron = document.createElement("div");
    chevron.className = "card-chevron";
    chevron.innerHTML = ICON_CHEVRON_DOWN;
    head.appendChild(chevron);

    if (state.role === "admin") {
      var removeBtn = document.createElement("button");
      removeBtn.className = "card-remove";
      removeBtn.textContent = "×";
      removeBtn.addEventListener("click", function (e) {
        e.stopPropagation();
        showConfirm(
          "Убрать «" + point.point + "» из маршрута на " + state.date + "?",
          "Да, убрать",
          function () { removePoint(point.point); }
        );
      });
      head.appendChild(removeBtn);
    }

    head.addEventListener("click", function () {
      state.expanded[point.point] = !state.expanded[point.point];
      card.classList.toggle("expanded", state.expanded[point.point]);
    });

    card.appendChild(head);

    var body = document.createElement("div");
    body.className = "card-body";

    // Кнопка-переключатель курьера — видна только админу (по умолчанию
    // новая точка достаётся сразу всем активным курьерам, см.
    // sync_daily_route — эта кнопка нужна, чтобы снять кого-то конкретного
    // или назначить точку только одному).
    if (state.role === "admin") {
      var courierBtn = document.createElement("button");
      courierBtn.className = "route-courier-btn";
      courierBtn.textContent = courierNamesFor(point.courier_tg_ids) || "Курьер не назначен";
      courierBtn.addEventListener("click", function (e) {
        e.stopPropagation();
        openCourierPicker(point);
      });
      body.appendChild(courierBtn);
    }

    // "Закрепить" — только админ. Закрепление касается ТОЛЬКО позиции
    // карточки (запрет перетаскивания + автодобавление новых точек её не
    // сдвигает, см. sync_daily_route/add_route_point — они и так всегда
    // дописывают в конец, не трогая существующие строки) — все остальные
    // действия с точкой работают как обычно вне зависимости от этого флага.
    if (state.role === "admin") {
      var pinBtn = document.createElement("button");
      pinBtn.className = "route-pin-btn";
      pinBtn.textContent = point.pinned ? "Открепить" : "Закрепить";
      pinBtn.addEventListener("click", function (e) {
        e.stopPropagation();
        setRoutePinned(point.point, !point.pinned);
      });
      body.appendChild(pinBtn);
    }

    // "Комментарий для курьера" — на этот день у этой точки, не связан с
    // конкретным человеком (пример: "заберёт Тимур, звоните ему"). После
    // сохранения поле блокируется от случайной правки (показывает
    // сохранённый текст, не редактируется) — кнопка "Сохранить" меняется
    // на "Изменить", по которой поле снова становится редактируемым;
    // цикл Сохранить→Изменить→Сохранить повторяется одинаково каждый раз.
    // Курьер видит текст отдельным заметным блоком, без редактирования.
    if (state.role === "admin") {
      var commentWrap = document.createElement("div");
      commentWrap.className = "route-comment-edit";
      var commentLabel = document.createElement("div");
      commentLabel.className = "route-comment-label";
      commentLabel.textContent = "Комментарий для курьера";
      var commentInput = document.createElement("textarea");
      commentInput.className = "route-comment-input";
      commentInput.rows = 2;
      commentInput.value = point.courier_comment || "";
      commentInput.addEventListener("click", function (e) { e.stopPropagation(); });
      var commentBtn = document.createElement("button");
      commentBtn.className = "btn-text route-comment-save";

      var commentLocked = !!(point.courier_comment && point.courier_comment.trim());
      var setCommentLocked = function (locked) {
        commentLocked = locked;
        commentInput.disabled = locked;
        commentInput.classList.toggle("locked", locked);
        commentBtn.textContent = locked ? "Изменить" : "Сохранить";
      };
      setCommentLocked(commentLocked);

      commentBtn.addEventListener("click", function (e) {
        e.stopPropagation();
        if (commentLocked) {
          setCommentLocked(false);
          commentInput.focus();
          return;
        }
        saveCourierComment(point.point, commentInput.value, function () {
          setCommentLocked(true);
        });
      });
      commentWrap.appendChild(commentLabel);
      commentWrap.appendChild(commentInput);
      commentWrap.appendChild(commentBtn);
      body.appendChild(commentWrap);
    } else if (point.courier_comment) {
      var commentBlock = document.createElement("div");
      commentBlock.className = "route-comment-block";
      commentBlock.textContent = point.courier_comment;
      body.appendChild(commentBlock);
    }

    point.people.forEach(function (p) {
      var pDiv = document.createElement("div");
      pDiv.className = "person";
      var name = document.createElement("div");
      name.className = "person-name";
      name.textContent = p.name;
      var line1 = document.createElement("div");
      line1.className = "person-line";
      var tel = telHref(p.contact);
      if (tel) {
        var contactLink = document.createElement("a");
        contactLink.href = tel;
        contactLink.textContent = p.contact;
        // Известный баг Telegram: в WebView на iOS клик по <a href="tel:">
        // (и точно так же tg.openLink()/openTelegramLink() — тот вовсе
        // отклоняет tel: с ошибкой "Url protocol is not supported") просто
        // ничего не делает, хотя на Android та же ссылка работает как
        // обычно (подтверждено сообществом: issues в Telegram-Mini-Apps/
        // tma.js #677 и TelegramMessenger/Telegram-iOS). Рабочий обход —
        // вызвать window.open(tel, "_self") СИНХРОННО прямо в обработчике
        // клика (не через промис/таймаут — iOS считает такое всплывающим
        // окном и блокирует). На Android трогать не нужно: там обычный
        // href и так работает, а дублирующий window.open() показал бы
        // курьеру два системных диалога звонка подряд.
        if (tg && tg.platform === "ios") {
          contactLink.addEventListener("click", function (e) {
            e.preventDefault();
            window.open(tel, "_self");
          });
        }
        line1.appendChild(contactLink);
        line1.appendChild(document.createTextNode(" · " + itemsText(p.items)));

        // Запасной вариант на случай, если обход выше всё же не сработает
        // на каком-то конкретном iOS/Telegram сочетании версий (у нас нет
        // возможности проверить это на реальном iPhone) — гарантированно
        // рабочий способ добыть номер: скопировать и вставить в "Телефон"
        // вручную. Показываем только на iOS, чтобы не загромождать
        // карточку там, где обычный клик и так работает.
        if (tg && tg.platform === "ios") {
          var copyBtn = document.createElement("button");
          copyBtn.type = "button";
          copyBtn.className = "copy-tel-btn";
          copyBtn.textContent = "📋";
          copyBtn.title = "Скопировать номер";
          copyBtn.addEventListener("click", function (e) {
            e.stopPropagation();
            copyToClipboard(p.contact)
              .then(function () { toast("Номер скопирован: " + p.contact); })
              .catch(function () { toast("Не удалось скопировать номер"); });
          });
          line1.appendChild(copyBtn);
        }
      } else {
        line1.textContent = p.contact + " · " + itemsText(p.items);
      }
      pDiv.appendChild(name);
      pDiv.appendChild(line1);
      if (p.comment) {
        var line2 = document.createElement("div");
        line2.className = "person-line";
        line2.textContent = "💬 " + p.comment;
        pDiv.appendChild(line2);
      }
      body.appendChild(pDiv);
    });

    card.appendChild(body);

    // Кнопки курьера у активной точки — всегда на виду, не прячем их за
    // разворачиванием карточки (это самое частое действие).
    if (state.role === "courier" && active && point.status !== "Сдано") {
      var actions = document.createElement("div");
      actions.className = "card-actions";
      var goBtn = document.createElement("button");
      goBtn.className = "btn-primary";
      goBtn.textContent = "Поехали";
      goBtn.addEventListener("click", function () { openLink(yandexMapsUrl(point)); });
      var doneBtn = document.createElement("button");
      doneBtn.className = "btn-primary success";
      doneBtn.textContent = "Сдано";
      doneBtn.addEventListener("click", function () { completePoint(point.point); });
      actions.appendChild(goBtn);
      actions.appendChild(doneBtn);
      card.appendChild(actions);
    }

    if (state.expanded[point.point]) card.classList.add("expanded");
    return card;
  }

  function renderCards() {
    var container = document.getElementById("cards");
    container.innerHTML = "";
    var list = visiblePoints();
    var active = state.role === "courier" ? activePointName(list) : null;
    list.forEach(function (p, idx) {
      container.appendChild(buildCard(p, idx, p.point === active));
    });

    if (state.role === "admin" && window.Sortable && !container._sortable) {
      container._sortable = new Sortable(container, {
        handle: ".drag-handle",
        // Закреплённую карточку саму нельзя взять и потащить (см.
        // "Закрепить" на карточке) — filter не даёт Sortable начать
        // перетаскивание при клике на элемент с этим классом.
        filter: ".pinned",
        preventOnFilter: true,
        animation: 150,
        onEnd: onReorder,
      });
    }
  }

  function render() {
    // Раз мы тут — запрос успешно отработал, так что любая ошибка/кнопка
    // "Повторить" от прошлой неудачной попытки больше не актуальна.
    document.getElementById("retry-btn").hidden = true;

    // Пока админ не включил видимость этой даты (см. "Профиль" → "Центр
    // управления" → "Видимость маршрутов") — курьер вместо карты/карточек
    // видит только это сообщение. Админ этим не ограничен — он должен
    // видеть маршрут всегда, чтобы как раз его и подготовить перед тем,
    // как включить видимость.
    var hiddenFromCourier = state.role === "courier" && !state.visible;

    document.getElementById("map").hidden = hiddenFromCourier;
    document.getElementById("add-point-btn").hidden = state.role !== "admin" || hiddenFromCourier;

    if (hiddenFromCourier) {
      document.getElementById("cards").hidden = true;
      document.getElementById("empty-state").hidden = false;
      document.getElementById("empty-state-text").textContent =
        "Маршрут на этот день ещё готовится — сообщим, как будет готов 🌿";
      renderDatePicker();
      return;
    }

    renderCourierTabs();
    var visible = visiblePoints();

    // "На сегодня" только если реально смотрим на активную дату — на любой
    // другой выбранной дате пустой список означает просто "на эту дату
    // заказов пока нет", а не что-то сломалось. На вкладке конкретного
    // курьера (см. ROUTE_SPLIT_VIEW) отдельное сообщение, если у ЭТОГО
    // курьера точек нет, а у маршрута в целом — есть, иначе "нет точек" на
    // самом деле означало бы "нет заказов", хотя они есть.
    document.getElementById("empty-state-text").textContent =
      visible.length === 0 && state.points.length > 0 && state.courierTab !== "all"
        ? "У этого курьера нет точек на эту дату 🌿"
        : state.date === state.activeDate
          ? "На сегодня точек с заказами пока нет 🌿"
          : "На эту дату заказов пока нет 🌿";

    document.getElementById("empty-state").hidden = visible.length > 0;
    document.getElementById("cards").hidden = visible.length === 0;
    renderMap(visible);
    renderCards();
    renderDatePicker();
  }

  // -------------------------------------------------------------------
  // Действия
  // -------------------------------------------------------------------

  function loadRoute(dateOverride) {
    var url = "/api/route" + (dateOverride ? "?date=" + encodeURIComponent(dateOverride) : "");
    return api(url).then(function (data) {
      state.date = data.date;
      state.points = data.points;
      state.depot = data.depot || null;
      state.visible = data.visible !== false;
      render();
    }).catch(function (err) {
      toast("Не удалось загрузить маршрут: " + err.message);
      // Если это самая первая загрузка (карточек ещё не было) — показываем
      // явную ошибку с кнопкой "Повторить", а не молчаливый тост. Если
      // маршрут уже был показан раньше — оставляем его на экране как есть,
      // а не стираем из-за одной неудачной попытки.
      if (!state.points.length) {
        showLoadError("Не получилось загрузить маршрут — временная проблема с сервером.");
      }
    });
  }

  function loadRouteDates() {
    return api("/api/route/dates").then(function (data) {
      state.dates = data.dates;
      state.activeDate = data.active;
      renderDatePicker();
    }).catch(function () {
      // Не критично — просто не покажем переключатель дат, сам маршрут
      // при этом всё равно загружается отдельным запросом.
    });
  }

  // Единообразно "ДД.ММ" — раньше "Сегодня"/"Завтра"/"Вчера" словами для
  // одних дат и числами для других визуально путало (смешанный формат в
  // одном ряду). Теперь, когда лента дат открыта на всю историю (не
  // только последние 3 дня, см. sheets.get_route_available_dates), "ДД.ММ"
  // само по себе уже не однозначно — тот же день/месяц мог быть и год
  // назад. Год дописываем ТОЛЬКО для дат не из текущего календарного
  // года — обычный случай (весь список за один год) остаётся компактным,
  // а не вырастает до "ДД.ММ.ГГГГ" на каждой пилюле.
  function dateLabel(d) {
    var parts = d.split(".");
    var year = parts[2];
    var curYear = String(new Date().getFullYear());
    return year === curYear ? d.slice(0, 5) : parts[0] + "." + parts[1] + "." + year.slice(2);
  }

  // Лента дат теперь может уходить далеко в прошлое (вся история с
  // заказами, см. sheets.get_route_available_dates) — "последние 3 дня"
  // при этом всё равно должны быть видны СРАЗУ, без прокрутки влево. При
  // первой отрисовке (datePickerAutoScrolled ещё не было) докручиваем
  // ленту так, чтобы начало этого трёхдневного окна оказалось у левого
  // края видимой области — дальше пользователь сам листает в обе стороны,
  // повторных авто-прокруток при переключении даты уже нет (не мешаем
  // ручной навигации).
  var datePickerAutoScrolled = false;

  function renderDatePicker() {
    var container = document.getElementById("route-date-picker");
    if (!state.dates.length) {
      container.hidden = true;
      return;
    }
    container.hidden = false;
    container.innerHTML = "";
    state.dates.forEach(function (d) {
      var btn = document.createElement("button");
      btn.className = "date-pill" + (d === state.date ? " active" : "");
      btn.textContent = dateLabel(d);
      btn.addEventListener("click", function () {
        if (d === state.date) return;
        loadRoute(d);
      });
      container.appendChild(btn);
    });

    if (!datePickerAutoScrolled) {
      datePickerAutoScrolled = true;
      var activeIdx = state.dates.indexOf(state.activeDate);
      var windowStartIdx = activeIdx === -1 ? 0 : Math.max(0, activeIdx - 2);
      var targetBtn = container.children[windowStartIdx];
      if (targetBtn) targetBtn.scrollIntoView({ inline: "start", block: "nearest" });
    }
  }

  // Вкладки курьеров над картой (см. ROUTE_SPLIT_VIEW) — только у админа,
  // и только когда флаг включён и есть хотя бы один курьер в справочнике.
  // При выключенном флаге/роли курьера контейнер просто остаётся скрытым —
  // остальной экран не отличается от того, что было до этой функции.
  function renderCourierTabs() {
    var container = document.getElementById("courier-tabs");
    if (!state.splitView || state.role !== "admin" || !state.couriers.length) {
      container.hidden = true;
      return;
    }
    // Курьер, на чью вкладку админ переключился, мог с тех пор пропасть из
    // справочника — откатываемся на "Все", а не оставляем пустую вкладку.
    if (state.courierTab !== "all" && !state.couriers.some(function (c) { return c.tg_id === state.courierTab; })) {
      state.courierTab = "all";
    }

    container.hidden = false;
    container.innerHTML = "";

    var allBtn = document.createElement("button");
    allBtn.className = "date-pill courier-tab" + (state.courierTab === "all" ? " active" : "");
    allBtn.textContent = "Все";
    allBtn.addEventListener("click", function () {
      if (state.courierTab === "all") return;
      state.courierTab = "all";
      render();
    });
    container.appendChild(allBtn);

    state.couriers.forEach(function (c) {
      var btn = document.createElement("button");
      btn.className = "date-pill courier-tab" + (state.courierTab === c.tg_id ? " active" : "");
      var dot = document.createElement("span");
      dot.className = "courier-tab-dot";
      dot.style.background = courierColor(c.tg_id);
      btn.appendChild(dot);
      btn.appendChild(document.createTextNode(c.name || c.tg_id));
      btn.addEventListener("click", function () {
        if (state.courierTab === c.tg_id) return;
        state.courierTab = c.tg_id;
        render();
      });
      container.appendChild(btn);
    });
  }

  function showLoadError(message) {
    document.getElementById("cards").innerHTML = "";
    document.getElementById("empty-state").hidden = false;
    document.getElementById("empty-state-text").textContent = message;
    document.getElementById("retry-btn").hidden = false;
  }

  var reorderInFlight = false;
  var reorderQueued = null;

  function saveReorder(order) {
    reorderInFlight = true;
    api("/api/route/reorder", { method: "POST", body: { date: state.date, order: order } })
      .then(function () {
        // Раз сохранили — обновляем и локальный state.points, чтобы карточки
        // больше не перерисовывались из уже устаревших данных, даже если
        // следующий loadRoute() задержится или временно не пройдёт.
        state.points = state.points.slice().sort(function (a, b) {
          return (order[a.point] || 0) - (order[b.point] || 0);
        });
        // Если в списке есть закреплённые точки, реальный сохранённый
        // порядок (после того как onReorder вернул их на место) может
        // отличаться от того, что Sortable уже показал в DOM во время
        // перетаскивания — перерисовываем карточки, чтобы закреплённая
        // точка визуально сразу "вернулась" на свою позицию, а не только
        // после следующей полной перезагрузки экрана.
        renderCards();
      })
      .catch(function (err) {
        // Сохранить не удалось — не оставляем на экране порядок, который
        // существует только в браузере и не записан в таблицу: перезагружаем
        // настоящий порядок с сервера, а не молчим. Это и есть тот самый
        // "откат к исходному состоянию" — он теперь ожидаемый и подписанный,
        // а не выглядит как необъяснимый сбой.
        toast("Не удалось сохранить порядок, показываю сохранённый: " + err.message);
        return loadRoute(state.date);
      })
      .then(function () {
        reorderInFlight = false;
        if (reorderQueued) {
          var next = reorderQueued;
          reorderQueued = null;
          saveReorder(next);
        }
      });
  }

  function onReorder() {
    var container = document.getElementById("cards");
    var domOrder = Array.prototype.map.call(container.children, function (card) {
      return card.dataset.point;
    });

    // Закреплённую карточку саму перетащить нельзя (см. Sortable filter
    // выше), но когда мимо неё тащат ДРУГУЮ карточку, Sortable всё равно
    // визуально сдвигает её на соседнюю позицию — это неизбежный побочный
    // эффект перетаскивания списка. Возвращаем каждую закреплённую точку
    // на ту же ОТНОСИТЕЛЬНУЮ позицию в списке, где она была до этого
    // перетаскивания, а все обычные точки — в новом порядке, в котором их
    // расставил админ, просто "перетекая" мимо зафиксированных мест.
    // "Список" здесь — то, что реально сейчас показано (см. visiblePoints):
    // на вкладке курьера это только его точки, закреплённые точки ДРУГИХ
    // курьеров тут вообще не участвуют, их не видно и не переставляли.
    var visible = visiblePoints();
    var pinnedPoints = visible.filter(function (p) { return p.pinned; }).map(function (p) { return p.point; });
    if (pinnedPoints.length) {
      var movedWithoutPinned = domOrder.filter(function (name) { return pinnedPoints.indexOf(name) === -1; });
      var originalOrder = visible.map(function (p) { return p.point; });
      var fixed = [];
      var wi = 0;
      originalOrder.forEach(function (name) {
        if (pinnedPoints.indexOf(name) !== -1) {
          fixed.push(name);
        } else if (wi < movedWithoutPinned.length) {
          fixed.push(movedWithoutPinned[wi++]);
        }
      });
      domOrder = fixed;
    }

    // Переносим этот новый относительный порядок в полный список — на
    // вкладке "Все" (или при выключенном флаге) domOrder и так содержит
    // все точки, поэтому результат ничем не отличается от прежнего
    // поведения "пронумеровать DOM-порядок подряд" (см. mergeSubsetOrder).
    var order = mergeSubsetOrder(state.points, domOrder);

    // Если админ перетаскивает вторую карточку, пока сохранение первой ещё
    // не вернулось — это создаёт гонку двух параллельных запросов, где более
    // медленный (например, после повтора на 429) может "победить" и
    // затереть в таблице более свежий, только что сохранённый порядок.
    // Пока предыдущее сохранение не завершилось — новое ставим в очередь
    // (перезаписывая предыдущее ожидающее), чтобы в итоге сохранился только
    // САМЫЙ последний порядок, а не устаревший промежуточный.
    if (reorderInFlight) {
      reorderQueued = order;
      return;
    }
    saveReorder(order);
  }

  function removePoint(point) {
    var date = state.date;
    api("/api/route/remove", { method: "POST", body: { date: date, point: point } })
      .then(function () { return loadRoute(date); })
      .catch(function (err) { toast("Не удалось убрать точку: " + err.message); });
  }

  function setRoutePinned(point, pinned) {
    var date = state.date;
    api("/api/route/pin", { method: "POST", body: { date: date, point: point, pinned: pinned } })
      .then(function () { return loadRoute(date); })
      .catch(function (err) { toast("Не удалось изменить закрепление: " + err.message); });
  }

  function completePoint(point) {
    var date = state.date;
    api("/api/route/complete", { method: "POST", body: { date: date, point: point } })
      .then(function () {
        haptic("success");
        return loadRoute(date);
      })
      .catch(function (err) { toast("Не удалось отметить: " + err.message); });
  }

  function saveCourierComment(point, comment, onSuccess) {
    var date = state.date;
    api("/api/route/comment", { method: "POST", body: { date: date, point: point, comment: comment } })
      .then(function () {
        toast("Комментарий сохранён");
        var p = state.points.filter(function (x) { return x.point === point; })[0];
        if (p) p.courier_comment = comment;
        // Поле блокируется от правки только ПОСЛЕ подтверждённого сохранения
        // (не сразу по клику) — если запрос не удался, поле остаётся
        // редактируемым с кнопкой "Сохранить", чтобы можно было повторить.
        if (onSuccess) onSuccess();
      })
      .catch(function (err) { toast("Не удалось сохранить комментарий: " + err.message); });
  }

  // -------------------------------------------------------------------
  // Назначение курьера на точку (только админ)
  // -------------------------------------------------------------------

  function loadCouriers() {
    return api("/api/couriers").then(function (data) {
      state.couriers = data.couriers || [];
      // loadCouriers() и loadRoute() идут параллельно (см. startApp) — если
      // маршрут уже успел отрисоваться без списка курьеров, вкладки нужно
      // дорисовать отдельно, а не ждать следующего полного render().
      renderCourierTabs();
    }).catch(function () {
      // Не критично — просто кнопка назначения курьера покажет ID вместо
      // имени, пока список не подгрузится (или останется пустым при ошибке).
    });
  }

  function courierNameFor(tgId) {
    if (!tgId) return "";
    var c = state.couriers.filter(function (x) { return x.tg_id === tgId; })[0];
    return c ? c.name || c.tg_id : tgId;
  }

  // Точку можно закрепить сразу за несколькими курьерами — показываем все
  // назначенные имена через запятую (порядок как в списке courier_tg_ids).
  function courierNamesFor(tgIds) {
    if (!tgIds || !tgIds.length) return "";
    return tgIds.map(courierNameFor).join(", ");
  }

  // Модалка с переключателем (галочкой) у каждого курьера — можно отметить
  // сразу нескольких, точка закрепляется за всеми отмеченными одновременно.
  // Каждая галочка применяется сразу (как переключатели видимости на
  // экране "Профиль"), без отдельной кнопки "Сохранить" — список читает
  // актуальное состояние всех галочек в модалке при каждом изменении и
  // отправляет его целиком.
  function openCourierPicker(point) {
    var modal = document.getElementById("courier-picker-modal");
    var list = document.getElementById("courier-picker-list");
    list.innerHTML = "";
    if (!state.couriers.length) {
      list.innerHTML = "<div class=\"modal-list-empty\">Нет ни одного курьера в справочнике «Курьеры»</div>";
      modal.hidden = false;
      return;
    }

    function applySelection(inputEl) {
      inputEl.disabled = true;
      var date = state.date;
      var ids = Array.prototype.filter.call(
        list.querySelectorAll("input[type=checkbox]"),
        function (el) { return el.checked; }
      ).map(function (el) { return el.dataset.tgId; });
      api("/api/route/assign", { method: "POST", body: { date: date, point: point.point, courier_tg_ids: ids } })
        .then(function () {
          point.courier_tg_ids = ids;
          return loadRoute(date);
        })
        .catch(function (err) {
          inputEl.checked = !inputEl.checked; // не удалось сохранить — откатываем галочку обратно
          toast("Не удалось изменить курьеров: " + err.message);
        })
        .then(function () { inputEl.disabled = false; });
    }

    state.couriers.forEach(function (c) {
      var row = document.createElement("div");
      row.className = "visibility-row";

      var label = document.createElement("div");
      label.className = "visibility-row-label";
      label.textContent = c.name || c.tg_id;

      var switchLabel = document.createElement("label");
      switchLabel.className = "switch";
      var input = document.createElement("input");
      input.type = "checkbox";
      input.dataset.tgId = c.tg_id;
      input.checked = point.courier_tg_ids.indexOf(c.tg_id) !== -1;
      var slider = document.createElement("span");
      slider.className = "switch-slider";
      switchLabel.appendChild(input);
      switchLabel.appendChild(slider);

      input.addEventListener("change", function () { applySelection(input); });

      row.appendChild(label);
      row.appendChild(switchLabel);
      list.appendChild(row);
    });

    modal.hidden = false;
  }

  function openAddPointModal() {
    var modal = document.getElementById("add-point-modal");
    var list = document.getElementById("add-point-list");
    list.innerHTML = "<div class=\"modal-list-empty\">Загрузка…</div>";
    modal.hidden = false;

    api("/api/delivery_points").then(function (data) {
      var already = state.points.map(function (p) { return p.point; });
      var options = data.points.filter(function (p) { return already.indexOf(p.name) === -1; });
      list.innerHTML = "";
      if (!options.length) {
        list.innerHTML = "<div class=\"modal-list-empty\">Все точки из справочника уже в маршруте</div>";
        return;
      }
      options.forEach(function (p) {
        var item = document.createElement("div");
        item.className = "modal-list-item";
        item.textContent = p.name + (p.address ? " — " + p.address : "");
        item.addEventListener("click", function () {
          modal.hidden = true;
          var date = state.date;
          api("/api/route/add", { method: "POST", body: { date: date, point: p.name } })
            .then(function () { return loadRoute(date); })
            .catch(function (err) { toast("Не удалось добавить: " + err.message); });
        });
        list.appendChild(item);
      });
    }).catch(function (err) {
      list.innerHTML = "<div class=\"modal-list-empty\">Ошибка загрузки</div>";
      toast(err.message);
    });
  }

  // -------------------------------------------------------------------
  // "Мои доходы" (курьер, не являющийся админом Mini App) — заглушка на
  // будущее, по прямой просьбе: полноценного расчёта заработка пока нет,
  // раздел только обозначен.
  // -------------------------------------------------------------------

  var ICON_WALLET_BIG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" width="56" height="56"><rect x="2.5" y="6" width="19" height="13.5" rx="3"/><path d="M2.5 10.5h19"/><circle cx="16" cy="14.5" r="1.2" fill="currentColor" stroke="none"/></svg>';

  function renderEarningsStub(root) {
    root.innerHTML = "";
    var wrap = el("div", "earnings-stub");
    wrap.innerHTML =
      ICON_WALLET_BIG +
      '<div class="earnings-stub-title">Раздел в разработке</div>' +
      '<div class="earnings-stub-text">Скоро здесь появится ваш заработок — за день, за месяц, по сменам.</div>';
    root.appendChild(wrap);
  }

  // -------------------------------------------------------------------
  // Видимость маршрута для курьера, по датам (только isRouteAdmin,
  // экран "Профиль" → "Центр управления" → "Видимость маршрутов")
  // -------------------------------------------------------------------

  var MONTH_NAMES_RU = ["январь", "февраль", "март", "апрель", "май", "июнь",
    "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь"];

  // "15.10.2026" -> "Октябрь 2026" — заголовок группы в списке "Видимость
  // маршрутов" (см. renderVisibilityList ниже), по которому длинная
  // история сканируется глазами куда проще, чем сплошным списком дат.
  function monthGroupLabel(dateStr) {
    var parts = dateStr.split(".");
    var month = parseInt(parts[1], 10);
    var name = MONTH_NAMES_RU[month - 1] || "";
    return (name.charAt(0).toUpperCase() + name.slice(1)) + " " + parts[2];
  }

  // Список дат теперь может уйти далеко в историю (см.
  // sheets.get_route_available_dates — открыт доступ ко ВСЕМ дням с
  // заказами, не только последним трём) — по прямой просьбе сделать это
  // "красиво и удобно: фильтровать и искать": строка поиска по дате
  // сверху (фильтрует по подстроке "ДД.ММ.ГГГГ" на лету) + группировка
  // по месяцам внутри уже отсортированного по убыванию списка (новые
  // сверху, см. sheets.get_route_visibility_status), чтобы "последние 3
  // дня" были первыми без всякой прокрутки, а более ранняя история
  // оставалась под рукой, а не терялась в одной длинной лентой строк.
  function renderVisibilityList(root, allDates) {
    root.innerHTML = "";

    var searchField = el("div", "field visibility-search-field");
    var searchInput = document.createElement("input");
    searchInput.type = "text";
    searchInput.placeholder = "Найти дату — например, 15.09.2026";
    searchField.appendChild(searchInput);
    root.appendChild(searchField);

    var listWrap = el("div");
    root.appendChild(listWrap);

    function renderRows(filterText) {
      listWrap.innerHTML = "";
      var filtered = filterText
        ? allDates.filter(function (d) { return d.date.indexOf(filterText) !== -1; })
        : allDates;

      if (!filtered.length) {
        listWrap.appendChild(el("div", "modal-list-empty", filterText ? "Ничего не найдено" : "Пока нет доступных дат"));
        return;
      }

      var lastMonth = null;
      var card = null;
      filtered.forEach(function (d) {
        var mLabel = monthGroupLabel(d.date);
        if (mLabel !== lastMonth) {
          lastMonth = mLabel;
          listWrap.appendChild(el("div", "profile-section-title", mLabel));
          card = el("div", "card");
          listWrap.appendChild(card);
        }

        var row = el("div", "visibility-row");
        var label = el("div", "visibility-row-label", escapeHtml(d.date + (d.date === state.activeDate ? " · сегодня" : "")));

        var switchLabel = el("label", "switch");
        var input = document.createElement("input");
        input.type = "checkbox";
        input.checked = d.visible;
        var slider = el("span", "switch-slider");
        switchLabel.appendChild(input);
        switchLabel.appendChild(slider);

        input.addEventListener("change", function () {
          setRouteVisibility(d.date, input.checked, input);
        });

        row.appendChild(label);
        row.appendChild(switchLabel);
        card.appendChild(row);
      });
    }

    renderRows("");
    searchInput.addEventListener("input", function () {
      renderRows(searchInput.value.trim());
    });
  }

  function loadVisibilityScreen(root) {
    root.innerHTML = "";
    root.appendChild(el("div", "skeleton-block"));
    api("/api/route/visibility").then(function (data) {
      renderVisibilityList(root, data.dates);
    }).catch(function (err) {
      root.innerHTML = "";
      root.appendChild(el("div", "empty-note", "Не удалось загрузить список дат: " + err.message));
    });
  }

  function setRouteVisibility(date, visible, inputEl) {
    inputEl.disabled = true;
    api("/api/route/visibility", { method: "POST", body: { date: date, visible: visible } })
      .then(function (data) {
        if (visible && data.notified) {
          toast("Курьер уведомлён — маршрут на " + date + " для него открыт");
        } else if (visible) {
          toast("Видимость включена");
        } else {
          toast("Видимость выключена");
        }
      })
      .catch(function (err) {
        inputEl.checked = !visible; // не удалось сохранить — откатываем переключатель обратно
        toast("Не удалось изменить видимость: " + err.message);
      })
      .then(function () {
        inputEl.disabled = false;
      });
  }

  // -------------------------------------------------------------------
  // "Режим" (Администратор/Курьер) — только у админов этого Mini App
  // (см. config.ROUTE_ADMIN_IDS, state.canToggleMode), экран "Профиль"
  // -------------------------------------------------------------------

  function setRouteAdminMode(mode) {
    Array.prototype.forEach.call(document.querySelectorAll(".mode-switch-btn"), function (btn) { btn.disabled = true; });
    api("/api/route_admin/mode", { method: "POST", body: { mode: mode } })
      .then(function () {
        toast(mode === "courier" ? "Режим «Курьер» включён" : "Режим «Администратор» включён");
        // Проще и надёжнее перезагрузить экран целиком, чем вручную
        // пересобирать весь кэш состояния (точки, курьеры, вкладки,
        // карту) под новую роль — переключение происходит нечасто.
        window.location.reload();
      })
      .catch(function (err) {
        toast("Не удалось переключить режим: " + err.message);
        Array.prototype.forEach.call(document.querySelectorAll(".mode-switch-btn"), function (btn) { btn.disabled = false; });
      });
  }

  // -------------------------------------------------------------------
  // Расходы на логистику (только isRouteAdmin, экран "Профиль" → "Центр
  // управления" → "Расходы на логистику")
  // -------------------------------------------------------------------

  function renderLogisticsScreen(root) {
    root.innerHTML = "";
    if (!state.logisticsDateISO) {
      state.logisticsDateISO = new Date().toISOString().slice(0, 10);
    }

    var dateRow = el("div", "date-picker-row");
    var prevBtn = el("button", "icon-btn", "‹");
    var dateInput = document.createElement("input");
    dateInput.type = "date";
    dateInput.value = state.logisticsDateISO;
    var nextBtn = el("button", "icon-btn", "›");
    dateRow.appendChild(prevBtn);
    dateRow.appendChild(dateInput);
    dateRow.appendChild(nextBtn);
    root.appendChild(dateRow);

    root.appendChild(el("div", "profile-section-title", "Оплата за смену"));
    var couriersCard = el("div", "card");
    var couriersList = el("div");
    couriersCard.appendChild(couriersList);
    root.appendChild(couriersCard);

    root.appendChild(el("div", "profile-section-title", "Доставка через сервисы (Яндекс, Uklon и др.)"));
    var expenseCard = el("div", "card");
    var expenseRow = el("div", "logistics-field-row");
    var expenseInput = document.createElement("input");
    expenseInput.type = "number";
    expenseInput.inputMode = "numeric";
    expenseInput.min = "0";
    expenseInput.placeholder = "0";
    expenseRow.appendChild(expenseInput);
    expenseRow.appendChild(el("span", "logistics-field-suffix", "сум"));
    expenseCard.appendChild(expenseRow);
    root.appendChild(expenseCard);

    var saveBtn = el("button", "btn-primary wizard-footer-btn", "Сохранить");
    root.appendChild(saveBtn);

    function renderCouriersList(couriers) {
      couriersList.innerHTML = "";
      if (!couriers.length) {
        couriersList.appendChild(el("div", "modal-list-empty", "Нет действующих курьеров"));
        return;
      }
      couriers.forEach(function (c) {
        var row = el("div", "logistics-field-row logistics-courier-row");
        row.appendChild(el("div", "logistics-courier-name", escapeHtml(c.name || c.tg_id)));
        var input = document.createElement("input");
        input.type = "number";
        input.inputMode = "numeric";
        input.min = "0";
        input.placeholder = "0";
        input.value = c.shift_pay ? c.shift_pay : "";
        input.dataset.tgId = c.tg_id;
        input.dataset.name = c.name || "";
        row.appendChild(input);
        row.appendChild(el("span", "logistics-field-suffix", "сум"));
        couriersList.appendChild(row);
      });
    }

    function loadForDate(iso) {
      couriersList.innerHTML = "";
      couriersList.appendChild(el("div", "modal-list-empty", "Загрузка…"));
      api("/api/logistics?date=" + encodeURIComponent(isoToRu(iso))).then(function (data) {
        renderCouriersList(data.couriers);
        expenseInput.value = data.delivery_expense ? data.delivery_expense : "";
      }).catch(function (err) {
        couriersList.innerHTML = "";
        toast("Не удалось загрузить расходы: " + err.message);
      });
    }

    function shiftDate(days) {
      var d = new Date(state.logisticsDateISO + "T00:00:00");
      d.setDate(d.getDate() + days);
      var iso = d.toISOString().slice(0, 10);
      state.logisticsDateISO = iso;
      dateInput.value = iso;
      loadForDate(iso);
    }

    dateInput.addEventListener("change", function (e) {
      state.logisticsDateISO = e.target.value;
      loadForDate(e.target.value);
    });
    prevBtn.addEventListener("click", function () { shiftDate(-1); });
    nextBtn.addEventListener("click", function () { shiftDate(1); });

    saveBtn.addEventListener("click", function () {
      saveBtn.disabled = true;
      var shifts = [];
      Array.prototype.forEach.call(couriersList.querySelectorAll("input[type=number]"), function (input) {
        shifts.push({ tg_id: input.dataset.tgId, name: input.dataset.name, amount: parseInt(input.value, 10) || 0 });
      });
      var deliveryExpense = parseInt(expenseInput.value, 10) || 0;
      api("/api/logistics", {
        method: "POST",
        body: { date: isoToRu(state.logisticsDateISO), shifts: shifts, delivery_expense: deliveryExpense },
      }).then(function () {
        toast("Расходы сохранены");
      }).catch(function (err) {
        toast("Не удалось сохранить: " + err.message);
      }).then(function () {
        saveBtn.disabled = false;
      });
    });

    loadForDate(state.logisticsDateISO);
  }

  // -------------------------------------------------------------------
  // Полноэкранный визард — подразделы Профиля (тот же каркас, что и в
  // PAUSE App, см. pauseapp_static/app.js: openWizard/wizardStep)
  // -------------------------------------------------------------------

  var wizardStack = [];

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
    document.getElementById("wizard-body").innerHTML = "";
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

  // Открывает содержимое одного раздела профиля в визарде — loaderFn
  // получает контейнер, куда дорисовывает сам раздел.
  function openProfileSubscreen(title, loaderFn) {
    openWizard(function (body) {
      body.appendChild(el("h2", "wizard-title", title));
      var sub = el("div");
      body.appendChild(sub);
      loaderFn(sub);
    });
  }

  // -------------------------------------------------------------------
  // "Центр управления" (isRouteAdmin) — хаб с "Видимость маршрутов" и
  // "Расходы на логистику", тот же паттерн хаба, что "Операционный
  // центр" в PAUSE App (отдельные шаги того же wizard-стека).
  // -------------------------------------------------------------------

  var ICON_HUB = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" width="20" height="20"><rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/></svg>';
  var ICON_EYE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" width="20" height="20"><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="3"/></svg>';
  var ICON_WALLET = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" width="20" height="20"><rect x="3" y="6" width="18" height="13" rx="2.5"/><path d="M3 10h18"/><circle cx="16.5" cy="14" r="1.1" fill="currentColor" stroke="none"/></svg>';
  var ICON_COURIERS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" width="20" height="20" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="3"/><path d="M2.5 19c0.8-3.6 2.8-5.4 5.5-5.4s4.7 1.8 5.5 5.4"/><circle cx="17" cy="8" r="2.4"/><path d="M14.8 13.8c0.6-0.3 1.3-0.5 2.2-0.5 2.3 0 3.9 1.5 4.5 4.4"/></svg>';
  var ICON_CHEVRON_RIGHT = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M9 6l6 6-6 6"/></svg>';

  function buildProfileRow(icon, label, onClick) {
    var row = el("div", "profile-nav-row");
    row.innerHTML =
      '<span class="profile-nav-row-icon">' + icon + '</span>' +
      '<span class="profile-nav-row-label">' + escapeHtml(label) + '</span>' +
      '<span class="profile-nav-row-chevron">' + ICON_CHEVRON_RIGHT + '</span>';
    row.addEventListener("click", function () { haptic("select"); onClick(); });
    return row;
  }

  function renderRouteOpsHub(root) {
    root.innerHTML = "";
    var rows = el("div", "card profile-nav-list");
    rows.appendChild(buildProfileRow(ICON_EYE, "Видимость маршрутов", function () {
      wizardStep(function (body) {
        body.appendChild(el("h2", "wizard-title", "Видимость маршрутов"));
        var sub = el("div");
        body.appendChild(sub);
        loadVisibilityScreen(sub);
      });
    }));
    rows.appendChild(buildProfileRow(ICON_WALLET, "Расходы на логистику", function () {
      wizardStep(function (body) {
        body.appendChild(el("h2", "wizard-title", "Расходы на логистику"));
        var sub = el("div");
        body.appendChild(sub);
        renderLogisticsScreen(sub);
      });
    }));
    rows.appendChild(buildProfileRow(ICON_COURIERS, "Курьеры", function () {
      wizardStep(function (body) {
        body.appendChild(el("h2", "wizard-title", "Курьеры"));
        var sub = el("div");
        body.appendChild(sub);
        loadCouriersManageScreen(sub);
      });
    }));
    root.appendChild(rows);
  }

  // -------------------------------------------------------------------
  // "Курьеры" (isRouteAdmin) — справочник курьеров: добавление по
  // Telegram ID + имени (вместо ручной правки листа "Курьеры" в Google
  // Таблице), список уже добавленных, карточка с фото/телефоном и
  // кнопками "Написать"/"Позвонить" (см. webapp.py: api_couriers_manage_*,
  // sheets.add_courier/get_couriers).
  // -------------------------------------------------------------------

  var ICON_COURIER_MESSAGE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" width="18" height="18" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M4 7l8 6 8-6"/></svg>';
  var ICON_COURIER_CALL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" width="18" height="18" stroke-linecap="round" stroke-linejoin="round"><path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4c0 1.1-0.9 2-2 2C9.6 21 3 14.4 3 6c0-1.1 0.9-2 2-2z"/></svg>';

  // Телефон хранится как ввёл админ (нет единого формата, в отличие от
  // профиля клиента в PAUSE App) — для tel: достаточно выдрать только
  // цифры и ведущий "+", остальное (пробелы, скобки, дефисы) tel: не
  // мешает.
  function courierTelHref(phone) {
    var digits = (phone || "").replace(/[^\d+]/g, "");
    return digits ? "tel:" + digits : "";
  }

  function buildCourierAvatar(tgId, name) {
    var wrap = el("div", "ops-card-avatar");
    var img = document.createElement("img");
    img.alt = "";
    wrap.appendChild(img);
    fetchAuthedImageBlobUrl("/miniapp/api/avatar/" + encodeURIComponent(tgId))
      .then(function (blobUrl) { img.src = blobUrl; })
      .catch(function () {
        wrap.innerHTML = "";
        wrap.textContent = initials(name);
      });
    return wrap;
  }

  function loadCouriersManageScreen(root) {
    function load() {
      root.innerHTML = "";
      root.appendChild(el("div", "skeleton-block"));
      api("/api/couriers/manage").then(function (data) {
        render(data.couriers || []);
      }).catch(function (err) {
        root.innerHTML = "";
        root.appendChild(el("div", "empty-note", "Не удалось загрузить список: " + err.message));
      });
    }

    function render(couriers) {
      root.innerHTML = "";

      // --- добавить курьера ---
      var addBox = el("div", "ops-input-box ops-input-box-comment");
      var addRow = el("div", "ops-select-row");
      var idField = el("div", "field");
      idField.innerHTML = "<label>Telegram ID</label>";
      var idInput = document.createElement("input");
      idInput.type = "text";
      idInput.inputMode = "numeric";
      idInput.placeholder = "111222333";
      idField.appendChild(idInput);
      var nameField = el("div", "field");
      nameField.innerHTML = "<label>Имя</label>";
      var nameInput = document.createElement("input");
      nameInput.type = "text";
      nameInput.placeholder = "Имя курьера";
      nameField.appendChild(nameInput);
      addRow.appendChild(idField);
      addRow.appendChild(nameField);
      addBox.appendChild(addRow);

      var phoneField = el("div", "field");
      phoneField.innerHTML = "<label>Телефон (необязательно)</label>";
      var phoneInput = document.createElement("input");
      phoneInput.type = "tel";
      phoneInput.placeholder = "+998 90 123 45 67";
      phoneField.appendChild(phoneInput);
      addBox.appendChild(phoneField);

      var addBtn = el("button", "btn-ghost", "Добавить курьера");
      addBtn.addEventListener("click", function () {
        var tgId = idInput.value.trim();
        var name = nameInput.value.trim();
        if (!tgId || !/^-?\d+$/.test(tgId)) { toast("Введите Telegram ID числом"); return; }
        if (!name) { toast("Введите имя курьера"); return; }
        addBtn.disabled = true;
        api("/api/couriers/manage", { method: "POST", body: { tg_id: tgId, name: name, phone: phoneInput.value.trim() } })
          .then(function () { haptic("success"); toast("Курьер добавлен"); load(); })
          .catch(function (err) { addBtn.disabled = false; toast("Не удалось добавить: " + err.message); });
      });
      addBox.appendChild(addBtn);
      root.appendChild(addBox);

      // --- уже добавлены ---
      root.appendChild(el("h3", "ops-section-title", "Уже добавлены"));
      if (!couriers.length) {
        root.appendChild(el("div", "empty-note", "Пока ни одного курьера не добавлено."));
        return;
      }
      var card = el("div", "card");
      couriers.forEach(function (c, idx) {
        var row = el("div", "ops-breakdown-row" + (idx ? " ops-breakdown-row-sep" : ""));
        row.innerHTML = '<div class="ops-breakdown-name">' + escapeHtml(c.name || c.tg_id) + "</div>";
        row.addEventListener("click", function () {
          haptic("select");
          wizardStep(function (body) {
            body.appendChild(el("h2", "wizard-title", c.name || c.tg_id));
            renderCourierDetail(body, c);
          });
        });
        card.appendChild(row);
      });
      root.appendChild(card);
    }

    load();
  }

  function renderCourierDetail(root, courier) {
    var card = el("div", "card");
    var head = el("div", "ops-card-head");
    head.appendChild(buildCourierAvatar(courier.tg_id, courier.name));
    var info = el("div");
    info.innerHTML =
      '<div class="ops-card-name">' + escapeHtml(courier.name || courier.tg_id) + "</div>" +
      (courier.phone ? '<div class="ops-card-line">' + escapeHtml(courier.phone) + "</div>" : "");
    head.appendChild(info);
    card.appendChild(head);

    var actionsRow = el("div", "ops-contact-actions");
    var writeBtn = el("button", "ops-contact-btn ops-contact-btn-primary");
    writeBtn.innerHTML = ICON_COURIER_MESSAGE + "<span>Написать</span>";
    writeBtn.addEventListener("click", function () { window.location.href = "tg://user?id=" + courier.tg_id; });

    // "Позвонить" — обычная <a href="tel:..."> (не программная навигация),
    // как и везде в приложении (см. buildCard: telHref у person) — именно
    // ссылку надёжно подхватывает системный диалер.
    var telHrefVal = courierTelHref(courier.phone);
    var callBtn;
    if (telHrefVal) {
      callBtn = document.createElement("a");
      callBtn.href = telHrefVal;
      callBtn.className = "ops-contact-btn";
    } else {
      callBtn = el("button", "ops-contact-btn");
      callBtn.disabled = true;
      callBtn.title = "Номер телефона не указан";
    }
    callBtn.innerHTML = ICON_COURIER_CALL + "<span>Позвонить</span>";
    actionsRow.appendChild(writeBtn);
    actionsRow.appendChild(callBtn);
    card.appendChild(actionsRow);

    root.appendChild(card);
  }

  // -------------------------------------------------------------------
  // Шапка экрана — своя на каждой вкладке, тот же компонент, что и в
  // PAUSE App (см. pauseapp_static/app.js: screenHeader).
  // -------------------------------------------------------------------

  function screenHeader(containerId, title) {
    var root = document.getElementById(containerId);
    root.innerHTML = "";
    var bar = el("div", "screen-header screen-header-center");
    bar.appendChild(el("div", "screen-header-side screen-header-left"));
    bar.appendChild(el("div", "screen-header-title", escapeHtml(title)));
    bar.appendChild(el("div", "screen-header-side screen-header-right"));
    root.appendChild(bar);
  }

  // -------------------------------------------------------------------
  // Профиль — аватар (фото из Telegram или инициалы, и у курьера, и у
  // админа, по прямой просьбе), имя, роль; дальше — "Режим" (если можно
  // переключать) и либо "Мои доходы" (курьер), либо "Центр управления"
  // (isRouteAdmin).
  // -------------------------------------------------------------------

  function renderProfileScreen() {
    screenHeader("profile-header", "Профиль");
    var root = document.getElementById("profile-root");
    root.innerHTML = "";

    var head = el("div", "profile-head");
    var photo = tgPhotoUrl();
    var name = tgDisplayName();
    if (photo) {
      var img = el("img", "avatar");
      img.src = photo;
      head.appendChild(img);
    } else {
      head.appendChild(el("div", "avatar", initials(name)));
    }
    head.appendChild(el("div", "profile-name", escapeHtml(name || "Без имени")));
    head.appendChild(el("div", "profile-role-badge", state.isRouteAdmin ? "Администратор" : "Курьер"));
    root.appendChild(head);

    if (state.canToggleMode) {
      var modeRow = el("div", "feed-filters mode-switch-row");
      var adminBtn = el("button", "filter-chip mode-switch-btn" + (state.role === "admin" ? " active" : ""), "Администратор");
      var courierBtn = el("button", "filter-chip mode-switch-btn" + (state.role === "courier" ? " active" : ""), "Курьер");
      adminBtn.dataset.mode = "admin";
      courierBtn.dataset.mode = "courier";
      [adminBtn, courierBtn].forEach(function (btn) {
        btn.addEventListener("click", function () {
          haptic("select");
          if (btn.dataset.mode === state.role) return;
          setRouteAdminMode(btn.dataset.mode);
        });
      });
      modeRow.appendChild(adminBtn);
      modeRow.appendChild(courierBtn);
      root.appendChild(modeRow);
    }

    var rows = el("div", "card profile-nav-list");
    if (state.isRouteAdmin) {
      rows.appendChild(buildProfileRow(ICON_HUB, "Центр управления", function () {
        openProfileSubscreen("Центр управления", renderRouteOpsHub);
      }));
    } else {
      rows.appendChild(buildProfileRow(ICON_WALLET, "Мои доходы", function () {
        openProfileSubscreen("Мои доходы", renderEarningsStub);
      }));
    }
    root.appendChild(rows);
  }

  // -------------------------------------------------------------------
  // Навигация — нижняя панель, 2 вкладки: "Маршрут" / "Профиль"
  // -------------------------------------------------------------------

  var SCREEN_NAMES = ["route", "profile"];

  function showScreen(name) {
    state.screen = name;
    SCREEN_NAMES.forEach(function (s) {
      document.getElementById("screen-" + s).hidden = s !== name;
    });
    document.getElementById("content").scrollTop = 0;
    Array.prototype.forEach.call(document.querySelectorAll(".nav-item"), function (b) {
      b.classList.toggle("active", b.dataset.screen === name);
    });
    if (name === "route") {
      screenHeader("route-header", "Маршрут");
    } else if (name === "profile") {
      renderProfileScreen();
    }
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
  // Подтверждение действия (диалог "Да / Отмена")
  // -------------------------------------------------------------------

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
  // Инициализация
  // -------------------------------------------------------------------

  function init() {
    initNav();

    document.getElementById("add-point-btn").addEventListener("click", openAddPointModal);
    document.getElementById("add-point-cancel").addEventListener("click", function () {
      document.getElementById("add-point-modal").hidden = true;
    });
    document.getElementById("add-point-modal").addEventListener("click", function (e) {
      if (e.target.id === "add-point-modal") e.target.hidden = true;
    });

    document.getElementById("courier-picker-cancel").addEventListener("click", function () {
      document.getElementById("courier-picker-modal").hidden = true;
    });
    document.getElementById("courier-picker-modal").addEventListener("click", function (e) {
      if (e.target.id === "courier-picker-modal") e.target.hidden = true;
    });

    document.getElementById("confirm-modal-yes").addEventListener("click", function () {
      var cb = confirmCallback;
      hideConfirm();
      if (cb) cb();
    });
    document.getElementById("confirm-modal-no").addEventListener("click", hideConfirm);
    document.getElementById("confirm-modal").addEventListener("click", function (e) {
      if (e.target.id === "confirm-modal") hideConfirm();
    });

    document.getElementById("wizard-back").addEventListener("click", wizardBack);
    document.getElementById("wizard-close").addEventListener("click", closeWizard);

    document.getElementById("retry-btn").addEventListener("click", function () {
      document.getElementById("retry-btn").hidden = true;
      startApp();
    });

    startApp();
  }

  function startApp() {
    document.getElementById("empty-state").hidden = true;
    // Пуш о готовности маршрута (см. webapp._notify_couriers_route_ready)
    // ведёт по ссылке вида /miniapp?date=ДД.ММ.ГГГГ — открываем сразу этот
    // раздел "Маршрут" на нужной дате, а не на дате по умолчанию.
    var deepLinkDate = new URLSearchParams(window.location.search).get("date");
    api("/api/me").then(function (me) {
      state.role = me.role;
      state.tgId = me.tg_id;
      state.splitView = !!me.route_split_view;
      state.isRouteAdmin = !!me.is_route_admin;
      state.canToggleMode = !!me.can_toggle_mode;
      showScreen("route");
      loadRouteDates();
      if (state.role === "admin") loadCouriers();
      return loadRoute(deepLinkDate || undefined);
    }).catch(function (err) {
      // 401/403 — реально не тот человек (не курьер и не админ), кнопка
      // "Повторить" тут не поможет. Всё остальное (503 и т.п.) — временная
      // проблема связи с сервером, а не запрет доступа — и стоит дать
      // попробовать ещё раз, не отправляя человека переоткрывать Telegram.
      if (err.status === 401 || err.status === 403) {
        showLoadError("Этот экран доступен только зарегистрированным курьерам и админу.");
      } else {
        toast("Временная проблема связи с сервером");
        showLoadError("Не получилось загрузить маршрут — временная проблема с сервером.");
      }
    });
  }

  document.addEventListener("DOMContentLoaded", init);
})();
