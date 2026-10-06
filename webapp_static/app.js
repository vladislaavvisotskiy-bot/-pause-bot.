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
                          // true и для основного админа бота, и для владельца/назначенных
                          // администраторов Mini App "Маршрут", не меняется при
                          // переключении "Режима" (иначе некому было бы его переключить назад)
    canToggleMode: false, // может ли менять "Режим" ("Администратор"/"Курьер") — только у
                           // админов именно этого Mini App, не у основного админа бота
    isOwner: false,       // config.OWNER_TG_ID — единственный, кто может назначать/снимать
                           // курьеров-администраторов (см. renderCourierDetail)
    logisticsDateISO: null,
    starts: {},          // {courier_tg_id: "ЧЧ:ММ"} — время "Старта" на state.date, см. renderStartBadge
    cash: {},             // {точка: сумма наличных, собранных на ней за state.date}, см. buildCard
    kpiPeriod: "today",   // "today" | "yesterday" | "day2".."day5" | "7d" | "30d" | "custom" — период для шкалы эффективности в Профиле
    kpiCustomFrom: null,  // ISO (YYYY-MM-DD) — для kpiPeriod "custom"
    kpiCustomTo: null,
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
          err.data = data;
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
      // "Сдано" — рядом с названием ещё и время, когда курьер это
      // отметил (p.delivered_at, та же величина, что и в статусе
      // карточки точки, см. buildStatusTag выше), по прямой просьбе —
      // админу нужно видеть это прямо по тапу на точку на карте, не
      // открывая саму точку.
      var popupLabel = p.address || p.point;
      if (p.status === "Сдано" && p.delivered_at) popupLabel += " — Сдано " + p.delivered_at;
      marker.bindPopup(popupLabel);
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

    // "Наличные" — сумма, собранная на этой точке за дату (см.
    // state.cash, заполняется из /api/route: "cash" — см. loadRoute).
    // Отдельной строкой ВНУТРИ main (не ещё одним тегом в head рядом со
    // "Следующая"/"Сдано") — два flex:0 тега в и так тесном head на узком
    // экране выжимали card-address/card-sub почти до нуля ширины и
    // ломали перенос текста; здесь же main сам ограничивает ширину.
    var cashAtPoint = (state.cash && state.cash[point.point]) || 0;
    if (cashAtPoint > 0) {
      var cashLine = document.createElement("div");
      cashLine.className = "card-cash-line";
      cashLine.textContent = "Наличные " + fmtSum(cashAtPoint);
      main.appendChild(cashLine);
    }

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
      if (p.sum) {
        line1.appendChild(document.createTextNode(" · " + fmtSum(p.sum)));
      }
      pDiv.appendChild(name);
      pDiv.appendChild(line1);
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
      goBtn.addEventListener("click", function () { openLink(yandexMapsUrl(point)); recordRouteStart(); });
      var doneBtn = document.createElement("button");
      doneBtn.className = "btn-primary success";
      doneBtn.textContent = "Сдано";
      doneBtn.addEventListener("click", function () { completePoint(point.point); });
      actions.appendChild(goBtn);
      actions.appendChild(doneBtn);
      card.appendChild(actions);
    }

    // "Наличные" — отдельной строкой под основными кнопками, не толкает
    // их (это не "обязательное" действие на каждой точке, в отличие от
    // "Поехали"/"Сдано"). Доступна и у активной, и у УЖЕ СДАННОЙ точки —
    // курьер может записать деньги и после "Сдано". Открывает список людей
    // на точке, см. openCashModal.
    if (state.role === "courier" && (active || point.status === "Сдано")) {
      var cashRow = document.createElement("div");
      cashRow.className = "card-actions-secondary";
      var cashBtn = document.createElement("button");
      cashBtn.className = "btn-ghost cash-btn";
      cashBtn.textContent = "💵 Наличные";
      cashBtn.addEventListener("click", function (e) {
        e.stopPropagation();
        openCashModal(point);
      });
      cashRow.appendChild(cashBtn);
      card.appendChild(cashRow);
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
    renderStartBadge();

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

  // "Старт" — время первого "Поехали" за день у курьера (см.
  // sheets.record_route_start), чисто информационная метка, видна и
  // курьеру (свой старт), и админу (старт выбранного курьера на вкладке,
  // см. ROUTE_SPLIT_VIEW) — на вкладке "Все" показать было бы нечего
  // (старт у каждого свой), поэтому там бейдж просто скрыт.
  function renderStartBadge() {
    var badge = document.getElementById("route-start-badge");
    var relevantTgId = null;
    if (state.role === "courier") {
      relevantTgId = String(state.tgId);
    } else if (state.role === "admin" && state.splitView && state.courierTab !== "all") {
      relevantTgId = state.courierTab;
    }
    var time = relevantTgId ? (state.starts || {})[relevantTgId] : null;
    if (!time) {
      badge.hidden = true;
      return;
    }
    badge.hidden = false;
    badge.textContent = "Старт: " + time;
  }

  function _nowHHMM() {
    var d = new Date();
    return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
  }

  // Отправляется при каждом клике "Поехали" — сервер сам игнорирует
  // повторные за тот же день (см. sheets.record_route_start), поэтому
  // здесь не нужно проверять, был ли уже старт, вызываем всегда. Не
  // блокирует открытие карты (см. buildCard: вызывается следом за
  // openLink, не вместо него) — курьеру не нужно ждать ответа сервера,
  // чтобы поехать.
  function recordRouteStart() {
    var date = state.date;
    api("/api/route/start", { method: "POST", body: { date: date } })
      .then(function () {
        state.starts = state.starts || {};
        var key = String(state.tgId);
        if (!state.starts[key]) {
          state.starts[key] = _nowHHMM();
          renderStartBadge();
        }
      })
      .catch(function () {
        // Не критично — просто бейдж не обновится прямо сейчас, подтянется
        // актуальным при следующей загрузке маршрута (см. loadRoute).
      });
  }

  function loadRoute(dateOverride) {
    var url = "/api/route" + (dateOverride ? "?date=" + encodeURIComponent(dateOverride) : "");
    return api(url).then(function (data) {
      state.date = data.date;
      state.points = data.points;
      state.depot = data.depot || null;
      state.visible = data.visible !== false;
      state.starts = data.starts || {};
      state.cash = data.cash || {};
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

  // "Сдано" — оптимистично: точка отмечается и следующая открывается
  // МГНОВЕННО, запрос уходит в фоне. Если сервер отказал — откатываем и
  // говорим об этом. Пока есть неподтверждённые отметки, фоновые
  // перезагрузки маршрута не делаем (иначе старый ответ мог бы на миг
  // "снять" отметку), а после последней — тихо синхронизируемся.
  var pendingComplete = 0;
  function completePoint(pointName) {
    var date = state.date;
    var p = state.points.filter(function (x) { return x.point === pointName; })[0];
    if (!p || p.status === "Сдано") return;
    var prev = { status: p.status, delivered_at: p.delivered_at };
    p.status = "Сдано";
    p.delivered_at = _nowHHMM();
    haptic("success");
    render();
    pendingComplete++;
    api("/api/route/complete", { method: "POST", body: { date: date, point: pointName } })
      .then(function () {
        pendingComplete--;
        if (!pendingComplete) loadRoute(date);
      })
      .catch(function (err) {
        pendingComplete--;
        p.status = prev.status;
        p.delivered_at = prev.delivered_at;
        render();
        toast("Не удалось отметить: " + err.message);
      });
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
  // "Наличные" — курьер отмечает, что получил деньги от конкретного
  // человека на точке (кнопка на карточке, см. buildCard). Модалка в два
  // шага: список людей на точке -> сумма для выбранного.
  // -------------------------------------------------------------------

  function openCashModal(point) {
    renderCashPersonList(point);
    document.getElementById("cash-modal").hidden = false;
  }

  function renderCashPersonList(point) {
    document.getElementById("cash-modal-title").textContent = "Наличные — кто дал?";
    var body = document.getElementById("cash-modal-body");
    body.innerHTML = "";
    if (!point.people.length) {
      body.innerHTML = "<div class=\"modal-list-empty\">На точке нет заказов</div>";
      return;
    }
    var list = document.createElement("div");
    list.className = "modal-list";
    point.people.forEach(function (p) {
      var item = document.createElement("div");
      item.className = "modal-list-item";
      item.innerHTML = escapeHtml(p.name) +
        '<div class="modal-list-item-sub">' + fmtSum(p.sum) + "</div>";
      item.addEventListener("click", function () {
        haptic("select");
        renderCashAmountView(point, p);
      });
      list.appendChild(item);
    });
    body.appendChild(list);
  }

  function renderCashAmountView(point, person) {
    document.getElementById("cash-modal-title").textContent = "Наличные — " + person.name;
    var body = document.getElementById("cash-modal-body");
    body.innerHTML = "";

    var backBtn = document.createElement("button");
    backBtn.className = "btn-text";
    backBtn.textContent = "← Назад к списку";
    backBtn.addEventListener("click", function () { renderCashPersonList(point); });
    body.appendChild(backBtn);

    var field = el("div", "field");
    field.innerHTML = "<label>Сумма, которую дал клиент</label>";
    var input = document.createElement("input");
    input.type = "number";
    input.inputMode = "numeric";
    input.min = "0";
    input.placeholder = "0";
    input.value = person.sum ? person.sum : "";
    field.appendChild(input);
    body.appendChild(field);

    var confirmBtn = el("button", "btn-primary wizard-footer-btn", "Подтвердить");
    confirmBtn.addEventListener("click", function () {
      var amount = parseInt(input.value, 10);
      if (!amount || amount <= 0) { toast("Введите сумму"); return; }
      confirmBtn.disabled = true;
      api("/api/cash", {
        method: "POST",
        body: { date: state.date, point: point.point, client_id: person.client_id, amount: amount },
      }).then(function () {
        haptic("success");
        toast("Записано: " + fmtSum(amount) + " от " + person.name);
        document.getElementById("cash-modal").hidden = true;
        return loadRoute(state.date);
      }).catch(function (err) {
        confirmBtn.disabled = false;
        toast("Не удалось записать: " + err.message);
      });
    });
    body.appendChild(confirmBtn);
  }

  // -------------------------------------------------------------------
  // Касса курьера — "Наличные у курьера"/"Доход курьера"/"Общая сумма у
  // курьера" (по дням), "Забрать наличные" и "Заработок"/"Оплата за
  // смену" (с выбором источника — из уже собранных наличных или
  // отдельно). Карточка курьера в "Курьеры" (админ, см.
  // renderCourierCashCard) и "Мои доходы" (курьер, см.
  // renderMyEarningsCarousel) — один и тот же набор эндпоинтов
  // (/api/courier/cash-*), разное представление: у админа три
  // прямоугольника видны сразу, у курьера — карусель с стрелками.
  //
  // Однодневный "фильтр по датам, как и для маршрутов" — та же пилюля
  // .date-pill, что и у ленты дат на "Маршруте" (см. renderDatePicker/
  // dateLabel), просто со своим набором дат (объединение дней из кассы
  // и заработка, плюс сегодня).
  // -------------------------------------------------------------------

  function buildSingleDayPicker(selectedRu, dates, onSelect) {
    var today = todayRuDate();
    var all = dates.slice();
    if (all.indexOf(today) === -1) all.push(today);
    all.sort(function (a, b) { return ruToIso(b) < ruToIso(a) ? -1 : 1; });
    var row = el("div", "date-pills");
    all.forEach(function (d) {
      var btn = el("button", "date-pill" + (d === selectedRu ? " active" : ""), dateLabel(d));
      btn.addEventListener("click", function () {
        if (d === selectedRu) return;
        haptic("select");
        onSelect(d);
      });
      row.appendChild(btn);
    });
    return row;
  }

  // Лёгкая нижняя шторка поверх текущего экрана (те же классы .modal/
  // .modal-sheet, что и у "cash-modal" на "Маршруте", просто собирается
  // динамически — не привязана к одному фиксированному месту в разметке).
  function openModalSheet(buildFn) {
    var overlay = el("div", "modal");
    var sheet = el("div", "modal-sheet");
    overlay.appendChild(sheet);
    function close() { if (overlay.parentNode) overlay.parentNode.removeChild(overlay); }
    overlay.addEventListener("click", function (e) { if (e.target === overlay) close(); });
    document.body.appendChild(overlay);
    buildFn(sheet, close);
    return close;
  }

  function confirmSheet(title, text, buttons) {
    openModalSheet(function (sheet, close) {
      sheet.appendChild(el("div", "modal-title", title));
      if (text) sheet.appendChild(el("div", "modal-text", text));
      var actions = el("div", "modal-actions");
      buttons.forEach(function (b) {
        var btn = el("button", b.className || "btn-ghost", b.label);
        btn.addEventListener("click", function () {
          close();
          if (b.onClick) b.onClick();
        });
        actions.appendChild(btn);
      });
      sheet.appendChild(actions);
    });
  }

  function cashSummaryUrl(courierTgId, dateRu) {
    var url = "/api/courier/cash-summary";
    var params = [];
    if (dateRu) params.push("date=" + encodeURIComponent(dateRu));
    if (courierTgId) params.push("courier_tg_id=" + encodeURIComponent(courierTgId));
    if (params.length) url += "?" + params.join("&");
    return url;
  }
  function cashByDayUrl(courierTgId) {
    return "/api/courier/cash-by-day" + (courierTgId ? "?courier_tg_id=" + encodeURIComponent(courierTgId) : "");
  }
  function earningsByDayUrl(courierTgId) {
    return "/api/courier/earnings-by-day" + (courierTgId ? "?courier_tg_id=" + encodeURIComponent(courierTgId) : "");
  }

  // "Оплатить курьеру наличными?" — перед сохранением "Заработка"/"Оплаты
  // за смену" спрашивают, откуда платить, ТОЛЬКО если у курьера сейчас
  // реально хватает собранных наличных на эту сумму (по прямой просьбе —
  // раньше спрашивали всегда, даже когда наличных не хватало, и
  // предлагали вариант "из наличных", который сервер всё равно отклонит).
  // Если наличных хватает (>= amount) — показываем, сколько собрано, и
  // даём выбрать; если не хватает — платим "отдельно" сразу, без вопроса.
  //
  // Остаток запрашиваем БЕЗ даты (сервер сам возьмёт свой "сегодня", см.
  // api_courier_cash_summary) — ровно то же "сегодня", которое
  // sheets.pay_courier_shift использует при серверной проверке
  // достаточности наличных (тоже без даты). Раньше здесь передавался
  // todayRuDate() — дата по часам БРАУЗЕРА, которая может на день
  // отличаться от даты сервера (другой часовой пояс на устройстве) — это
  // и давало "0 собранных" при реально собранных наличных.
  function confirmAndPayShift(courierTgId, dateRu, amount, onSaved) {
    api(cashSummaryUrl(courierTgId)).then(function (summary) {
      if (summary.balance_as_of >= amount) {
        confirmSheet(
          "Оплатить курьеру наличными?",
          "Собрано наличными у курьера: " + fmtSum(summary.balance_as_of) + ". Сумма оплаты за смену: " + fmtSum(amount) + ".",
          [
            { label: "Да, из наличных", className: "btn-primary", onClick: function () { doPay(true); } },
            { label: "Оплатить отдельно", className: "btn-ghost", onClick: function () { doPay(false); } },
          ]
        );
      } else {
        doPay(false);
      }
    }).catch(function (err) {
      toast("Не удалось загрузить остаток наличных: " + err.message);
    });

    function doPay(fromCash) {
      api("/api/couriers/manage/" + encodeURIComponent(courierTgId) + "/pay-shift", {
        method: "POST", body: { date: dateRu, amount: amount, from_cash: fromCash },
      }).then(function () {
        haptic("success");
        toast("Оплата сохранена");
        if (onSaved) onSaved();
      }).catch(function (err) {
        if (err.data && err.data.error === "insufficient_cash") {
          toast("Недостаточно наличных у курьера: доступно " + fmtSum(err.data.available));
        } else {
          toast("Не удалось сохранить: " + err.message);
        }
      });
    }
  }

  function openPayShiftScreen(courierTgId, defaultDateRu, onDone) {
    wizardStep(function (body) {
      body.appendChild(el("h2", "wizard-title", "Заработок"));

      var dateField = el("div", "field");
      dateField.innerHTML = "<label>Дата</label>";
      var dateInput = document.createElement("input");
      dateInput.type = "date";
      dateInput.value = ruToIso(defaultDateRu);
      dateField.appendChild(dateInput);
      body.appendChild(dateField);

      var amountField = el("div", "field");
      amountField.innerHTML = "<label>Сумма за смену</label>";
      var amountInput = document.createElement("input");
      amountInput.type = "number";
      amountInput.inputMode = "numeric";
      amountInput.min = "0";
      amountInput.placeholder = "0";
      amountField.appendChild(amountInput);
      body.appendChild(amountField);

      var saveBtn = el("button", "btn-primary wizard-footer-btn", "Сохранить");
      saveBtn.addEventListener("click", function () {
        var amount = parseInt(amountInput.value, 10) || 0;
        if (amount <= 0) { toast("Введите сумму"); return; }
        confirmAndPayShift(courierTgId, isoToRu(dateInput.value), amount, function () {
          onDone();
          wizardBack();
        });
      });
      body.appendChild(saveBtn);
    });
  }

  function openWithdrawCashScreen(courierTgId, onDone) {
    wizardStep(function (body) {
      body.appendChild(el("h2", "wizard-title", "Забрать наличные"));
      var listWrap = el("div");
      body.appendChild(listWrap);
      listWrap.appendChild(el("div", "skeleton-block"));

      var allBtn = el("button", "btn-ghost", "Забрать все наличные");
      allBtn.hidden = true;
      var confirmBtn = el("button", "btn-primary wizard-footer-btn", "Забрать выбранное");
      confirmBtn.hidden = true;

      function doWithdraw(days) {
        confirmBtn.disabled = true;
        allBtn.disabled = true;
        api("/api/couriers/manage/" + encodeURIComponent(courierTgId) + "/withdraw-cash", {
          method: "POST", body: { days: days },
        }).then(function (res) {
          haptic("success");
          toast("Забрано наличных: " + fmtSum(res.total));
          onDone();
          wizardBack();
        }).catch(function (err) {
          confirmBtn.disabled = false;
          allBtn.disabled = false;
          toast("Не удалось: " + err.message);
        });
      }

      api(cashByDayUrl(courierTgId)).then(function (data) {
        listWrap.innerHTML = "";
        var days = (data.days || []).filter(function (d) { return d.remaining > 0; });
        if (!days.length) {
          listWrap.appendChild(el("div", "empty-note", "У курьера сейчас нет наличных на руках."));
          return;
        }
        var card = el("div", "card");
        var checks = [];
        days.forEach(function (d) {
          var row = el("div", "visibility-row");
          row.appendChild(el("div", "visibility-row-label", d.date + " · " + fmtSum(d.remaining)));
          var checkbox = document.createElement("input");
          checkbox.type = "checkbox";
          checkbox.className = "withdraw-checkbox";
          checks.push({ date: d.date, amount: d.remaining, input: checkbox });
          row.appendChild(checkbox);
          card.appendChild(row);
        });
        listWrap.appendChild(card);

        allBtn.hidden = false;
        confirmBtn.hidden = false;
        allBtn.addEventListener("click", function () {
          var dayAmounts = {};
          days.forEach(function (d) { dayAmounts[d.date] = d.remaining; });
          doWithdraw(dayAmounts);
        });
        confirmBtn.addEventListener("click", function () {
          var dayAmounts = {};
          checks.forEach(function (c) { if (c.input.checked) dayAmounts[c.date] = c.amount; });
          if (!Object.keys(dayAmounts).length) { toast("Отметьте хотя бы один день"); return; }
          doWithdraw(dayAmounts);
        });
      }).catch(function (err) {
        listWrap.innerHTML = "";
        listWrap.appendChild(el("div", "empty-note", "Не удалось загрузить: " + err.message));
      });

      body.appendChild(allBtn);
      body.appendChild(confirmBtn);
    });
  }

  // Контакты клиента (ID, имя, телефон, тг) — ТОЛЬКО для админа, по
  // прямой просьбе (см. sheets.get_cash_entries) — те же .cash-entry-*
  // классы, что были у старого списка "Кто дал наличные".
  function renderCashEntries(container, entries) {
    container.innerHTML = "";
    if (!entries.length) {
      container.appendChild(el("div", "modal-list-empty", "Нет записей от клиентов за этот день."));
      return;
    }
    entries.forEach(function (e, idx) {
      var row = el("div", "cash-entry" + (idx ? " cash-entry-sep" : ""));
      var head = el("div", "cash-entry-head");
      var nameParts = [e.client_id, e.name].filter(Boolean).join(" · ");
      head.appendChild(el("div", "cash-entry-name", escapeHtml(nameParts)));
      head.appendChild(el("strong", "cash-entry-amount", fmtSum(e.amount)));
      row.appendChild(head);
      row.appendChild(el("div", "cash-entry-sub", escapeHtml(e.point || "") + " · " + escapeHtml(e.time || "")));

      var contactsRow = el("div", "cash-entry-contacts");
      var tel = telHref(e.contact);
      if (tel) {
        var phoneLink = document.createElement("a");
        phoneLink.href = tel;
        phoneLink.className = "cash-entry-contact-btn";
        phoneLink.textContent = e.contact;
        contactsRow.appendChild(phoneLink);
      }
      if (e.telegram) {
        var username = e.telegram.replace(/^@/, "");
        var tgBtn = el("button", "cash-entry-contact-btn", "@" + escapeHtml(username));
        tgBtn.addEventListener("click", function (ev) {
          ev.stopPropagation();
          window.location.href = "tg://resolve?domain=" + username;
        });
        contactsRow.appendChild(tgBtn);
      }
      if (contactsRow.childNodes.length) row.appendChild(contactsRow);
      container.appendChild(row);
    });
  }

  // Список по дням — общий для "Наличные у курьера" и "Общая сумма у
  // курьера" (идентичный, по прямой просьбе). У админа каждый день можно
  // развернуть — подтягивает контакты клиентов за этот день отдельным
  // запросом (см. api_courier_cash_day_entries), лениво, при первом клике.
  function renderCashDayList(root, courierTgId, days, isAdmin) {
    root.innerHTML = "";
    if (!days.length) {
      root.appendChild(el("div", "empty-note", "Пока нет записей."));
      return;
    }
    var card = el("div", "card");
    days.forEach(function (d, idx) {
      var row = el("div", "cash-day-row" + (idx ? " cash-day-row-sep" : "") + (isAdmin ? " cash-day-row-clickable" : ""));
      var head = el("div", "cash-day-head");
      head.appendChild(el("div", "cash-day-date", d.date));
      head.appendChild(el("strong", "cash-day-remaining", fmtSum(d.remaining)));
      row.appendChild(head);
      row.appendChild(el("div", "cash-day-sub", "Получено от клиентов: " + fmtSum(d.collected)));
      if (d.withdrawn > 0) {
        row.appendChild(el("div", "cash-day-sub", "Забрано администратором: " + fmtSum(d.withdrawn)));
      }

      if (isAdmin) {
        var detailWrap = el("div", "cash-day-detail");
        detailWrap.hidden = true;
        row.appendChild(detailWrap);
        var loaded = false;
        row.addEventListener("click", function (e) {
          if (e.target.closest(".cash-entry-contact-btn")) return;
          haptic("select");
          detailWrap.hidden = !detailWrap.hidden;
          if (!detailWrap.hidden && !loaded) {
            loaded = true;
            detailWrap.innerHTML = '<div class="modal-list-empty">Загрузка…</div>';
            api("/api/courier/cash-day-entries?courier_tg_id=" + encodeURIComponent(courierTgId) + "&date=" + encodeURIComponent(d.date))
              .then(function (data) { renderCashEntries(detailWrap, data.entries || []); })
              .catch(function (err) {
                detailWrap.innerHTML = "";
                detailWrap.appendChild(el("div", "empty-note", "Не удалось загрузить: " + err.message));
              });
          }
        });
      }

      card.appendChild(row);
    });
    root.appendChild(card);
  }

  function openCashDayHistory(courierTgId, isAdmin, title) {
    wizardStep(function (body) {
      body.appendChild(el("h2", "wizard-title", title));
      var listWrap = el("div");
      body.appendChild(listWrap);
      listWrap.appendChild(el("div", "skeleton-block"));
      api(cashByDayUrl(courierTgId)).then(function (data) {
        renderCashDayList(listWrap, courierTgId, data.days || [], isAdmin);
      }).catch(function (err) {
        listWrap.innerHTML = "";
        listWrap.appendChild(el("div", "empty-note", "Не удалось загрузить: " + err.message));
      });
    });
  }

  function openEarningsHistory(courierTgId) {
    wizardStep(function (body) {
      body.appendChild(el("h2", "wizard-title", "Доход курьера"));
      var listWrap = el("div");
      body.appendChild(listWrap);
      listWrap.appendChild(el("div", "skeleton-block"));
      api(earningsByDayUrl(courierTgId)).then(function (data) {
        listWrap.innerHTML = "";
        var days = data.days || [];
        if (!days.length) {
          listWrap.appendChild(el("div", "empty-note", "Пока нет записей."));
          return;
        }
        var card = el("div", "card");
        days.forEach(function (d, idx) {
          var row = el("div", "cash-day-row" + (idx ? " cash-day-row-sep" : ""));
          var head = el("div", "cash-day-head");
          head.appendChild(el("div", "cash-day-date", d.date));
          head.appendChild(el("strong", "cash-day-remaining", fmtSum(d.amount)));
          row.appendChild(head);
          row.appendChild(el("div", "cash-day-sub", d.from_cash ? "Оплачено из наличных клиентов" : "Оплачено отдельно"));
          card.appendChild(row);
        });
        listWrap.appendChild(card);
      }).catch(function (err) {
        listWrap.innerHTML = "";
        listWrap.appendChild(el("div", "empty-note", "Не удалось загрузить: " + err.message));
      });
    });
  }

  // Карточка курьера в "Курьеры" (админ) — заголовок "Общая сумма у
  // курьера" (накопительно по состоянию на выбранный день) + два
  // прямоугольника "Наличные у курьера"/"Доход курьера" ЗА этот день,
  // разным цветом шрифта (по прямой просьбе) — плюс "Забрать наличные" и
  // "Заработок" ниже.
  function renderCourierCashCard(root, courier) {
    var wrap = el("div", "card cash-card");
    var pickerHolder = el("div");
    var boxesHolder = el("div");
    wrap.appendChild(pickerHolder);
    wrap.appendChild(boxesHolder);

    var actionsRow = el("div", "cash-actions-row");
    var withdrawBtn = el("button", "btn-ghost", "Забрать наличные");
    var payBtn = el("button", "btn-ghost", "Заработок");
    actionsRow.appendChild(withdrawBtn);
    actionsRow.appendChild(payBtn);
    wrap.appendChild(actionsRow);
    root.appendChild(wrap);

    var selectedDate = todayRuDate();
    var cashDays = [];
    var earnDays = [];

    function datesUnion() {
      var set = {};
      cashDays.forEach(function (d) { set[d.date] = true; });
      earnDays.forEach(function (d) { set[d.date] = true; });
      return Object.keys(set);
    }

    function renderPicker() {
      pickerHolder.innerHTML = "";
      pickerHolder.appendChild(buildSingleDayPicker(selectedDate, datesUnion(), function (d) {
        selectedDate = d;
        renderPicker();
        loadSummary();
      }));
    }

    function renderBoxes(data) {
      boxesHolder.innerHTML = "";
      var totalBox = el("div", "cash-box cash-box-total");
      totalBox.appendChild(el("div", "cash-box-label", "Общая сумма у курьера"));
      totalBox.appendChild(el("div", "cash-box-value", fmtSum(data.balance_as_of)));
      totalBox.addEventListener("click", function () {
        haptic("select");
        openCashDayHistory(courier.tg_id, true, "Общая сумма у курьера");
      });
      boxesHolder.appendChild(totalBox);

      var pairRow = el("div", "cash-box-pair");
      var cashBox = el("div", "cash-box cash-box-cash");
      cashBox.appendChild(el("div", "cash-box-label", "Наличные у курьера"));
      cashBox.appendChild(el("div", "cash-box-value", fmtSum(data.cash_day)));
      cashBox.addEventListener("click", function () {
        haptic("select");
        openCashDayHistory(courier.tg_id, true, "Наличные у курьера");
      });
      var earnBox = el("div", "cash-box cash-box-earn");
      earnBox.appendChild(el("div", "cash-box-label", "Доход курьера"));
      earnBox.appendChild(el("div", "cash-box-value", fmtSum(data.earned_day)));
      earnBox.addEventListener("click", function () {
        haptic("select");
        openEarningsHistory(courier.tg_id);
      });
      pairRow.appendChild(cashBox);
      pairRow.appendChild(earnBox);
      boxesHolder.appendChild(pairRow);
    }

    function loadSummary() {
      boxesHolder.innerHTML = "";
      boxesHolder.appendChild(el("div", "skeleton-block"));
      api(cashSummaryUrl(courier.tg_id, selectedDate)).then(renderBoxes).catch(function (err) {
        boxesHolder.innerHTML = "";
        boxesHolder.appendChild(el("div", "empty-note", "Не удалось загрузить: " + err.message));
      });
    }

    function loadAll() {
      // Все три запроса параллельно, а не "сначала дни, потом сумма" —
      // сумма за selectedDate не зависит от списков по дням, ждать их
      // перед вторым round-trip незачем (на открытие карточки курьера
      // это лишняя задержка в размер одного запроса к серверу).
      boxesHolder.innerHTML = "";
      boxesHolder.appendChild(el("div", "skeleton-block"));
      Promise.all([
        api(cashByDayUrl(courier.tg_id)),
        api(earningsByDayUrl(courier.tg_id)),
        api(cashSummaryUrl(courier.tg_id, selectedDate)),
      ]).then(function (res) {
        cashDays = res[0].days || [];
        earnDays = res[1].days || [];
        renderPicker();
        renderBoxes(res[2]);
      }).catch(function (err) {
        pickerHolder.innerHTML = "";
        boxesHolder.innerHTML = "";
        boxesHolder.appendChild(el("div", "empty-note", "Не удалось загрузить кассу: " + err.message));
      });
    }

    withdrawBtn.addEventListener("click", function () { openWithdrawCashScreen(courier.tg_id, loadAll); });
    payBtn.addEventListener("click", function () { openPayShiftScreen(courier.tg_id, selectedDate, loadAll); });

    loadAll();
  }

  // "Мои доходы" (курьер) — та же касса, но своя подача, по прямой
  // просьбе: карусель из трёх прямоугольников со стрелками по бокам,
  // вместо сразу всех трёх, как у админа. Без контактов клиентов —
  // курьер видит только свои суммы по дням, см. renderCashDayList(…,
  // isAdmin=false) — строки не разворачиваются.
  var MY_EARNINGS_BOXES = [
    { key: "earned_day", label: "Мой заработок", cls: "cash-box-earn" },
    { key: "cash_day", label: "Наличные от клиентов", cls: "cash-box-cash" },
    { key: "balance_as_of", label: "Общая сумма денег от клиентов", cls: "cash-box-total" },
  ];

  function renderMyEarningsCarousel(root) {
    root.innerHTML = "";
    var pickerHolder = el("div");
    root.appendChild(pickerHolder);

    var carousel = el("div", "cash-carousel");
    var prevBtn = el("button", "icon-btn cash-carousel-arrow", "‹");
    var boxHolder = el("div", "cash-carousel-box-holder");
    var nextBtn = el("button", "icon-btn cash-carousel-arrow", "›");
    carousel.appendChild(prevBtn);
    carousel.appendChild(boxHolder);
    carousel.appendChild(nextBtn);
    root.appendChild(carousel);

    var dotsRow = el("div", "cash-carousel-dots");
    MY_EARNINGS_BOXES.forEach(function () { dotsRow.appendChild(el("span", "cash-carousel-dot")); });
    root.appendChild(dotsRow);

    var selectedDate = todayRuDate();
    var activeIdx = 0;
    var lastData = null;
    var cashDays = [];
    var earnDays = [];

    function datesUnion() {
      var set = {};
      cashDays.forEach(function (d) { set[d.date] = true; });
      earnDays.forEach(function (d) { set[d.date] = true; });
      return Object.keys(set);
    }

    function renderPicker() {
      pickerHolder.innerHTML = "";
      pickerHolder.appendChild(buildSingleDayPicker(selectedDate, datesUnion(), function (d) {
        selectedDate = d;
        renderPicker();
        loadSummary();
      }));
    }

    function renderBox() {
      boxHolder.innerHTML = "";
      if (!lastData) return;
      var spec = MY_EARNINGS_BOXES[activeIdx];
      var box = el("div", "cash-box " + spec.cls);
      box.appendChild(el("div", "cash-box-label", spec.label));
      box.appendChild(el("div", "cash-box-value", fmtSum(lastData[spec.key])));
      box.addEventListener("click", function () {
        haptic("select");
        if (spec.key === "earned_day") openEarningsHistory(null);
        else openCashDayHistory(null, false, spec.label);
      });
      boxHolder.appendChild(box);
      Array.prototype.forEach.call(dotsRow.children, function (dot, idx) {
        dot.classList.toggle("active", idx === activeIdx);
      });
    }

    prevBtn.addEventListener("click", function () {
      haptic("select");
      activeIdx = (activeIdx + MY_EARNINGS_BOXES.length - 1) % MY_EARNINGS_BOXES.length;
      renderBox();
    });
    nextBtn.addEventListener("click", function () {
      haptic("select");
      activeIdx = (activeIdx + 1) % MY_EARNINGS_BOXES.length;
      renderBox();
    });

    function loadSummary() {
      boxHolder.innerHTML = "";
      boxHolder.appendChild(el("div", "skeleton-block"));
      api(cashSummaryUrl(null, selectedDate)).then(function (data) {
        lastData = data;
        renderBox();
      }).catch(function (err) {
        boxHolder.innerHTML = "";
        boxHolder.appendChild(el("div", "empty-note", "Не удалось загрузить: " + err.message));
      });
    }

    // Все три запроса параллельно — см. аналогичный комментарий в
    // renderCourierCashCard.loadAll выше.
    boxHolder.innerHTML = "";
    boxHolder.appendChild(el("div", "skeleton-block"));
    Promise.all([
      api(cashByDayUrl(null)), api(earningsByDayUrl(null)), api(cashSummaryUrl(null, selectedDate)),
    ]).then(function (res) {
      cashDays = res[0].days || [];
      earnDays = res[1].days || [];
      lastData = res[2];
      renderPicker();
      renderBox();
    }).catch(function (err) {
      pickerHolder.innerHTML = "";
      boxHolder.innerHTML = "";
      boxHolder.appendChild(el("div", "empty-note", "Не удалось загрузить доходы: " + err.message));
    });
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
  // "Режим" (Администратор/Курьер) — только у владельца/назначенных
  // администраторов этого Mini App (см. state.canToggleMode), экран "Профиль"
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

    var saveBtn = el("button", "btn-primary wizard-footer-btn", "Сохранить расходы на доставку");
    root.appendChild(saveBtn);

    // "Оплата за смену" — у каждого курьера своя кнопка "Оплатить" (не
    // общий "Сохранить" молча для всех): перед записью всегда спрашивают
    // "Оплатить курьеру наличными?" (см. confirmAndPayShift), по прямой
    // просьбе.
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
        row.appendChild(input);
        row.appendChild(el("span", "logistics-field-suffix", "сум"));
        var payBtn = el("button", "btn-text logistics-pay-btn", "Оплатить");
        payBtn.addEventListener("click", function () {
          var amount = parseInt(input.value, 10) || 0;
          if (amount <= 0) { toast("Введите сумму"); return; }
          confirmAndPayShift(c.tg_id, isoToRu(state.logisticsDateISO), amount, function () {
            loadForDate(state.logisticsDateISO);
          });
        });
        row.appendChild(payBtn);
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
      var deliveryExpense = parseInt(expenseInput.value, 10) || 0;
      api("/api/logistics", {
        method: "POST",
        body: { date: isoToRu(state.logisticsDateISO), delivery_expense: deliveryExpense },
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
  var ICON_CLOCK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" width="20" height="20" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/></svg>';
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
    rows.appendChild(buildProfileRow(ICON_CLOCK, "Время сдачи заказов", function () {
      wizardStep(function (body) {
        body.appendChild(el("h2", "wizard-title", "Время сдачи заказов"));
        var sub = el("div");
        body.appendChild(sub);
        loadDeadlineScreen(sub);
      });
    }));
    root.appendChild(rows);
  }

  // -------------------------------------------------------------------
  // "Время сдачи заказов" (isRouteAdmin) — дедлайн для KPI доставки (см.
  // get_route_kpi ниже). (i) рядом с заголовком — короткое пояснение,
  // что это значит, по прямой просьбе.
  // -------------------------------------------------------------------

  var ICON_INFO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" width="18" height="18" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v5.5"/><circle cx="12" cy="8" r="0.6" fill="currentColor" stroke="none"/></svg>';

  function loadDeadlineScreen(root) {
    root.innerHTML = "";
    root.appendChild(el("div", "skeleton-block"));
    api("/api/route/deadline").then(function (data) {
      root.innerHTML = "";

      var headRow = el("div", "deadline-head-row");
      headRow.appendChild(el("div", "field-label-row", "Дедлайн"));
      var infoBtn = el("button", "header-icon-btn deadline-info-btn", ICON_INFO);
      infoBtn.setAttribute("aria-label", "Что это значит");
      infoBtn.addEventListener("click", function () {
        haptic("select");
        toast("Время, после которого каждая минута считается опозданием и снижает показатель эффективности доставки.");
      });
      headRow.appendChild(infoBtn);
      root.appendChild(headRow);

      var field = el("div", "field");
      var input = document.createElement("input");
      input.type = "time";
      input.value = data.deadline;
      field.appendChild(input);
      root.appendChild(field);

      var saveBtn = el("button", "btn-primary", "Сохранить");
      saveBtn.addEventListener("click", function () {
        if (!input.value) { toast("Укажите время"); return; }
        saveBtn.disabled = true;
        api("/api/route/deadline", { method: "POST", body: { deadline: input.value } })
          .then(function () { haptic("success"); toast("Дедлайн сохранён"); })
          .catch(function (err) { toast("Не удалось сохранить: " + err.message); })
          .then(function () { saveBtn.disabled = false; });
      });
      root.appendChild(saveBtn);
    }).catch(function (err) {
      root.innerHTML = "";
      root.appendChild(el("div", "empty-note", "Не удалось загрузить: " + err.message));
    });
  }

  // -------------------------------------------------------------------
  // KPI доставки — круговая шкала эффективности (см. sheets.get_route_kpi).
  // Геометрия кольца, по зонам:
  //   100-95%  — кольцо целиком замкнуто (без разрыва), зелёное.
  //   94-80%   — разрыв появляется у "12 часов" и растёт по часовой
  //              стрелке (визуально "отсоединяется сверху и сползает
  //              вниз"), жёлтое; к 80% разрыв — четверть кольца (90°).
  //   79-55%   — тот же разрыв продолжает расти, но теперь СИММЕТРИЧНО в
  //              обе стороны от своей середины ("с обеих сторон"),
  //              оранжево-красное; к 55% разрыв — уже половина кольца (180°).
  //   < 55%    — геометрия замирает на состоянии 55%, сплошной красный.
  // -------------------------------------------------------------------

  var KPI_COLORS = { green: "#3f7d4f", yellow: "#c9962b", orange: "#c9672b", red: "#b1442e" };

  function kpiGaugeGeometry(score) {
    if (score === null || score === undefined) {
      return { visibleDeg: 360, rotationDeg: -90, color: "var(--line)", empty: true };
    }
    var gapStart, gapSpan, color;
    if (score >= 95) {
      gapStart = 0; gapSpan = 0; color = KPI_COLORS.green;
    } else if (score >= 80) {
      var t = (95 - score) / 15;
      gapStart = 0; gapSpan = 90 * t; color = KPI_COLORS.yellow;
    } else if (score >= 55) {
      var t2 = (80 - score) / 25;
      gapStart = -45 * t2; gapSpan = 90 + 90 * t2; color = KPI_COLORS.orange;
    } else {
      gapStart = -45; gapSpan = 180; color = KPI_COLORS.red;
    }
    return { visibleDeg: 360 - gapSpan, rotationDeg: -90 + gapStart + gapSpan, color: color };
  }

  var SVG_NS = "http://www.w3.org/2000/svg";

  function buildKpiGauge(score, sizePx, strokeWidth, extraClass) {
    var geo = kpiGaugeGeometry(score);
    var r = (sizePx - strokeWidth) / 2;
    var c = sizePx / 2;
    var circumference = 2 * Math.PI * r;
    var visibleLen = circumference * geo.visibleDeg / 360;

    var wrap = el("div", "kpi-gauge" + (extraClass ? " " + extraClass : ""));
    wrap.style.width = sizePx + "px";
    wrap.style.height = sizePx + "px";

    var svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("width", sizePx);
    svg.setAttribute("height", sizePx);
    svg.setAttribute("viewBox", "0 0 " + sizePx + " " + sizePx);

    var track = document.createElementNS(SVG_NS, "circle");
    track.setAttribute("cx", c); track.setAttribute("cy", c); track.setAttribute("r", r);
    track.setAttribute("fill", "none");
    track.setAttribute("stroke", "var(--line)");
    track.setAttribute("stroke-width", strokeWidth);
    svg.appendChild(track);

    if (geo.visibleDeg > 0) {
      var arc = document.createElementNS(SVG_NS, "circle");
      arc.setAttribute("cx", c); arc.setAttribute("cy", c); arc.setAttribute("r", r);
      arc.setAttribute("fill", "none");
      arc.setAttribute("stroke", geo.color);
      arc.setAttribute("stroke-width", strokeWidth);
      arc.setAttribute("stroke-linecap", "round");
      arc.setAttribute("stroke-dasharray", visibleLen + " " + (circumference - visibleLen));
      arc.setAttribute("transform", "rotate(" + geo.rotationDeg + " " + c + " " + c + ")");
      svg.appendChild(arc);
    }
    wrap.appendChild(svg);

    var label = el("div", "kpi-gauge-label", score == null ? "—" : Math.round(score) + "%");
    label.style.color = score == null ? "var(--ink-soft)" : geo.color;
    wrap.appendChild(label);
    return wrap;
  }

  function todayRuDate() {
    var d = new Date();
    return String(d.getDate()).padStart(2, "0") + "." + String(d.getMonth() + 1).padStart(2, "0") + "." + d.getFullYear();
  }

  function shiftRuDate(ruDate, days) {
    var d = new Date(ruToIso(ruDate) + "T00:00:00");
    d.setDate(d.getDate() + days);
    return isoToRu(d.toISOString().slice(0, 10));
  }

  // Дневные "пилюли" ("Сегодня", "Вчера", потом 4 даты дд.мм) — та же
  // идея, что у ленты дат на "Маршруте" (см. dateLabel), плюс диапазоны
  // "7 дней"/"30 дней"/"Свой период" — все в одном прокручиваемом ряду,
  // по прямой просьбе.
  function kpiDayPeriods() {
    var today = todayRuDate();
    var out = [["today", "Сегодня"], ["yesterday", "Вчера"]];
    for (var i = 2; i <= 5; i++) {
      out.push(["day" + i, dateLabel(shiftRuDate(today, -i))]);
    }
    return out;
  }
  var KPI_RANGE_PERIODS = [["7d", "7 дней"], ["30d", "30 дней"], ["custom", "Свой период"]];

  function kpiRangeForPeriod() {
    var today = todayRuDate();
    if (state.kpiPeriod === "yesterday") {
      var y = shiftRuDate(today, -1);
      return { from: y, to: y };
    }
    var dayMatch = /^day(\d)$/.exec(state.kpiPeriod);
    if (dayMatch) {
      var d = shiftRuDate(today, -parseInt(dayMatch[1], 10));
      return { from: d, to: d };
    }
    if (state.kpiPeriod === "7d") return { from: shiftRuDate(today, -6), to: today };
    if (state.kpiPeriod === "30d") return { from: shiftRuDate(today, -29), to: today };
    if (state.kpiPeriod === "custom" && state.kpiCustomFrom && state.kpiCustomTo) {
      return { from: isoToRu(state.kpiCustomFrom), to: isoToRu(state.kpiCustomTo) };
    }
    return { from: today, to: today };
  }

  function renderKpiSection(container) {
    container.innerHTML = "";
    container.appendChild(el("div", "profile-section-title", "Эффективность доставки"));

    var periodRow = el("div", "feed-filters");
    kpiDayPeriods().concat(KPI_RANGE_PERIODS).forEach(function (p) {
      var chip = el("button", "filter-chip" + (state.kpiPeriod === p[0] ? " active" : ""), p[1]);
      chip.addEventListener("click", function () {
        haptic("select");
        state.kpiPeriod = p[0];
        renderKpiSection(container);
      });
      periodRow.appendChild(chip);
    });
    container.appendChild(periodRow);

    if (state.kpiPeriod === "custom") {
      var rangeRow = el("div", "date-picker-row");
      var fromField = el("div", "field");
      fromField.innerHTML = "<label>С</label>";
      var fromInput = document.createElement("input");
      fromInput.type = "date";
      fromInput.value = state.kpiCustomFrom || ruToIso(todayRuDate());
      fromField.appendChild(fromInput);
      var toField = el("div", "field");
      toField.innerHTML = "<label>По</label>";
      var toInput = document.createElement("input");
      toInput.type = "date";
      toInput.value = state.kpiCustomTo || ruToIso(todayRuDate());
      toField.appendChild(toInput);
      rangeRow.appendChild(fromField);
      rangeRow.appendChild(toField);
      container.appendChild(rangeRow);

      var applyBtn = el("button", "btn-ghost", "Показать");
      applyBtn.addEventListener("click", function () {
        state.kpiCustomFrom = fromInput.value;
        state.kpiCustomTo = toInput.value;
        loadKpi(body);
      });
      container.appendChild(applyBtn);
    }

    var body = el("div", "kpi-body");
    body.appendChild(el("div", "skeleton-block"));
    container.appendChild(body);

    if (state.kpiPeriod !== "custom" || (state.kpiCustomFrom && state.kpiCustomTo)) {
      loadKpi(body);
    }
  }

  function loadKpi(body) {
    var range = kpiRangeForPeriod();
    api("/api/route/kpi?from=" + encodeURIComponent(range.from) + "&to=" + encodeURIComponent(range.to))
      .then(function (data) { renderKpiBody(body, data); })
      .catch(function (err) {
        body.innerHTML = "";
        body.appendChild(el("div", "empty-note", "Не удалось загрузить показатели: " + err.message));
      });
  }

  function openCourierCardByTgId(tgId) {
    // Вызывается прямо с экрана "Профиль" (клик по мини-кружку KPI),
    // где визард ещё НЕ открыт — в отличие от клика по строке в списке
    // "Курьеры" (там визард уже открыт из "Центр управления", и нужен
    // именно wizardStep, чтобы добавить шаг, а не открыть поверх новый).
    api("/api/couriers/manage").then(function (data) {
      var c = (data.couriers || []).filter(function (x) { return x.tg_id === String(tgId); })[0];
      if (!c) { toast("Курьер не найден"); return; }
      openWizard(function (body) {
        body.appendChild(el("h2", "wizard-title", c.name || c.tg_id));
        renderCourierDetail(body, c);
      });
    }).catch(function (err) {
      toast("Не удалось открыть карточку курьера: " + err.message);
    });
  }

  function renderKpiBody(body, data) {
    body.innerHTML = "";
    var visibleCouriers = (data.couriers || []).filter(function (c) { return !c.hidden; });

    var wrap = el("div", "kpi-main-wrap");
    if (visibleCouriers.length) {
      var miniRow = el("div", "kpi-mini-row");
      visibleCouriers.forEach(function (c) {
        var item = el("div", "kpi-mini-item");
        item.appendChild(buildKpiGauge(c.score, 56, 6));
        item.appendChild(el("div", "kpi-mini-name", escapeHtml(c.name || c.tg_id)));
        item.addEventListener("click", function () {
          haptic("select");
          openCourierCardByTgId(c.tg_id);
        });
        miniRow.appendChild(item);
      });
      wrap.appendChild(miniRow);
    }
    var mainGauge = buildKpiGauge(data.overall, 160, 14, "kpi-gauge-main");
    mainGauge.addEventListener("click", function () {
      haptic("select");
      var text = data.avg_delivery_time
        ? "Среднее время сдачи за период: " + data.avg_delivery_time
        : "За этот период ещё нет ни одной сданной точки.";
      toast(text);
    });
    wrap.appendChild(mainGauge);
    body.appendChild(wrap);

    if (data.overall == null) {
      body.appendChild(el("div", "empty-note", "За этот период ещё нет ни одной сданной точки."));
    }
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

  // Компактная строка-переключатель с (i)-пояснением — та же "пилюля"
  // info-кнопки, что и у "Дедлайна" (см. loadDeadlineScreen), просто
  // внутри .visibility-row, чтобы несколько включателей помещались в
  // одну карточку без лишнего воздуха на экране.
  function buildToggleRow(label, infoText, checked, onChange) {
    var row = el("div", "visibility-row");
    var labelWrap = el("div", "visibility-row-label-wrap");
    labelWrap.appendChild(el("div", "visibility-row-label", label));
    if (infoText) {
      var infoBtn = el("button", "header-icon-btn deadline-info-btn", ICON_INFO);
      infoBtn.setAttribute("aria-label", "Что это значит");
      infoBtn.addEventListener("click", function (e) {
        e.stopPropagation();
        haptic("select");
        toast(infoText);
      });
      labelWrap.appendChild(infoBtn);
    }
    row.appendChild(labelWrap);

    var switchLabel = el("label", "switch");
    var input = document.createElement("input");
    input.type = "checkbox";
    input.checked = checked;
    var slider = el("span", "switch-slider");
    switchLabel.appendChild(input);
    switchLabel.appendChild(slider);
    input.addEventListener("change", function () {
      input.disabled = true;
      onChange(input.checked).then(function () {
        input.disabled = false;
      }).catch(function () {
        input.disabled = false;
      });
    });
    row.appendChild(switchLabel);
    return row;
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

      // --- добавить курьера — кнопка всегда сверху, форма скрыта, пока
      // по ней не нажали (раньше поля ввода были видны постоянно, даже
      // когда ничего не добавляют — по прямой просьбе спрятать за
      // кнопкой). btn-primary (сплошной), чтобы цветом явно отличаться
      // от списка курьеров ниже (простые строки, без заливки).
      var addBtn = el("button", "btn-primary", "+ Добавить курьера");
      root.appendChild(addBtn);

      var addBox = el("div", "ops-input-box ops-input-box-comment");
      addBox.hidden = true;
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

      var saveBtn = el("button", "btn-ghost", "Сохранить");
      saveBtn.addEventListener("click", function () {
        var tgId = idInput.value.trim();
        var name = nameInput.value.trim();
        if (!tgId || !/^-?\d+$/.test(tgId)) { toast("Введите Telegram ID числом"); return; }
        if (!name) { toast("Введите имя курьера"); return; }
        saveBtn.disabled = true;
        api("/api/couriers/manage", { method: "POST", body: { tg_id: tgId, name: name, phone: phoneInput.value.trim() } })
          .then(function () { haptic("success"); toast("Курьер добавлен"); load(); })
          .catch(function (err) { saveBtn.disabled = false; toast("Не удалось добавить: " + err.message); });
      });
      addBox.appendChild(saveBtn);
      root.appendChild(addBox);

      addBtn.addEventListener("click", function () {
        addBox.hidden = !addBox.hidden;
        if (!addBox.hidden) idInput.focus();
      });

      // --- уже добавлены ---
      root.appendChild(el("h3", "ops-section-title", "Уже добавлены"));
      if (!couriers.length) {
        root.appendChild(el("div", "empty-note", "Пока ни одного курьера не добавлено."));
        return;
      }
      var card = el("div", "card");
      couriers.forEach(function (c, idx) {
        var row = el("div", "ops-breakdown-row" + (idx ? " ops-breakdown-row-sep" : ""));
        var nameDiv = el("div", "ops-breakdown-name");
        nameDiv.appendChild(document.createTextNode(c.name || c.tg_id));
        row.appendChild(nameDiv);
        // Статус — справа, в конце строки (row уже flex space-between, см.
        // .ops-breakdown-row), отдельным элементом от имени.
        var roleBadge = el("span", "courier-role-badge" + (c.effective_admin ? " admin" : ""), c.effective_admin ? "Админ" : "Курьер");
        row.appendChild(roleBadge);
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
    // Имя курьера уже показано заголовком визарда (wizard-title) — сама
    // карточка больше не повторяет имя/телефон/аватар, по прямой просьбе.
    // Карточка отличается цветом от основного интерфейса (ivory-deep —
    // уже существующий в палитре оттенок, не новый цвет).
    var card = el("div", "card courier-card");

    var actionsRow = el("div", "ops-contact-actions");
    var writeBtn = el("button", "ops-contact-btn");
    writeBtn.innerHTML = ICON_COURIER_MESSAGE;
    writeBtn.setAttribute("aria-label", "Написать курьеру");
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
    callBtn.innerHTML = ICON_COURIER_CALL;
    callBtn.setAttribute("aria-label", "Позвонить курьеру");
    actionsRow.appendChild(writeBtn);
    actionsRow.appendChild(callBtn);
    card.appendChild(actionsRow);

    // Три включателя — компактно, в ОДНОЙ карточке (были 3 отдельные,
    // занимали много места), каждый с (i)-пояснением, как у "Дедлайна".
    card.appendChild(buildToggleRow(
      "Доступ к Mini App Маршрут",
      "Полностью включает или выключает доступ курьера к Mini App «Маршрут». При выключении курьер не может открыть приложение, но его данные не удаляются.",
      !courier.disabled,
      function (checkedNow) {
        var disabled = !checkedNow;
        return api("/api/couriers/manage/" + encodeURIComponent(courier.tg_id) + "/disabled", { method: "POST", body: { disabled: disabled } })
          .then(function () {
            courier.disabled = disabled;
            toast(disabled ? "Доступ к Mini App отключён" : "Доступ к Mini App включён");
          })
          .catch(function (err) {
            toggleRevert(accessInputRef);
            toast("Не удалось изменить: " + err.message);
          });
      }
    ));
    var accessInputRef = card.lastChild.querySelector("input");

    // "Уведомления" — только пуш о готовности маршрута (см. webapp.py:
    // _notify_couriers_route_ready), который уходит, когда админ включает
    // видимость маршрута в "Центр управления" → "Видимость маршрутов".
    // Доступ к самому Mini App не трогает — для этого переключатель выше.
    card.appendChild(buildToggleRow(
      "Уведомления",
      "Присылать ли этому курьеру уведомление, когда администратор открывает ему видимость маршрута. Доступ к самому приложению не меняет — это отдельный переключатель выше.",
      !courier.notify_off,
      function (checkedNow) {
        var off = !checkedNow;
        return api("/api/couriers/manage/" + encodeURIComponent(courier.tg_id) + "/notify-off", { method: "POST", body: { off: off } })
          .then(function () {
            courier.notify_off = off;
            toast(off ? "Уведомления выключены" : "Уведомления включены");
          })
          .catch(function (err) {
            toggleRevert(notifyInputRef);
            toast("Не удалось изменить: " + err.message);
          });
      }
    ));
    var notifyInputRef = card.lastChild.querySelector("input");

    card.appendChild(buildToggleRow(
      "Показывать на главном экране KPI",
      "Показывает или скрывает кружок эффективности этого курьера на главном экране KPI в Профиле. Скрытый курьер продолжает учитываться в общем среднем — скрывается только его собственный кружок.",
      !courier.kpi_hidden,
      function (checkedNow) {
        var hidden = !checkedNow;
        return api("/api/couriers/manage/" + encodeURIComponent(courier.tg_id) + "/kpi-hidden", { method: "POST", body: { hidden: hidden } })
          .then(function () {
            courier.kpi_hidden = hidden;
            toast(hidden ? "Скрыт с главного экрана KPI" : "Снова виден на главном экране KPI");
          })
          .catch(function (err) {
            toggleRevert(kpiInputRef);
            toast("Не удалось изменить: " + err.message);
          });
      }
    ));
    var kpiInputRef = card.lastChild.querySelector("input");

    // "Администратор Маршрута" — назначает/снимает ТОЛЬКО владелец бота
    // (config.OWNER_TG_ID, state.isOwner) — у остальных, даже действующих
    // администраторов "Маршрута", строки совсем нет, по прямой просьбе.
    if (state.isOwner) {
      card.appendChild(buildToggleRow(
        "Администратор Маршрута",
        "Даёт курьеру доступ к «Центру управления» — курьерами, кассой и расходами на логистику, как у главного администратора.",
        !!courier.is_route_admin,
        function (checkedNow) {
          return api("/api/couriers/manage/" + encodeURIComponent(courier.tg_id) + "/route-admin", { method: "POST", body: { is_admin: checkedNow } })
            .then(function () {
              courier.is_route_admin = checkedNow;
              toast(checkedNow ? "Назначен администратором Маршрута" : "Снят с администратора Маршрута");
            })
            .catch(function (err) {
              toggleRevert(adminInputRef);
              toast("Не удалось изменить: " + err.message);
            });
        }
      ));
      var adminInputRef = card.lastChild.querySelector("input");
    }

    root.appendChild(card);

    renderCourierCashCard(root, courier);
  }

  function toggleRevert(input) { input.checked = !input.checked; }

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
        openProfileSubscreen("Мои доходы", function (root) {
          renderMyEarningsCarousel(root);
        });
      }));
    }
    root.appendChild(rows);

    // Шкала эффективности доставки — СРАЗУ под "Центр управления" на самом
    // экране "Профиль" (не отдельный под-экран визарда), по прямой просьбе.
    if (state.isRouteAdmin) {
      var kpiSection = el("div", "kpi-section");
      root.appendChild(kpiSection);
      renderKpiSection(kpiSection);
    }
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

    document.getElementById("cash-modal-cancel").addEventListener("click", function () {
      document.getElementById("cash-modal").hidden = true;
    });
    document.getElementById("cash-modal").addEventListener("click", function (e) {
      if (e.target.id === "cash-modal") e.target.hidden = true;
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
      state.isOwner = !!me.is_owner;
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
