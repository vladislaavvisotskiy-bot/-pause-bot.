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
    points: [],
    date: null,       // DD.MM.YYYY — дата маршрута (всегда "сегодня" по активному меню)
    expanded: {},      // point -> bool
    map: null,
    markers: [],
    polyline: null,
    earningsDateISO: null,
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

  function itemsText(items) {
    return items.map(function (i) {
      return i.qty + "× " + i.set;
    }).join(", ");
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
      state.map = L.map("map", { zoomControl: false, attributionControl: false });
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
      }).addTo(state.map);
    }

    state.markers.forEach(function (m) { state.map.removeLayer(m); });
    state.markers = [];
    if (state.polyline) { state.map.removeLayer(state.polyline); state.polyline = null; }

    if (!withCoords.length) {
      state.map.setView([41.311081, 69.240562], 12); // Ташкент, центр — по умолчанию
      return;
    }

    var latlngs = [];
    withCoords.forEach(function (p, idx) {
      var lat = parseFloat(p.lat), lon = parseFloat(p.lon);
      var marker = L.marker([lat, lon], {
        icon: numberedIcon(idx + 1, p.status === "Сдано"),
      }).addTo(state.map);
      marker.bindPopup(p.address || p.point);
      state.markers.push(marker);
      latlngs.push([lat, lon]);
    });

    state.polyline = L.polyline(latlngs, { color: "#2f80ed", weight: 3, opacity: 0.6, dashArray: "6 6" })
      .addTo(state.map);

    if (latlngs.length === 1) {
      state.map.setView(latlngs[0], 15);
    } else {
      state.map.fitBounds(L.latLngBounds(latlngs), { padding: [30, 30] });
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
    card.className = "card" + (point.status === "Сдано" ? " done" : "");
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
    var addr = document.createElement("div");
    addr.className = "card-address";
    addr.textContent = point.address || point.point;
    var sub = document.createElement("div");
    sub.className = "card-sub";
    sub.textContent = totalPeople + (totalPeople === 1 ? " человек" : " человек(а)") + " · " + point.point;
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
        removePoint(point.point);
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
    point.people.forEach(function (p) {
      var pDiv = document.createElement("div");
      pDiv.className = "person";
      var name = document.createElement("div");
      name.className = "person-name";
      name.textContent = p.name;
      var line1 = document.createElement("div");
      line1.className = "person-line";
      line1.textContent = p.contact + " · " + itemsText(p.items);
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
        animation: 150,
        onEnd: onReorder,
      });
    }
  }

  function render() {
    // Раз мы тут — запрос успешно отработал, так что любая ошибка/кнопка
    // "Повторить" от прошлой неудачной попытки больше не актуальна.
    document.getElementById("empty-state-text").textContent = "На сегодня точек с заказами пока нет 🌿";
    document.getElementById("retry-btn").hidden = true;

    document.getElementById("empty-state").hidden = state.points.length > 0;
    document.getElementById("cards").hidden = state.points.length === 0;
    document.getElementById("add-point-btn").hidden = state.role !== "admin";
    renderMap(state.points);
    renderCards();
  }

  // -------------------------------------------------------------------
  // Действия
  // -------------------------------------------------------------------

  function loadRoute() {
    return api("/api/route").then(function (data) {
      state.date = data.date;
      state.points = data.points;
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
      })
      .catch(function (err) {
        // Сохранить не удалось — не оставляем на экране порядок, который
        // существует только в браузере и не записан в таблицу: перезагружаем
        // настоящий порядок с сервера, а не молчим. Это и есть тот самый
        // "откат к исходному состоянию" — он теперь ожидаемый и подписанный,
        // а не выглядит как необъяснимый сбой.
        toast("Не удалось сохранить порядок, показываю сохранённый: " + err.message);
        return loadRoute();
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
    var order = {};
    Array.prototype.forEach.call(container.children, function (card, idx) {
      order[card.dataset.point] = idx + 1;
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
    api("/api/route/remove", { method: "POST", body: { date: state.date, point: point } })
      .then(function () { return loadRoute(); })
      .catch(function (err) { toast("Не удалось убрать точку: " + err.message); });
  }

  function completePoint(point) {
    api("/api/route/complete", { method: "POST", body: { date: state.date, point: point } })
      .then(function () {
        if (tg && tg.HapticFeedback) tg.HapticFeedback.notificationOccurred("success");
        return loadRoute();
      })
      .catch(function (err) { toast("Не удалось отметить: " + err.message); });
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
          api("/api/route/add", { method: "POST", body: { date: state.date, point: p.name } })
            .then(function () { return loadRoute(); })
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
  // Инициализация / навигация
  // -------------------------------------------------------------------

  function showScreen(name) {
    document.getElementById("route-screen").hidden = name !== "route";
    document.getElementById("earnings-screen").hidden = name !== "earnings";
    document.getElementById("header-title").textContent = name === "earnings" ? "💰 Мой заработок" : "🚚 Маршрут";
    document.getElementById("earnings-toggle-btn").textContent = name === "earnings" ? "🚚 Маршрут" : "💰 Заработок";
    if (name === "earnings" && !state.earningsDateISO) {
      loadEarningsToday();
    }
  }

  function init() {
    document.getElementById("add-point-btn").addEventListener("click", openAddPointModal);
    document.getElementById("add-point-cancel").addEventListener("click", function () {
      document.getElementById("add-point-modal").hidden = true;
    });
    document.getElementById("add-point-modal").addEventListener("click", function (e) {
      if (e.target.id === "add-point-modal") e.target.hidden = true;
    });

    var onEarnings = false;
    document.getElementById("earnings-toggle-btn").addEventListener("click", function () {
      onEarnings = !onEarnings;
      showScreen(onEarnings ? "earnings" : "route");
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
    api("/api/me").then(function (me) {
      state.role = me.role;
      state.tgId = me.tg_id;
      document.getElementById("earnings-toggle-btn").hidden = me.role !== "courier";
      return loadRoute();
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
