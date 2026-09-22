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
    screen: "orders",   // "orders" | "profile" — какой раздел сейчас показан (см. showScreen)
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
    earningsDateISO: null,
    couriers: [],       // [{tg_id, name, status}] — только для админа, см. loadCouriers
  };

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

  function numberedIcon(num, done) {
    return L.divIcon({
      className: "",
      html: '<div class="marker-badge' + (done ? " done" : "") + '">' + num + "</div>",
      iconSize: [26, 26],
      iconAnchor: [13, 13],
    });
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
        icon: numberedIcon(idx + 1, p.status === "Сдано"),
      }).addTo(state.map);
      marker.bindPopup(p.address || p.point);
      state.markers.push(marker);
      cursor++;
    });

    if (placedLatLngs.length > 1) {
      // Тонкая приглушённая пунктирная линия — просто ощущение
      // направления пути, а не акцент карты (акцент — сами точки).
      // Цвет — то же значение, что --ink-soft в styles.css (Leaflet не
      // умеет читать CSS-переменные напрямую из JS) — карта снова
      // светлая, тёмно-коричневый на ней хорошо читается.
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

  function statusTag(point, isActive) {
    if (point.status === "Сдано") {
      return '<span class="card-status-tag done">✅ Сдано ' + point.delivered_at + '</span>';
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
    chevron.textContent = "⌄";
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
      courierBtn.className = "ghost-btn route-courier-btn";
      courierBtn.textContent = "🚴 " + (courierNamesFor(point.courier_tg_ids) || "Курьер не назначен");
      courierBtn.addEventListener("click", function (e) {
        e.stopPropagation();
        openCourierPicker(point);
      });
      body.appendChild(courierBtn);
    }

    // "📌 Закрепить" — только админ. Закрепление касается ТОЛЬКО позиции
    // карточки (запрет перетаскивания + автодобавление новых точек её не
    // сдвигает, см. sync_daily_route/add_route_point — они и так всегда
    // дописывают в конец, не трогая существующие строки) — все остальные
    // действия с точкой работают как обычно вне зависимости от этого флага.
    if (state.role === "admin") {
      var pinBtn = document.createElement("button");
      pinBtn.className = "ghost-btn route-pin-btn";
      pinBtn.textContent = point.pinned ? "📌 Открепить" : "📌 Закрепить";
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
    // на "✏️ Изменить", по которой поле снова становится редактируемым;
    // цикл Сохранить→Изменить→Сохранить повторяется одинаково каждый раз.
    // Курьер видит текст отдельным заметным блоком, без редактирования.
    if (state.role === "admin") {
      var commentWrap = document.createElement("div");
      commentWrap.className = "route-comment-edit";
      var commentLabel = document.createElement("div");
      commentLabel.className = "route-comment-label";
      commentLabel.textContent = "💬 Комментарий для курьера";
      var commentInput = document.createElement("textarea");
      commentInput.className = "route-comment-input";
      commentInput.rows = 2;
      commentInput.value = point.courier_comment || "";
      commentInput.addEventListener("click", function (e) { e.stopPropagation(); });
      var commentBtn = document.createElement("button");
      commentBtn.className = "ghost-btn route-comment-save";

      var commentLocked = !!(point.courier_comment && point.courier_comment.trim());
      var setCommentLocked = function (locked) {
        commentLocked = locked;
        commentInput.disabled = locked;
        commentInput.classList.toggle("locked", locked);
        commentBtn.textContent = locked ? "✏️ Изменить" : "Сохранить";
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
      commentBlock.textContent = "💬 " + point.courier_comment;
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
      goBtn.className = "primary-btn";
      goBtn.textContent = "🚀 Поехали";
      goBtn.addEventListener("click", function () { openLink(yandexMapsUrl(point)); });
      var doneBtn = document.createElement("button");
      doneBtn.className = "primary-btn secondary";
      doneBtn.textContent = "✅ Сдано";
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
    var active = state.role === "courier" ? activePointName(state.points) : null;
    state.points.forEach(function (p, idx) {
      container.appendChild(buildCard(p, idx, p.point === active));
    });

    if (state.role === "admin" && window.Sortable && !container._sortable) {
      container._sortable = new Sortable(container, {
        handle: ".drag-handle",
        // Закреплённую карточку саму нельзя взять и потащить (см. "📌
        // Закрепить" на карточке) — filter не даёт Sortable начать
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

    // Пока админ не включил видимость этой даты (см. "Профиль" -> список
    // дат) — курьер вместо карты/карточек видит только это сообщение.
    // Админ этим не ограничен — он должен видеть маршрут всегда, чтобы
    // как раз его и подготовить перед тем, как включить видимость.
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

    // "На сегодня" только если реально смотрим на активную дату — на любой
    // другой выбранной дате пустой список означает просто "на эту дату
    // заказов пока нет", а не что-то сломалось.
    document.getElementById("empty-state-text").textContent =
      state.date === state.activeDate
        ? "На сегодня точек с заказами пока нет 🌿"
        : "На эту дату заказов пока нет 🌿";

    document.getElementById("empty-state").hidden = state.points.length > 0;
    document.getElementById("cards").hidden = state.points.length === 0;
    renderMap(state.points);
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

  function dateLabel(d) {
    // Единообразно "ДД.ММ" для всех пилюль без исключений — раньше
    // "Сегодня"/"Завтра"/"Вчера" словами для одних дат и числами для
    // других визуально путало (смешанный формат в одном ряду).
    return d.slice(0, 5);
  }

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
    var pinnedPoints = state.points.filter(function (p) { return p.pinned; }).map(function (p) { return p.point; });
    if (pinnedPoints.length) {
      var movedWithoutPinned = domOrder.filter(function (name) { return pinnedPoints.indexOf(name) === -1; });
      var originalOrder = state.points.map(function (p) { return p.point; });
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

    var order = {};
    domOrder.forEach(function (point, idx) {
      order[point] = idx + 1;
    });

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
        if (tg && tg.HapticFeedback) tg.HapticFeedback.notificationOccurred("success");
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
  // Заработок (только курьер)
  // -------------------------------------------------------------------

  function loadEarningsToday() {
    return api("/api/earnings").then(function (data) {
      state.earningsDateISO = ruToIso(data.date);
      document.getElementById("earnings-today").textContent = fmtSum(data.total);
      document.getElementById("earnings-date").value = state.earningsDateISO;
      loadEarningsForDate(state.earningsDateISO);
    }).catch(function (err) { toast(err.message); });
  }

  function loadEarningsForDate(iso) {
    var ru = isoToRu(iso);
    document.getElementById("earnings-day-label").textContent = "За " + ru;
    api("/api/earnings?date=" + encodeURIComponent(ru)).then(function (data) {
      document.getElementById("earnings-day").textContent = fmtSum(data.total);
    }).catch(function (err) { toast(err.message); });

    var parts = iso.split("-");
    var year = parseInt(parts[0], 10), month = parseInt(parts[1], 10);
    var monthNames = ["январь","февраль","март","апрель","май","июнь","июль","август","сентябрь","октябрь","ноябрь","декабрь"];
    document.getElementById("earnings-month-label").textContent = "За " + monthNames[month - 1] + " " + year;
    api("/api/earnings/month?year=" + year + "&month=" + month).then(function (data) {
      document.getElementById("earnings-month").textContent = fmtSum(data.total);
    }).catch(function (err) { toast(err.message); });
  }

  function shiftEarningsDate(days) {
    var d = new Date(state.earningsDateISO + "T00:00:00");
    d.setDate(d.getDate() + days);
    var iso = d.toISOString().slice(0, 10);
    state.earningsDateISO = iso;
    document.getElementById("earnings-date").value = iso;
    loadEarningsForDate(iso);
  }

  // -------------------------------------------------------------------
  // Видимость маршрута для курьера, по датам (только админ, экран "Профиль")
  // -------------------------------------------------------------------

  function renderVisibilityList(dates) {
    var container = document.getElementById("visibility-list");
    container.innerHTML = "";
    if (!dates.length) {
      container.innerHTML = "<div class=\"modal-list-empty\">Пока нет доступных дат</div>";
      return;
    }
    dates.forEach(function (d) {
      var row = document.createElement("div");
      row.className = "visibility-row";

      var label = document.createElement("div");
      label.className = "visibility-row-label";
      label.textContent = dateLabel(d.date) + (d.date === state.activeDate ? " · сегодня" : "");

      var switchLabel = document.createElement("label");
      switchLabel.className = "switch";
      var input = document.createElement("input");
      input.type = "checkbox";
      input.checked = d.visible;
      var slider = document.createElement("span");
      slider.className = "switch-slider";
      switchLabel.appendChild(input);
      switchLabel.appendChild(slider);

      input.addEventListener("change", function () {
        setRouteVisibility(d.date, input.checked, input);
      });

      row.appendChild(label);
      row.appendChild(switchLabel);
      container.appendChild(row);
    });
  }

  function loadVisibilityList() {
    return api("/api/route/visibility").then(function (data) {
      renderVisibilityList(data.dates);
    }).catch(function (err) {
      toast("Не удалось загрузить список дат: " + err.message);
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
  // Инициализация / навигация
  // -------------------------------------------------------------------

  // Разделы: "orders" ("Заказы") — маршрут, общий для обеих ролей.
  // "profile" ("Профиль") — для курьера это "Мой заработок", для админа —
  // список дат с переключателями видимости маршрута (см. renderVisibilityList).
  function showScreen(name) {
    state.screen = name;
    var isProfile = name === "profile";
    var isAdmin = state.role === "admin";

    document.getElementById("route-screen").hidden = isProfile;
    document.getElementById("earnings-screen").hidden = !isProfile || isAdmin;
    document.getElementById("admin-profile-screen").hidden = !isProfile || !isAdmin;

    var title = "Маршрут";
    if (isProfile) title = isAdmin ? "Профиль" : "Мой заработок";
    document.getElementById("header-title").textContent = title;

    Array.prototype.forEach.call(document.querySelectorAll(".nav-drawer-item"), function (el) {
      el.classList.toggle("active", el.dataset.screen === name);
    });

    if (isProfile && isAdmin) {
      loadVisibilityList();
    } else if (isProfile && !isAdmin && !state.earningsDateISO) {
      loadEarningsToday();
    }
  }

  function openDrawer() {
    document.getElementById("nav-drawer").classList.add("open");
    document.getElementById("nav-drawer-backdrop").classList.add("open");
  }

  function closeDrawer() {
    document.getElementById("nav-drawer").classList.remove("open");
    document.getElementById("nav-drawer-backdrop").classList.remove("open");
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

  function init() {
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

    document.getElementById("avatar-btn").addEventListener("click", openDrawer);
    document.getElementById("nav-drawer-backdrop").addEventListener("click", closeDrawer);
    Array.prototype.forEach.call(document.querySelectorAll(".nav-drawer-item"), function (el) {
      el.addEventListener("click", function () {
        showScreen(el.dataset.screen);
        closeDrawer();
      });
    });

    document.getElementById("earnings-date").addEventListener("change", function (e) {
      state.earningsDateISO = e.target.value;
      loadEarningsForDate(e.target.value);
    });
    document.getElementById("earnings-prev-day").addEventListener("click", function () { shiftEarningsDate(-1); });
    document.getElementById("earnings-next-day").addEventListener("click", function () { shiftEarningsDate(1); });

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
    // раздел "Заказы" на нужной дате, а не на дате по умолчанию.
    var deepLinkDate = new URLSearchParams(window.location.search).get("date");
    api("/api/me").then(function (me) {
      state.role = me.role;
      state.tgId = me.tg_id;
      showScreen("orders");
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
