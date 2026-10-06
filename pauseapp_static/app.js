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

  // -------------------------------------------------------------------
  // Язык интерфейса — три языка, хранится на устройстве (localStorage,
  // тот же приём, что и SPLASH_KEY ниже): Mini App открывается в новом
  // WebView-контексте каждый раз, серверу выбор языка не нужен, только
  // самому устройству. I18N-словарь и t() — см. ниже, перед первым
  // экраном, который их использует.
  // -------------------------------------------------------------------
  var LANG_KEY = "pauseapp_lang_v1";
  function getLang() {
    try {
      var saved = localStorage.getItem(LANG_KEY);
      if (saved) return saved;
    } catch (e) {}
    return "ru";
  }
  function setLang(code) {
    try { localStorage.setItem(LANG_KEY, code); } catch (e) {}
    state.lang = code;
  }

  var state = {
    screen: "home",
    lang: getLang(),
    home: null,          // отметка, что главная уже загружалась (использует profile+menu)
    profile: null,       // {registered, name, phone, zone, point, order_count, club, ...}
    menu: null,           // ответ /api/menu
    menuCategory: "all",  // выбранный чип категории на экране Меню
    feed: null,           // список постов ленты PAUSE Club (ответ /api/feed) — общий и для CLUB, и для Послания
    feedFilter: "all",    // "all" | один из config.FEED_POST_TYPES — фильтр экрана CLUB
    leaderboard: null,     // топ-10 клиентов по заказам (ответ /api/club/leaderboard), см. loadClubLeaderboard
    leaderboardExpanded: false, // раскрыты ли места 4-10 под топ-3 (см. renderClubLeaderboard)
    totalClients: 0,       // общее число клиентов из Sheet1 — для карточки "Рейтинг" (renderClubNowCards)
    messagesFilter: "all", // тот же принцип, отдельный фильтр экрана Послания
    favoriteKeys: null,    // null — ещё не грузили; иначе Set(s.key) избранных блюд клиента
    cart: [],              // корзина заказа — переживает закрытие визарда, см. addToCart/syncCartBar
    isMainAdmin: false,    // главный админ бота (config.ADMIN_IDS) — доступ ко всем функциям всегда
    paFinance: false,      // видит "Финансы" в Операционном центре (главному админу — всегда true)
    paDebtors: false,      // видит "Должники" в Операционном центре (главному админу — всегда true)
    paMenu: false,         // видит "Меню" в Операционном центре (главному админу — всегда true)
  };

  // -------------------------------------------------------------------
  // Словарь интерфейса — три языка. Переведён только сам интерфейс
  // (кнопки/заголовки/подсказки/пустые состояния, включая корзину и
  // оформление заказа) — реальный контент, который печатает админ
  // (подпись к меню, посты ленты, послания, названия сетов вроде "Пауза
  // дня.") НЕ переводится автоматически, это чужой текст, а не элемент
  // интерфейса. Узбекский и английский — мой перевод, стоит проверить
  // носителем перед тем, как считать финальным.
  // -------------------------------------------------------------------
  var I18N = {
    ru: {
      "common.currency": "UZS", "common.back": "Назад",
      "nav.home": "Главная", "nav.menu": "Меню", "nav.club": "Pause Club",
      "nav.messages": "Послания", "nav.profile": "Профиль",

      "splash.tagline1": "more than lunch,", "splash.tagline2": "packed with care",
      "splash.start": "Начать",

      "access.deniedTitle": "Доступ ограничен",
      "access.deniedText": "PAUSE App пока открыт только для команды PAUSE.",
      "access.errorTitle": "Небольшая заминка",
      "access.errorText": "Не получилось связаться с сервером — потяните экран вниз или откройте приложение заново.",
      "home.loadError": "Не удалось загрузить данные: {msg}",
      "home.welcomeName": "Добро пожаловать<br>{name}",
      "home.welcome": "Добро пожаловать",
      "home.tagline": "Больше чем еда. Упаковано с Любовью ♡",
      "home.todayMenu": "Сегодняшнее меню",
      "home.todayMenuOpen": "На {date} — открыт приём заказов",
      "home.ordersOpenTitle": "{date} открыт приём заказов", "home.chooseDishes": "Выбрать блюда",
      "home.menuToday": "Меню сегодня",
      "home.cutoffClosed": "Приём заказов на сегодня закрыт",
      "home.cominSoon": "Готовим, скоро опубликуем",
      "home.inMenuToday": "Сегодня в меню",
      "home.qnMenu": "Меню", "home.qnClub": "Pause Club", "home.qnMessages": "Послания", "home.qnProfile": "Профиль",

      "menu.title": "Меню", "menu.sort": "Сортировка", "menu.sortSoon": "Сортировка — скоро добавим",
      "menu.loadErr": "Не получилось загрузить меню — временная проблема связи.",
      "menu.retry": "Повторить",
      "menu.soonTitle": "Меню скоро будет",
      "menu.soonText": "Мы ещё готовим сегодняшнее меню — загляните чуть позже 🌿",
      "menu.hero": "Выбери свою паузу на сегодня",
      "menu.all": "Все",
      "menu.emptyCategory": "В этой категории пока пусто.",
      "menu.from": "от {sum}",
      "menu.withGarnish": "с выбором гарнира",
      "menu.favAdded": "Добавлено в избранное",
      "menu.favRemoved": "Убрано из избранного",
      "menu.favFailed": "Не удалось сохранить: {msg}",
      "menu.garnishNextStep": "Гарнир выбирается на следующем шаге",
      "menu.order": "Заказать",
      "menu.orderUnavailable": "Сейчас недоступно для заказа",
      "menu.orderClosedNote": "Приём заказов на сегодня закрыт",
      "menu.addToCart": "Добавить в заказ",
      "menu.pickGarnishFirst": "Выберите гарнир",
      "menu.addedToCart": "Добавлено в заказ",
      "menu.garnishMixHint": "Можно выбрать один или смешать два — 50/50",
      "menu.garnishMixed": "Смешали: {text}",

      "cart.barLabel": "Позиций: {count}",
      "cart.barButton": "Корзина",
      "cart.title": "Ваша корзина",
      "cart.total": "Итого",
      "cart.checkoutBtn": "Оформить заказ",

      "checkout.title": "Оформление заказа",
      "checkout.deliveryTitle": "Куда доставить",
      "checkout.change": "Изменить",
      "checkout.commentTitle": "Комментарий к заказу",
      "checkout.commentPlaceholder": "Например: можно мне заменить салат, пожалуйста",
      "checkout.commentInfo": "Это комментарии для нашей команды поваров. По возможности будем их учитывать и сделаем всё возможное, чтобы вас порадовать.",
      "checkout.deliveryCommentTitle": "Комментарий к доставке",
      "checkout.deliveryCommentPlaceholder": "Например: позвоните за 5 минут, 3 этаж, офис 12",
      "checkout.deliveryCommentInfo": "Наша команда старается доставлять ваши обеды очень быстро — обычно с 12:00 до 12:30 всё уже развезено. Если у вас есть комментарии к доставке, мы обязательно сделаем всё возможное, чтобы их выполнить.",
      "checkout.paymentTitle": "Оплата",
      "checkout.cash": "Наличные",
      "checkout.card": "Карта",
      "checkout.attachScreenshot": "Прикрепить скрин",
      "checkout.attachLater": "Прикреплю позже",
      "checkout.screenshotAttached": "Скрин приложен ✓",
      "checkout.screenshotDeferredNote": "Пришлёте скрин позже.",
      "checkout.screenshotDeferredUndo": "Прикрепить сейчас",
      "checkout.screenshotStepRequired": "Прикрепите скрин оплаты или нажмите «Прикреплю позже».",
      "checkout.uploading": "Загружаю…",
      "checkout.uploadFailed": "Не удалось загрузить скрин: {msg}",
      "checkout.confirmBtn": "Подтвердить заказ",
      "checkout.sending": "Отправляю…",
      "checkout.needPoint": "Укажите точку доставки",
      "checkout.needPayment": "Выберите способ оплаты",
      "checkout.submitFailed": "Не удалось отправить заказ — проверьте соединение и попробуйте снова.",
      "checkout.newPointNote": "Новая точка — заказ подтвердит координатор",
      "checkout.doneWarm": "Записали, спасибо, что выбрали паузу",
      "checkout.donePendingTitle": "Заказ принят",
      "checkout.donePendingText": "Новая точка — координатор уточнит адрес и подтвердит заказ. Мы напишем, как только всё готово.",
      "checkout.doneBtn": "Готово",
      "care.numberLabel": "Послание № {number} из {total}",
      "care.firstOrder": "Поздравляем с первым заказом! Пусть он будет ещё приятнее с этими пожеланиями от нас 🌿",
      "care.thankYou1": "Спасибо, что сделал паузу.",
      "care.thankYou2": "Ты важен.",

      "club.title": "Pause Club", "club.more": "Ещё", "club.moreSoon": "Скоро добавим",
      "club.hero.subtitle1": "Люди. События. Забота.", "club.hero.subtitle2": "Больше, чем просто еда.",
      "club.hero.toNextLevel": "{left} заказов до следующего уровня",
      "club.hero.topLevel": "Высший статус PAUSE Club",
      "club.tile.events": "Ближайшие события", "club.tile.care": "PAUSE Care",
      "club.nowHeading": "Сейчас в клубе",
      "club.leaderboardTitle": "Рейтинг",
      "club.leaderboardShowMore": "Показать ещё",
      "club.leaderboardShowLess": "Свернуть",
      "club.leaderboardEmpty": "Рейтинг пока пуст — сделайте первый заказ!",
      "club.leaderboardLoadFailed": "Не удалось загрузить рейтинг.",
      "club.lb.subtitle": "Рейтинг по числу заказов", "club.lb.you": "Вы", "club.lb.toTop": "До топ-10 — ещё {n} {orders}", "club.lb.noRank": "Сделайте первый заказ — и вы появитесь в рейтинге", "club.lb.of": "из {n}",
      "club.empty": "Пока здесь тихо — самое время опубликовать первый пост.",
      "club.deleteConfirm": "Удалить этот пост из ленты?",
      "club.deleteYes": "Да, удалить",
      "club.deleted": "Пост удалён",
      "club.deleteFailed": "Не удалось удалить: {msg}",
      "club.compose": "Опубликовать",
      "club.newPost": "Новый пост",
      "club.captionOptional": "Подпись (необязательно)",
      "club.postText": "Текст поста",
      "club.uploadHint": "Нажмите, чтобы выбрать фото (можно несколько)",
      "club.publish": "Опубликовать",
      "club.publishing": "Публикую…",
      "club.needPhoto": "Выберите хотя бы одно фото",
      "club.needText": "Напишите текст поста",
      "club.published": "Опубликовано",
      "club.publishFailed": "Не удалось опубликовать: {msg}",
      "club.loadFailed": "Не удалось загрузить ленту — потяните вниз, чтобы попробовать снова.",
      "feed.type.photo": "Фото", "feed.type.message": "Послание", "feed.type.announcement": "Анонс",
      "feed.type.giveaway": "PAUSE GIFT", "feed.type.news": "Новость",

      "club.giveaway.title": "🤎 PAUSE DAY",
      "club.giveaway.subtitle": "Каждый день дарим один сет PAUSE тому, кого выберет случай.",
      "club.giveaway.poolTitle": "Сегодня в пуле",
      "club.giveaway.poolCount": "Участников сегодня: {count}",
      "club.giveaway.empty": "Пока в пуле никого — оформите заказ и станьте первым 🌿",
      "club.giveaway.joined": "Вы участвуете 🌿",
      "club.giveaway.joinedNote": "Удачи! Итоги подводим каждый день в {time}.",
      "club.giveaway.lockedTitle": "Доступно со статуса «{emoji} {label}»",
      "club.giveaway.lockedNote": "Ещё {left} заказов — и каждый ваш заказ будет попадать в пул автоматически.",
      "club.giveaway.winnerTitle": "🎉 Победитель дня",
      "club.giveaway.winnerNote": "{name} получает сет за наш счёт. Поздравляем!",
      "club.giveaway.noWinner": "Сегодня в пуле никого не было — ждём вас в следующий раз 🌿",
      "club.giveaway.showAll": "Показать всех",
      "club.giveaway.showLess": "Свернуть",
      "club.giveaway.loadFailed": "Не удалось загрузить PAUSE GIFT.",
      "club.gp.eyebrow": "PAUSE DAY · сегодня", "club.gp.countdown": "До розыгрыша", "club.gp.drawAt": "Розыгрыш в {time}", "club.gp.winnerLabel": "Победитель дня",
      "club.gp.youIn": "Вы в пуле", "club.gp.youInNote": "Удачи! Итоги подводим каждый день в {time}.",
      "club.gp.youOut": "Вы пока не в пуле", "club.gp.youOutNote": "Оформите заказ — и вы автоматически попадёте в сегодняшний розыгрыш.",
      "club.gp.locked": "Доступно со статуса «{label}»", "club.gp.lockedNote": "Ещё {left} заказов — и каждый ваш заказ будет попадать в пул автоматически.",
      "club.gp.howTitle": "Как это работает",
      "club.gp.step1": "Заказывайте как обычно", "club.gp.step1d": "Начиная со статуса «{label}» каждый заказ автоматически попадает в сегодняшний пул.",
      "club.gp.step2": "Случайный выбор", "club.gp.step2d": "Каждый день в {time} мы выбираем одного участника случайным образом.",
      "club.gp.step3": "Сет за наш счёт", "club.gp.step3d": "Победитель получает один сет PAUSE в подарок — мы сообщим сами.",
      "club.gp.poolTitle": "Участники сегодня",

      "club.pday.heading": "Дарим эмоции",
      "club.pday.desc": "Каждый день мы дарим один сет PAUSE тому, кого выберет случай. Участвуй просто своими заказами.",
      "club.pday.cta": "Узнать больше",
      "club.pday.participants": "{count} участников",
      "club.pday.countdownStub": "Розыгрыш в 12:00",

      "club.pdayBig.heading": "Большой приз месяца",
      "club.pdayBig.desc": "Раз в месяц разыгрываем что-то по-настоящему ценное — умную колонку, телефон и другие большие подарки. Участвуйте каждым своим заказом.",
      "club.pdayBig.daysStub": "{days} дней",
      "club.pdayBig.comingSoon": "Скоро запустим — следите за обновлениями 🌿",

      "club.top.eyebrow": "PAUSE TOP",
      "club.top.heading": "Герои паузы",
      "club.top.desc": "Рейтинг тех, кто чаще всех выбирает PAUSE — каждый заказ поднимает вас выше. Посмотрите, кто сейчас впереди.",
      "club.top.cta": "Смотреть рейтинг",
      "club.top.peopleCount": "{count} человек",

      "club.moments.eyebrow": "PAUSE MOMENTS",
      "club.moments.heading": "Твоя пауза. Твой момент.",
      "club.moments.desc": "Место, где люди делятся моментами, впечатлениями и мыслями. Делись тем, что хочется сохранить.",
      "club.moments.cta": "Поделиться моментом",
      "club.moments.count": "{count} моментов",
      "mom.justNow": "сейчас", "mom.placeholder": "Что нового?", "mom.addPhoto": "Фото", "mom.publish": "Опубликовать", "mom.publishing": "Публикуем…",
      "mom.published": "Опубликовано", "mom.deleted": "Удалено", "mom.delete": "Удалить", "mom.deleteConfirm": "Удалить этот пост?", "mom.deleteCommentConfirm": "Удалить этот комментарий?",
      "mom.empty": "Здесь пока тихо — станьте первым, кто поделится моментом", "mom.comments": "Комментарии", "mom.noComments": "Комментариев пока нет — напишите первым",
      "mom.commentPh": "Написать комментарий…", "mom.send": "Отправить", "mom.photosMax": "Не больше {n} фото", "mom.registerFirst": "Чтобы публиковать и комментировать, нужно зарегистрироваться как клиент",
      "mom.loadFailed": "Не удалось загрузить",

      "checkout.summaryTitle": "Сверка заказа",
      "checkout.deliveryFeeLabel": "Доставка",
      "checkout.deliveryInfoTitle": "Как считается доставка",
      "checkout.deliveryInfoText": "Стоимость доставки зависит от вашего статуса Pause Club — чем больше заказов вы уже сделали, тем дешевле (а на верхних уровнях — бесплатно). Статус считается автоматически по количеству заказов.",
      "checkout.paymentTicket": "Лепестком",
      "checkout.paymentTicketHint": "Один лепесток = один сет бесплатно",
      "checkout.ticketRemainingTotal": "Итого к оплате",
      "checkout.noTicket": "У вас сейчас нет доступного лепестка.",
      "checkout.ticketSingleSetOnly": "Лепестком можно оплатить только один сет за раз.",
      "checkout.ticketNewPointNotAllowed": "Лепестком нельзя оплатить заказ на новую точку — выберите точку из списка.",

      "bonuses.title": "Бонусы и промокоды",
      "bonuses.ticketName": "Лепесток «PAUSE DAY»",
      "bonuses.ticketAvailable": "Доступен",
      "bonuses.ticketUsed": "Использован",
      "bonuses.ticketWonOn": "Выигран {date}",
      "bonuses.ticketUsedOn": "Использован {date}",
      "bonuses.ticketHint": "Оплатите лепестком любой один сет при следующем заказе — спишем его сами.",
      "bonuses.petalsLabel": "Ваши лепестки", "bonuses.noneLeft": "Выиграйте в PAUSE DAY — и новый лепесток появится здесь.", "bonuses.use": "Использовать",
      "checkout.petalApplied": "Лепесток применён — один сет за наш счёт",
      "notif.new": "новое", "notif.win.title": "Вам достался лепесток", "notif.win.body": "Сегодня в PAUSE DAY выбрали именно вас — спасибо, что вы с нами. Лепесток уже ждёт в разделе «{section}»: им можно оплатить один любой сет.", "notif.win.cta": "Использовать",
      "bonuses.empty": "Пока бонусов нет — победите в «PAUSE DAY», и лепесток появится здесь 🌸",
      "bonuses.loadFailed": "Не удалось загрузить бонусы.",
      "notifications.title": "Уведомления",
      "notifications.empty": "Пока ничего нет — здесь будут появляться важные новости: выигрыши в розыгрыше и обновления PAUSE App.",
      "notifications.loadFailed": "Не удалось загрузить уведомления.",
      "bonuses.notRegistered": "Вы ещё не зарегистрированы. Напишите /start в чате с ботом.",

      "messages.title": "Послания",
      "messages.empty": "Пока никаких посланий нет.",
      "messages.soon1": "Ещё не придумали, что сюда добавить :)", "messages.soon2": "Предложения пишите через",
      "messages.loadFailed": "Не удалось загрузить послания — потяните вниз, чтобы попробовать снова.",

      "profile.title": "Профиль", "profile.settings": "Настройки",
      "profile.loadFailed": "Не удалось загрузить профиль: {msg}",
      "profile.notRegistered": "Вы ещё не зарегистрированы. Наберите /start в чате с ботом, чтобы завести профиль.",
      "profile.noName": "Без имени",
      "profile.toNextLevel": "До статуса «{emoji} {label}» осталось заказов: {left}",
      "profile.topLevel": "Вы уже на высшем уровне PAUSE Club 🎉",
      "profile.clubTitle": "Pause Club",
      "profile.clubOrders": "{range} заказов",
      "profile.clubDelivery": "Доставка",
      "profile.clubGiveaways": "PAUSE GIFT",
      "club.level.guest": "PAUSE Guest.", "club.level.regular": "PAUSE Member.",
      "club.level.circle": "PAUSE Insider.", "club.level.ambassador": "Vip Pause Club.",
      "profile.statOrders": "заказов", "profile.statPromo": "акции", "profile.statPosts": "постов",
      "profile.myOrders": "Мои заказы", "profile.favorites": "Избранное", "profile.notifications": "Уведомления",
      "profile.myMessages": "Мои послания",
      "profile.myMessagesEmpty": "Посланий пока не было — они появляются после каждого заказа.",
      "profile.myMessagesLoadFailed": "Не удалось загрузить послания.",
      "profile.bonuses": "Бонусы и промокоды", "profile.support": "Поддержка",
      "profile.logout": "Выйти",
      "favorites.title": "Избранное",
      "favorites.empty": "Пока пусто — добавляйте блюда через ♡ на карточке в Меню.",
      "favorites.loadFailed": "Не удалось загрузить избранное.",

      "settings.title": "Настройки",
      "settings.editProfile": "Редактировать профиль",
      "settings.deliveryAddress": "Адрес доставки",
      "settings.language": "Язык",
      "settings.deleteProfile": "Удалить профиль",
      "settings.deleteConfirm": "Удалить профиль в PAUSE App? Заявка уйдёт администратору — сам аккаунт бот не удаляет автоматически.",
      "settings.deleteYes": "Да, удалить",
      "settings.deleteSubmitted": "Заявка передана на обработку",
      "settings.deleteFailed": "Не удалось отправить заявку: {msg}",

      "editProfile.title": "Редактировать профиль",
      "editProfile.name": "Имя", "editProfile.phone": "Телефон",
      "editProfile.save": "Сохранить", "editProfile.saved": "Сохранено",
      "editProfile.saveFailed": "Не удалось сохранить: {msg}",
      "editProfile.phoneInvalid": "Введите номер полностью — 9 цифр после +998",

      "address.title": "Адрес доставки",
      "address.locate": "Моё местоположение", "address.locateFail": "Не удалось определить местоположение",
      "address.noResults": "Ничего не найдено — попробуйте иначе или сдвиньте карту", "address.edit": "Изменить адрес и район",
      "address.point": "Точка доставки", "address.setPoint": "Указать адрес", "address.notChosen": "Пока не выбрано",
      "address.save": "Сохранить", "address.saved": "Сохранено",
      "address.pickFirst": "Сначала выберите точку",
      "address.saveFailed": "Не удалось сохранить: {msg}",
      "address.newPoint": "Новая точка", "address.newPointField": "Адрес / название точки",
      "address.newZoneField": "Район", "address.done": "Готово", "address.fillBoth": "Заполните район и точку",
      "address.searchPlaceholder": "Адрес или название места",
      "address.mapHint": "Нажмите на метку — чтобы выбрать место, где уже заказывали, или в любую точку карты — чтобы указать новое",
      "address.mapUnavailable": "Карта сейчас недоступна — проверьте соединение и попробуйте снова.",
      "address.confirmHere": "Мне сюда доставлять",

      "lang.title": "Язык",

      "orders.title": "Мои заказы",
      "orders.empty": "Заказов пока не было.",
      "orders.allPaid": "Ты умничка, у тебя всё оплачено 🤍",
      "orders.reviewing": "На проверке",
      "orders.canceled": "Отменён", "orders.complete": "Завершён", "orders.preparing": "Готовится",
      "orders.paid": "Оплачено", "orders.unpaid": "Не оплачено", "orders.all": "Все",
      "orders.debtTag": " (в долг)",
      "orders.payChecking": "Оплата на проверке",
      "orders.method": "Способ оплаты", "orders.method.card": "Карта", "orders.method.cash": "Наличные", "orders.method.ticket": "Билет", "pay.title": "Оплата за сегодня", "pay.total": "Сумма к оплате", "pay.send": "Отправить оплату", "pay.sent": "Скриншот отправлен. Мы проверим оплату и подтвердим заказ.", "pay.nothing": "Сейчас оплата не требуется.", "orders.setsSum": "Сеты", "orders.pay": "Оплатить {sum}", "orders.payHint": "Выберите дни, за которые хотите оплатить, и прикрепите скриншот оплаты — мы проверим и подтвердим.",
      "orders.delivery": "Доставка", "orders.dlv.paid": "оплачена", "orders.dlv.review": "ждёт подтверждения", "orders.dlv.debt": "в долг", "orders.dlv.unpaid": "не оплачена",
      "orders.cancel": "Отменить",
      "orders.cancelConfirm": "Отменить заказ на {date}?",
      "orders.cancelYes": "Да, отменить",
      "orders.canceledToast": "Заказ отменён",
      "orders.cancelFailed": "Не удалось отменить заказ",
      "orders.cancelTooLate": "Уже поздно для самостоятельной отмены — напишите в поддержку.",
      "orders.cancelCardPending": "Оплата картой уже в обработке — отмена через поддержку.",
      "orders.review": "★ Отзыв",
      "orders.debtLine": "Текущий долг: {sum}",
      "orders.loadFailed": "Не удалось загрузить заказы.",

      "feedback.title": "Отзыв о заказе",
      "feedback.commentPlaceholder": "Комментарий — необязательно",
      "feedback.send": "Отправить",
      "feedback.needSomething": "Поставьте оценку или напишите пару слов",
      "feedback.thanks": "Спасибо, что рассказали 🤎",
      "feedback.sendFailed": "Не получилось отправить: {msg}",

      "notify.title": "Уведомления",
      "notify.morningTitle": "Утреннее напоминание",
      "notify.morningSub": "Тёплое сообщение утром с напоминанием заказать",
      "notify.menuTitle": "О публикации меню",
      "notify.menuSub": "Сообщение, когда на сегодня опубликовано новое меню",
      "notify.on": "Включено", "notify.off": "Отключено",
      "notify.saveFailed": "Не удалось сохранить",
      "notify.loadFailed": "Не удалось загрузить настройки уведомлений.",
      "notify.footnote": "Время рассылок пока общее для всех — своё время для каждого добавим отдельно, если понадобится.",

      "support.title": "Поддержка",
      "support.intro": "С любыми предложениями или проблемами обращайтесь сюда — мы всегда на связи и рады помочь.",
      "support.social": "Соцсети", "support.contacts": "Контакты",
      "support.telegram": "Telegram", "support.instagram": "Instagram", "support.phone": "Телефон",
      "support.founderBlog": "Блог основателя",
    },

    uz: {
      "common.currency": "UZS", "common.back": "Orqaga",
      "nav.home": "Bosh sahifa", "nav.menu": "Menyu", "nav.club": "Pause Club",
      "nav.messages": "Xabarlar", "nav.profile": "Profil",

      "splash.tagline1": "more than lunch,", "splash.tagline2": "packed with care",
      "splash.start": "Boshlash",

      "access.deniedTitle": "Kirish cheklangan",
      "access.deniedText": "PAUSE App hozircha faqat PAUSE jamoasi uchun ochiq.",
      "access.errorTitle": "Kichik uzilish",
      "access.errorText": "Server bilan bog'lanib bo'lmadi — ekranni pastga torting yoki ilovani qayta oching.",
      "home.loadError": "Ma'lumotlarni yuklab bo'lmadi: {msg}",
      "home.welcomeName": "Xush kelibsiz<br>{name}",
      "home.welcome": "Xush kelibsiz",
      "home.tagline": "Shunchaki ovqatdan ko'ra ko'proq. Sevgi bilan qadoqlangan ♡",
      "home.todayMenu": "Bugungi menyu",
      "home.todayMenuOpen": "{date} uchun — buyurtmalar qabul qilinmoqda",
      "home.ordersOpenTitle": "{date} uchun buyurtmalar qabul qilinmoqda", "home.chooseDishes": "Taomlarni tanlash",
      "home.menuToday": "Bugungi menyu",
      "home.cutoffClosed": "Bugungi buyurtmalar qabul qilish yopildi",
      "home.cominSoon": "Tayyorlanmoqda, tez orada e'lon qilamiz",
      "home.inMenuToday": "Bugungi menyuda",
      "home.qnMenu": "Menyu", "home.qnClub": "Pause Club", "home.qnMessages": "Xabarlar", "home.qnProfile": "Profil",

      "menu.title": "Menyu", "menu.sort": "Saralash", "menu.sortSoon": "Saralash — tez orada qo'shamiz",
      "menu.loadErr": "Menyuni yuklab bo'lmadi — vaqtinchalik aloqa muammosi.",
      "menu.retry": "Qayta urinish",
      "menu.soonTitle": "Menyu tez orada",
      "menu.soonText": "Bugungi menyuni hali tayyorlamoqdamiz — birozdan keyin qarang 🌿",
      "menu.hero": "Bugungi pauzangizni tanlang",
      "menu.all": "Barchasi",
      "menu.emptyCategory": "Bu toifada hozircha bo'sh.",
      "menu.from": "{sum} dan",
      "menu.withGarnish": "garnir tanlovi bilan",
      "menu.favAdded": "Sevimlilarga qo'shildi",
      "menu.favRemoved": "Sevimlilardan olib tashlandi",
      "menu.favFailed": "Saqlab bo'lmadi: {msg}",
      "menu.garnishNextStep": "Garnir keyingi bosqichda tanlanadi",
      "menu.order": "Buyurtma berish",
      "menu.orderUnavailable": "Hozircha buyurtma qabul qilinmayapti",
      "menu.orderClosedNote": "Bugungi buyurtmalar qabul qilish yopiq",
      "menu.addToCart": "Buyurtma qo'shish",
      "menu.pickGarnishFirst": "Garnir tanlang",
      "menu.addedToCart": "Buyurtmaga qo'shildi",
      "menu.garnishMixHint": "Bittasini tanlang yoki ikkitasini aralashtiring — 50/50",
      "menu.garnishMixed": "Aralashtirildi: {text}",

      "cart.barLabel": "Pozitsiyalar: {count}",
      "cart.barButton": "Savatcha",
      "cart.title": "Savatchangiz",
      "cart.total": "Jami",
      "cart.checkoutBtn": "Buyurtmani rasmiylashtirish",

      "checkout.title": "Buyurtmani rasmiylashtirish",
      "checkout.deliveryTitle": "Qayerga yetkazish",
      "checkout.change": "O'zgartirish",
      "checkout.commentTitle": "Buyurtmaga izoh",
      "checkout.commentPlaceholder": "Masalan: salatni almashtirib bersangiz",
      "checkout.commentInfo": "Bu bizning oshpazlar jamoasi uchun izohlar. Imkon qadar e'tiborga olamiz va sizni xursand qilish uchun hamma narsani qilamiz.",
      "checkout.deliveryCommentTitle": "Yetkazib berishga izoh",
      "checkout.deliveryCommentPlaceholder": "Masalan: 5 daqiqa oldin qo'ng'iroq qiling, 3-qavat, 12-ofis",
      "checkout.deliveryCommentInfo": "Jamoamiz tushliklaringizni juda tez yetkazishga harakat qiladi — odatda soat 12:00–12:30 gacha hammasi yetkazib bo'lingan bo'ladi. Yetkazib berishga izohingiz bo'lsa, ularni bajarish uchun albatta harakat qilamiz.",
      "checkout.paymentTitle": "To'lov",
      "checkout.cash": "Naqd pul",
      "checkout.card": "Karta",
      "checkout.attachScreenshot": "Skrinshot biriktirish",
      "checkout.attachLater": "Keyinroq yuboraman",
      "checkout.screenshotAttached": "Skrinshot biriktirildi ✓",
      "checkout.screenshotDeferredNote": "Skrinshotni keyinroq yuborasiz.",
      "checkout.screenshotDeferredUndo": "Hozir biriktirish",
      "checkout.screenshotStepRequired": "To'lov skrinshotini biriktiring yoki \"Keyinroq yuboraman\"ni bosing.",
      "checkout.uploading": "Yuklanmoqda…",
      "checkout.uploadFailed": "Skrinshotni yuklab bo'lmadi: {msg}",
      "checkout.confirmBtn": "Buyurtmani tasdiqlash",
      "checkout.sending": "Yuborilmoqda…",
      "checkout.needPoint": "Yetkazib berish nuqtasini ko'rsating",
      "checkout.needPayment": "To'lov usulini tanlang",
      "checkout.submitFailed": "Buyurtmani yuborib bo'lmadi — aloqani tekshirib, qayta urinib ko'ring.",
      "checkout.newPointNote": "Yangi nuqta — buyurtmani koordinator tasdiqlaydi",
      "checkout.doneWarm": "Qabul qildik, pauzani tanlaganingiz uchun rahmat",
      "checkout.donePendingTitle": "Buyurtma qabul qilindi",
      "checkout.donePendingText": "Yangi nuqta — koordinator manzilni aniqlab, buyurtmani tasdiqlaydi. Hammasi tayyor bo'lganda yozamiz.",
      "checkout.doneBtn": "Tayyor",
      "care.numberLabel": "Xabar № {number} / {total}",
      "care.firstOrder": "Birinchi buyurtma bilan tabriklaymiz! Bizning tilaklarimiz bilan u yanada yoqimli bo'lsin 🌿",
      "care.thankYou1": "Pauza qilganingiz uchun rahmat.",
      "care.thankYou2": "Siz muhimsiz.",

      "club.title": "Pause Club", "club.more": "Yana", "club.moreSoon": "Tez orada qo'shamiz",
      "club.hero.subtitle1": "Odamlar. Tadbirlar. G'amxo'rlik.", "club.hero.subtitle2": "Shunchaki ovqatdan ko'proq.",
      "club.hero.toNextLevel": "Keyingi darajagacha {left} ta buyurtma",
      "club.hero.topLevel": "PAUSE Club'ning eng yuqori darajasi",
      "club.tile.events": "Yaqin tadbirlar", "club.tile.care": "PAUSE Care",
      "club.nowHeading": "Hozir klubda",
      "club.leaderboardTitle": "Reyting",
      "club.leaderboardShowMore": "Yana ko'rsatish",
      "club.leaderboardShowLess": "Yig'ish",
      "club.leaderboardEmpty": "Reyting hali bo'sh — birinchi buyurtmani bering!",
      "club.leaderboardLoadFailed": "Reytingni yuklab bo'lmadi.",
      "club.lb.subtitle": "Buyurtmalar soni bo'yicha reyting", "club.lb.you": "Siz", "club.lb.toTop": "Top-10 gacha yana {n} {orders}", "club.lb.noRank": "Birinchi buyurtmani bering — reytingda paydo bo'lasiz", "club.lb.of": "{n} dan",
      "club.empty": "Hozircha bu yerda jimjit — birinchi postni joylash uchun ayni payt.",
      "club.deleteConfirm": "Bu postni lentadan o'chirasizmi?",
      "club.deleteYes": "Ha, o'chirish",
      "club.deleted": "Post o'chirildi",
      "club.deleteFailed": "O'chirib bo'lmadi: {msg}",
      "club.compose": "Joylash",
      "club.newPost": "Yangi post",
      "club.captionOptional": "Izoh (ixtiyoriy)",
      "club.postText": "Post matni",
      "club.uploadHint": "Rasm tanlash uchun bosing (bir nechta bo'lishi mumkin)",
      "club.publish": "Joylash",
      "club.publishing": "Joylanmoqda…",
      "club.needPhoto": "Kamida bitta rasm tanlang",
      "club.needText": "Post matnini yozing",
      "club.published": "Joylandi",
      "club.publishFailed": "Joylab bo'lmadi: {msg}",
      "club.loadFailed": "Lentani yuklab bo'lmadi — qayta urinish uchun pastga torting.",
      "feed.type.photo": "Rasm", "feed.type.message": "Xabar", "feed.type.announcement": "E'lon",
      "feed.type.giveaway": "PAUSE GIFT", "feed.type.news": "Yangilik",

      "club.giveaway.title": "🤎 PAUSE DAY",
      "club.giveaway.subtitle": "Har kuni tasodif tanlagan bitta odamga PAUSE'dan bir set sovg'a qilamiz.",
      "club.giveaway.poolTitle": "Bugungi pul",
      "club.giveaway.poolCount": "Bugun ishtirokchilar: {count}",
      "club.giveaway.empty": "Hozircha pulda hech kim yo'q — buyurtma bering va birinchi bo'ling 🌿",
      "club.giveaway.joined": "Siz ishtirok etmoqdasiz 🌿",
      "club.giveaway.joinedNote": "Omad! Natijalarni har kuni soat {time}da e'lon qilamiz.",
      "club.giveaway.lockedTitle": "«{emoji} {label}» darajasidan boshlab mavjud",
      "club.giveaway.lockedNote": "Yana {left} ta buyurtma — va har bir buyurtmangiz avtomatik pulga tushadi.",
      "club.giveaway.winnerTitle": "🎉 Kunning g'olibi",
      "club.giveaway.winnerNote": "{name} bizning hisobimizdan bir set oladi. Tabriklaymiz!",
      "club.giveaway.noWinner": "Bugun pulda hech kim yo'q edi — keyingi safar sizni kutamiz 🌿",
      "club.giveaway.showAll": "Barchasini ko'rsatish",
      "club.giveaway.showLess": "Yig'ish",
      "club.giveaway.loadFailed": "PAUSE GIFT'ni yuklab bo'lmadi.",
      "club.gp.eyebrow": "PAUSE DAY · bugun", "club.gp.countdown": "Qur'agacha", "club.gp.drawAt": "Qur'a {time} da", "club.gp.winnerLabel": "Kun g'olibi",
      "club.gp.youIn": "Siz pulddasiz", "club.gp.youInNote": "Omad! Natijalarni har kuni soat {time}da e'lon qilamiz.",
      "club.gp.youOut": "Siz hozircha pulda emassiz", "club.gp.youOutNote": "Buyurtma bering — bugungi qur'aga avtomatik tushasiz.",
      "club.gp.locked": "«{label}» darajasidan boshlab mavjud", "club.gp.lockedNote": "Yana {left} ta buyurtma — va har bir buyurtmangiz avtomatik pulga tushadi.",
      "club.gp.howTitle": "Bu qanday ishlaydi",
      "club.gp.step1": "Odatdagidek buyurtma bering", "club.gp.step1d": "«{label}» darajasidan boshlab har bir buyurtma bugungi pulga avtomatik tushadi.",
      "club.gp.step2": "Tasodifiy tanlov", "club.gp.step2d": "Har kuni soat {time}da bitta ishtirokchini tasodifan tanlaymiz.",
      "club.gp.step3": "Set bizdan", "club.gp.step3d": "G'olib bitta PAUSE setini sovg'a qilib oladi — o'zimiz xabar beramiz.",
      "club.gp.poolTitle": "Bugungi ishtirokchilar",

      "club.pday.heading": "His-tuyg'ularni sovg'a qilamiz",
      "club.pday.desc": "Har kuni tasodif tanlagan bitta odamga bitta PAUSE seti sovg'a qilamiz. Shunchaki buyurtma bering.",
      "club.pday.cta": "Batafsil",
      "club.pday.participants": "{count} ishtirokchi",
      "club.pday.countdownStub": "Qur'a 12:00 da",

      "club.pdayBig.heading": "Oyning katta sovg'asi",
      "club.pdayBig.desc": "Oyiga bir marta haqiqatan ham qimmatli narsa — aqlli kolonka, telefon va boshqa katta sovg'alarni o'ynatamiz. Har bir buyurtmangiz bilan ishtirok eting.",
      "club.pdayBig.daysStub": "{days} kun",
      "club.pdayBig.comingSoon": "Tez orada ishga tushamiz — yangiliklarni kuzatib boring 🌿",

      "club.top.eyebrow": "PAUSE TOP",
      "club.top.heading": "Pauza qahramonlari",
      "club.top.desc": "PAUSE'ni eng ko'p tanlaganlar reytingi — har bir buyurtma sizni yuqoriga ko'taradi. Kim yetakchi ekanini ko'ring.",
      "club.top.cta": "Reytingni ko'rish",
      "club.top.peopleCount": "{count} kishi",

      "club.moments.eyebrow": "PAUSE MOMENTS",
      "club.moments.heading": "Sizning pauzangiz. Sizning lahzangiz.",
      "club.moments.desc": "Odamlar bu yerda lahzalar, taassurotlar va fikrlar bilan bo'lishadi. Saqlab qolgingiz kelgan narsani ulashing.",
      "club.moments.cta": "Lahza ulashish",
      "club.moments.count": "{count} lahza",
      "mom.justNow": "hozir", "mom.placeholder": "Yangiliklar nima?", "mom.addPhoto": "Rasm", "mom.publish": "Joylash", "mom.publishing": "Joylanmoqda…",
      "mom.published": "Joylandi", "mom.deleted": "O'chirildi", "mom.delete": "O'chirish", "mom.deleteConfirm": "Bu postni o'chirasizmi?", "mom.deleteCommentConfirm": "Bu izohni o'chirasizmi?",
      "mom.empty": "Bu yerda hozircha jimjit — birinchi bo'lib lahza ulashing", "mom.comments": "Izohlar", "mom.noComments": "Hozircha izohlar yo'q — birinchi bo'lib yozing",
      "mom.commentPh": "Izoh yozing…", "mom.send": "Yuborish", "mom.photosMax": "{n} tadan ko'p rasm bo'lmaydi", "mom.registerFirst": "Joylash va izoh yozish uchun mijoz sifatida ro'yxatdan o'ting",
      "mom.loadFailed": "Yuklab bo'lmadi",

      "checkout.summaryTitle": "Buyurtma tekshiruvi",
      "checkout.deliveryFeeLabel": "Yetkazib berish",
      "checkout.deliveryInfoTitle": "Yetkazib berish qanday hisoblanadi",
      "checkout.deliveryInfoText": "Yetkazib berish narxi sizning Pause Club statusingizga bog'liq — qancha ko'p buyurtma bersangiz, shuncha arzon (yuqori darajalarda — bepul). Status buyurtmalar soniga qarab avtomatik hisoblanadi.",
      "checkout.paymentTicket": "Gulbarg bilan",
      "checkout.paymentTicketHint": "Bir gulbarg = bir set bepul",
      "checkout.ticketRemainingTotal": "To'lash uchun jami",
      "checkout.noTicket": "Hozir sizda mavjud gulbarg yo'q.",
      "checkout.ticketSingleSetOnly": "Gulbarg bilan bir vaqtda faqat bitta set to'lash mumkin.",
      "checkout.ticketNewPointNotAllowed": "Yangi nuqtaga buyurtmani gulbarg bilan to'lab bo'lmaydi — ro'yxatdan nuqta tanlang.",

      "bonuses.title": "Bonus va promokodlar",
      "bonuses.ticketName": "«PAUSE DAY» gulbargi",
      "bonuses.ticketAvailable": "Mavjud",
      "bonuses.ticketUsed": "Ishlatilgan",
      "bonuses.ticketWonOn": "{date} da yutilgan",
      "bonuses.ticketUsedOn": "{date} da ishlatilgan",
      "bonuses.ticketHint": "Keyingi buyurtmada gulbarg bilan istalgan bir setni to'lang — o'zimiz hisoblaymiz.",
      "bonuses.petalsLabel": "Gulbarglaringiz", "bonuses.noneLeft": "PAUSE DAYda yuting — yangi gulbarg shu yerda paydo bo'ladi.", "bonuses.use": "Ishlatish",
      "checkout.petalApplied": "Gulbarg qo'llandi — bitta set bizdan",
      "notif.new": "yangi", "notif.win.title": "Sizga gulbarg tegdi", "notif.win.body": "Bugun PAUSE DAYda aynan siz tanlandingiz — biz bilan ekaningiz uchun rahmat. Gulbarg «{section}» bo'limida kutmoqda: u bilan istalgan bitta setni to'lash mumkin.", "notif.win.cta": "Ishlatish",
      "bonuses.empty": "Hozircha bonuslar yo'q — «PAUSE DAY»da g'alaba qozonsangiz, gulbarg shu yerda paydo bo'ladi 🌸",
      "bonuses.loadFailed": "Bonuslarni yuklab bo'lmadi.",
      "notifications.title": "Bildirishnomalar",
      "notifications.empty": "Hozircha hech narsa yo'q — bu yerda muhim yangiliklar paydo bo'ladi: lotereya yutuqlari va PAUSE App yangilanishlari.",
      "notifications.loadFailed": "Bildirishnomalarni yuklab bo'lmadi.",
      "bonuses.notRegistered": "Siz hali ro'yxatdan o'tmagansiz. Botga /start yozing.",

      "messages.title": "Xabarlar",
      "messages.empty": "Hozircha xabarlar yo'q.",
      "messages.soon1": "Bu yerga nima qo'shishni hali o'ylab topmadik :)", "messages.soon2": "Takliflaringizni quyidagi orqali yozing:",
      "messages.loadFailed": "Xabarlarni yuklab bo'lmadi — qayta urinish uchun pastga torting.",

      "profile.title": "Profil", "profile.settings": "Sozlamalar",
      "profile.loadFailed": "Profilni yuklab bo'lmadi: {msg}",
      "profile.notRegistered": "Siz hali ro'yxatdan o'tmagansiz. Profil ochish uchun botga /start yozing.",
      "profile.noName": "Ismsiz",
      "profile.toNextLevel": "«{emoji} {label}» darajasigacha qolgan buyurtmalar: {left}",
      "profile.topLevel": "Siz allaqachon PAUSE Club eng yuqori darajasidasiz 🎉",
      "profile.clubTitle": "Pause Club",
      "profile.clubOrders": "{range} ta buyurtma",
      "profile.clubDelivery": "Yetkazib berish",
      "profile.clubGiveaways": "PAUSE GIFT",
      "club.level.guest": "PAUSE Guest.", "club.level.regular": "PAUSE Member.",
      "club.level.circle": "PAUSE Insider.", "club.level.ambassador": "Vip Pause Club.",
      "profile.statOrders": "buyurtma", "profile.statPromo": "aksiya", "profile.statPosts": "post",
      "profile.myOrders": "Buyurtmalarim", "profile.favorites": "Sevimlilar", "profile.notifications": "Bildirishnomalar",
      "profile.myMessages": "Xabarlarim",
      "profile.myMessagesEmpty": "Hozircha xabarlar yo'q — ular har bir buyurtmadan keyin paydo bo'ladi.",
      "profile.myMessagesLoadFailed": "Xabarlarni yuklab bo'lmadi.",
      "profile.bonuses": "Bonus va promokodlar", "profile.support": "Yordam",
      "favorites.title": "Sevimlilar",
      "favorites.empty": "Hozircha bo'sh — Menyudagi kartochkada ♡ orqali qo'shing.",
      "favorites.loadFailed": "Sevimlilarni yuklab bo'lmadi.",
      "profile.logout": "Chiqish",

      "settings.title": "Sozlamalar",
      "settings.editProfile": "Profilni tahrirlash",
      "settings.deliveryAddress": "Yetkazib berish manzili",
      "settings.language": "Til",
      "settings.deleteProfile": "Profilni o'chirish",
      "settings.deleteConfirm": "PAUSE App'dagi profilingizni o'chirasizmi? So'rov administratorga yuboriladi — bot hisobni avtomatik o'chirmaydi.",
      "settings.deleteYes": "Ha, o'chirish",
      "settings.deleteSubmitted": "So'rov ko'rib chiqish uchun yuborildi",
      "settings.deleteFailed": "So'rovni yuborib bo'lmadi: {msg}",

      "editProfile.title": "Profilni tahrirlash",
      "editProfile.name": "Ism", "editProfile.phone": "Telefon",
      "editProfile.save": "Saqlash", "editProfile.saved": "Saqlandi",
      "editProfile.saveFailed": "Saqlab bo'lmadi: {msg}",
      "editProfile.phoneInvalid": "Raqamni to'liq kiriting — +998 dan keyin 9 ta raqam",

      "address.title": "Yetkazib berish manzili",
      "address.locate": "Mening joylashuvim", "address.locateFail": "Joylashuvni aniqlab bo'lmadi",
      "address.noResults": "Hech narsa topilmadi — boshqacha yozing yoki xaritani suring", "address.edit": "Manzil va tumanni o'zgartirish",
      "address.point": "Yetkazib berish nuqtasi", "address.setPoint": "Manzilni belgilash", "address.notChosen": "Hozircha tanlanmagan",
      "address.save": "Saqlash", "address.saved": "Saqlandi",
      "address.pickFirst": "Avval nuqtani tanlang",
      "address.saveFailed": "Saqlab bo'lmadi: {msg}",
      "address.newPoint": "Yangi nuqta", "address.newPointField": "Manzil / nuqta nomi",
      "address.newZoneField": "Tuman", "address.done": "Tayyor", "address.fillBoth": "Tuman va nuqtani to'ldiring",
      "address.searchPlaceholder": "Manzil yoki joy nomi",
      "address.mapHint": "Allaqachon buyurtma qilingan joyni tanlash uchun metkaga bosing, yoki yangi joyni belgilash uchun xaritaning istalgan nuqtasiga bosing",
      "address.mapUnavailable": "Xarita hozir mavjud emas — aloqani tekshirib, qayta urinib ko'ring.",
      "address.confirmHere": "Menga shu yerga yetkazib bering",

      "lang.title": "Til",

      "orders.title": "Buyurtmalarim",
      "orders.empty": "Hozircha buyurtmalar bo'lmagan.",
      "orders.allPaid": "Ajoyibsiz, hamma narsa to'langan 🤍",
      "orders.reviewing": "Tekshirilmoqda",
      "orders.canceled": "Bekor qilindi", "orders.complete": "Yakunlandi", "orders.preparing": "Tayyorlanmoqda",
      "orders.paid": "To'langan", "orders.unpaid": "To'lanmagan", "orders.all": "Barchasi",
      "orders.debtTag": " (nasiya)",
      "orders.payChecking": "To'lov tekshirilmoqda",
      "orders.method": "To'lov usuli", "orders.method.card": "Karta", "orders.method.cash": "Naqd", "orders.method.ticket": "Chipta", "pay.title": "Bugungi to'lov", "pay.total": "To'lov summasi", "pay.send": "To'lovni yuborish", "pay.sent": "Skrinshot yuborildi. To'lovni tekshirib, buyurtmani tasdiqlaymiz.", "pay.nothing": "Hozir to'lov talab qilinmaydi.", "orders.setsSum": "Setlar", "orders.pay": "To'lash {sum}", "orders.payHint": "To'lamoqchi bo'lgan kunlarni tanlang va to'lov skrinshotini biriktiring — tekshirib tasdiqlaymiz.",
      "orders.delivery": "Yetkazib berish", "orders.dlv.paid": "to'langan", "orders.dlv.review": "tasdiqlash kutilmoqda", "orders.dlv.debt": "nasiya", "orders.dlv.unpaid": "to'lanmagan",
      "orders.cancel": "Bekor qilish",
      "orders.cancelConfirm": "{date} sanasidagi buyurtmani bekor qilasizmi?",
      "orders.cancelYes": "Ha, bekor qilish",
      "orders.canceledToast": "Buyurtma bekor qilindi",
      "orders.cancelFailed": "Buyurtmani bekor qilib bo'lmadi",
      "orders.cancelTooLate": "Mustaqil bekor qilish uchun juda kech — yordam xizmatiga yozing.",
      "orders.cancelCardPending": "Karta orqali to'lov hali ko'rib chiqilmoqda — bekor qilish yordam xizmati orqali.",
      "orders.review": "★ Sharh",
      "orders.debtLine": "Joriy qarz: {sum}",
      "orders.loadFailed": "Buyurtmalarni yuklab bo'lmadi.",

      "feedback.title": "Buyurtma haqida sharh",
      "feedback.commentPlaceholder": "Izoh — ixtiyoriy",
      "feedback.send": "Yuborish",
      "feedback.needSomething": "Baho qo'ying yoki bir necha so'z yozing",
      "feedback.thanks": "Fikringiz uchun rahmat 🤎",
      "feedback.sendFailed": "Yuborib bo'lmadi: {msg}",

      "notify.title": "Bildirishnomalar",
      "notify.morningTitle": "Ertalabki eslatma",
      "notify.morningSub": "Buyurtma berish haqida ertalabki iliq xabar",
      "notify.menuTitle": "Menyu e'loni haqida",
      "notify.menuSub": "Bugungi yangi menyu e'lon qilinganda xabar",
      "notify.on": "Yoqildi", "notify.off": "O'chirildi",
      "notify.saveFailed": "Saqlab bo'lmadi",
      "notify.loadFailed": "Bildirishnoma sozlamalarini yuklab bo'lmadi.",
      "notify.footnote": "Xabarnomalar vaqti hozircha hamma uchun umumiy — kerak bo'lsa, har bir kishi uchun alohida vaqt qo'shamiz.",

      "support.title": "Yordam",
      "support.intro": "Har qanday taklif yoki muammo bilan shu yerga murojaat qiling — biz doim aloqadamiz va yordam berishdan xursandmiz.",
      "support.social": "Ijtimoiy tarmoqlar", "support.contacts": "Aloqa",
      "support.telegram": "Telegram", "support.instagram": "Instagram", "support.phone": "Telefon",
      "support.founderBlog": "Asoschi blogi",
    },

    en: {
      "common.currency": "UZS", "common.back": "Back",
      "nav.home": "Home", "nav.menu": "Menu", "nav.club": "Pause Club",
      "nav.messages": "Messages", "nav.profile": "Profile",

      "splash.tagline1": "more than lunch,", "splash.tagline2": "packed with care",
      "splash.start": "Start",

      "access.deniedTitle": "Access restricted",
      "access.deniedText": "PAUSE App is currently open only to the PAUSE team.",
      "access.errorTitle": "Small hiccup",
      "access.errorText": "Couldn't reach the server — pull down to refresh or reopen the app.",
      "home.loadError": "Couldn't load data: {msg}",
      "home.welcomeName": "Welcome<br>{name}",
      "home.welcome": "Welcome",
      "home.tagline": "More than food. Packed with Love ♡",
      "home.todayMenu": "Today's menu",
      "home.todayMenuOpen": "For {date} — orders are open",
      "home.ordersOpenTitle": "Orders are open for {date}", "home.chooseDishes": "Choose dishes",
      "home.menuToday": "Today's menu",
      "home.cutoffClosed": "Orders for today are closed",
      "home.cominSoon": "Preparing, publishing soon",
      "home.inMenuToday": "In today's menu",
      "home.qnMenu": "Menu", "home.qnClub": "Pause Club", "home.qnMessages": "Messages", "home.qnProfile": "Profile",

      "menu.title": "Menu", "menu.sort": "Sort", "menu.sortSoon": "Sorting — coming soon",
      "menu.loadErr": "Couldn't load the menu — a temporary connection issue.",
      "menu.retry": "Retry",
      "menu.soonTitle": "Menu coming soon",
      "menu.soonText": "We're still preparing today's menu — check back shortly 🌿",
      "menu.hero": "Choose your pause for today",
      "menu.all": "All",
      "menu.emptyCategory": "Nothing in this category yet.",
      "menu.from": "from {sum}",
      "menu.withGarnish": "with a side choice",
      "menu.favAdded": "Added to favorites",
      "menu.favRemoved": "Removed from favorites",
      "menu.favFailed": "Couldn't save: {msg}",
      "menu.garnishNextStep": "The side is chosen on the next step",
      "menu.order": "Order",
      "menu.orderUnavailable": "Ordering isn't available right now",
      "menu.orderClosedNote": "Orders for today are closed",
      "menu.addToCart": "Add to order",
      "menu.pickGarnishFirst": "Choose a side",
      "menu.addedToCart": "Added to your order",
      "menu.garnishMixHint": "Pick one, or mix two — 50/50",
      "menu.garnishMixed": "Mixed: {text}",

      "cart.barLabel": "Items: {count}",
      "cart.barButton": "Cart",
      "cart.title": "Your cart",
      "cart.total": "Total",
      "cart.checkoutBtn": "Proceed to checkout",

      "checkout.title": "Checkout",
      "checkout.deliveryTitle": "Delivery address",
      "checkout.change": "Change",
      "checkout.commentTitle": "Order comment",
      "checkout.commentPlaceholder": "E.g. could I swap the salad, please",
      "checkout.commentInfo": "These notes are for our team of cooks. We'll take them into account where we can and do our best to please you.",
      "checkout.deliveryCommentTitle": "Delivery comment",
      "checkout.deliveryCommentPlaceholder": "E.g. call 5 minutes ahead, 3rd floor, office 12",
      "checkout.deliveryCommentInfo": "Our team does its best to deliver your lunches very fast — usually everything is delivered between 12:00 and 12:30. If you have delivery comments, we'll do everything we can to follow them.",
      "checkout.paymentTitle": "Payment",
      "checkout.cash": "Cash",
      "checkout.card": "Card",
      "checkout.attachScreenshot": "Attach screenshot",
      "checkout.attachLater": "I'll send it later",
      "checkout.screenshotAttached": "Screenshot attached ✓",
      "checkout.screenshotDeferredNote": "You'll send the screenshot later.",
      "checkout.screenshotDeferredUndo": "Attach now",
      "checkout.screenshotStepRequired": "Attach a payment screenshot or tap \"I'll send it later\".",
      "checkout.uploading": "Uploading…",
      "checkout.uploadFailed": "Couldn't upload the screenshot: {msg}",
      "checkout.confirmBtn": "Confirm order",
      "checkout.sending": "Sending…",
      "checkout.needPoint": "Please set a delivery point",
      "checkout.needPayment": "Please choose a payment method",
      "checkout.submitFailed": "Couldn't send the order — check your connection and try again.",
      "checkout.newPointNote": "New point — the coordinator will confirm the order",
      "checkout.doneWarm": "Got it, thank you for choosing a pause",
      "checkout.donePendingTitle": "Order received",
      "checkout.donePendingText": "New point — the coordinator will confirm the address and the order. We'll let you know once it's ready.",
      "checkout.doneBtn": "Done",
      "care.numberLabel": "Message № {number} of {total}",
      "care.firstOrder": "Congratulations on your first order! May it be even nicer with these wishes from us 🌿",
      "care.thankYou1": "Thank you for taking a pause.",
      "care.thankYou2": "You matter.",

      "club.title": "Pause Club", "club.more": "More", "club.moreSoon": "Coming soon",
      "club.hero.subtitle1": "People. Events. Care.", "club.hero.subtitle2": "More than just food.",
      "club.hero.toNextLevel": "{left} orders to the next level",
      "club.hero.topLevel": "Top PAUSE Club status",
      "club.tile.events": "Upcoming events", "club.tile.care": "PAUSE Care",
      "club.nowHeading": "In the club right now",
      "club.leaderboardTitle": "Leaderboard",
      "club.leaderboardShowMore": "Show more",
      "club.leaderboardShowLess": "Show less",
      "club.leaderboardEmpty": "Leaderboard is empty yet — place your first order!",
      "club.leaderboardLoadFailed": "Couldn't load the leaderboard.",
      "club.lb.subtitle": "Ranked by number of orders", "club.lb.you": "You", "club.lb.toTop": "{n} more {orders} to reach the top 10", "club.lb.noRank": "Place your first order to join the ranking", "club.lb.of": "of {n}",
      "club.empty": "It's quiet here — a great time to publish the first post.",
      "club.deleteConfirm": "Delete this post from the feed?",
      "club.deleteYes": "Yes, delete",
      "club.deleted": "Post deleted",
      "club.deleteFailed": "Couldn't delete: {msg}",
      "club.compose": "Publish",
      "club.newPost": "New post",
      "club.captionOptional": "Caption (optional)",
      "club.postText": "Post text",
      "club.uploadHint": "Tap to choose photos (multiple allowed)",
      "club.publish": "Publish",
      "club.publishing": "Publishing…",
      "club.needPhoto": "Choose at least one photo",
      "club.needText": "Write the post text",
      "club.published": "Published",
      "club.publishFailed": "Couldn't publish: {msg}",
      "club.loadFailed": "Couldn't load the feed — pull down to try again.",
      "feed.type.photo": "Photo", "feed.type.message": "Message", "feed.type.announcement": "Announcement",
      "feed.type.giveaway": "PAUSE GIFT", "feed.type.news": "News",

      "club.giveaway.title": "🤎 PAUSE DAY",
      "club.giveaway.subtitle": "Every day we gift one PAUSE set to someone chosen at random.",
      "club.giveaway.poolTitle": "Today's pool",
      "club.giveaway.poolCount": "In today's pool: {count}",
      "club.giveaway.empty": "Nobody's in the pool yet — place an order and be the first 🌿",
      "club.giveaway.joined": "You're in 🌿",
      "club.giveaway.joinedNote": "Good luck! We draw the winner every day at {time}.",
      "club.giveaway.lockedTitle": "Unlocked from «{emoji} {label}»",
      "club.giveaway.lockedNote": "{left} more orders — and every order after that joins the pool automatically.",
      "club.giveaway.winnerTitle": "🎉 Today's winner",
      "club.giveaway.winnerNote": "{name} gets a set on us. Congratulations!",
      "club.giveaway.noWinner": "Nobody was in the pool today — see you next time 🌿",
      "club.giveaway.showAll": "Show all",
      "club.giveaway.showLess": "Show less",
      "club.giveaway.loadFailed": "Couldn't load PAUSE GIFT.",
      "club.gp.eyebrow": "PAUSE DAY · today", "club.gp.countdown": "Until the draw", "club.gp.drawAt": "Draw at {time}", "club.gp.winnerLabel": "Winner of the day",
      "club.gp.youIn": "You're in the pool", "club.gp.youInNote": "Good luck! We draw the winner every day at {time}.",
      "club.gp.youOut": "You're not in the pool yet", "club.gp.youOutNote": "Place an order and you'll join today's draw automatically.",
      "club.gp.locked": "Unlocked from «{label}»", "club.gp.lockedNote": "{left} more orders — and every order after that joins the pool automatically.",
      "club.gp.howTitle": "How it works",
      "club.gp.step1": "Order as usual", "club.gp.step1d": "From «{label}» status, every order joins today's pool automatically.",
      "club.gp.step2": "A random pick", "club.gp.step2d": "Every day at {time} we pick one participant at random.",
      "club.gp.step3": "A set on us", "club.gp.step3d": "The winner gets one PAUSE set as a gift — we'll let you know.",
      "club.gp.poolTitle": "Today's participants",

      "club.pday.heading": "Gifting good moments",
      "club.pday.desc": "Every day we gift one PAUSE set to someone chosen at random. Just join in with your orders.",
      "club.pday.cta": "Learn more",
      "club.pday.participants": "{count} participants",
      "club.pday.countdownStub": "Draw at 12:00",

      "club.pdayBig.heading": "This month's big prize",
      "club.pdayBig.desc": "Once a month we raffle off something really valuable — a smart speaker, a phone, and other big gifts. Every order of yours counts as an entry.",
      "club.pdayBig.daysStub": "{days} days",
      "club.pdayBig.comingSoon": "Coming soon — stay tuned 🌿",

      "club.top.eyebrow": "PAUSE TOP",
      "club.top.heading": "Pause heroes",
      "club.top.desc": "A ranking of who chooses PAUSE most often — every order moves you up. See who's leading right now.",
      "club.top.cta": "View ranking",
      "club.top.peopleCount": "{count} people",

      "club.moments.eyebrow": "PAUSE MOMENTS",
      "club.moments.heading": "Your pause. Your moment.",
      "club.moments.desc": "A place where people share moments, impressions and thoughts. Share what's worth keeping.",
      "club.moments.cta": "Share a moment",
      "club.moments.count": "{count} moments",
      "mom.justNow": "now", "mom.placeholder": "What's new?", "mom.addPhoto": "Photo", "mom.publish": "Post", "mom.publishing": "Posting…",
      "mom.published": "Posted", "mom.deleted": "Deleted", "mom.delete": "Delete", "mom.deleteConfirm": "Delete this post?", "mom.deleteCommentConfirm": "Delete this comment?",
      "mom.empty": "It's quiet here — be the first to share a moment", "mom.comments": "Comments", "mom.noComments": "No comments yet — be the first",
      "mom.commentPh": "Write a comment…", "mom.send": "Send", "mom.photosMax": "No more than {n} photos", "mom.registerFirst": "Register as a client to post and comment",
      "mom.loadFailed": "Couldn't load",

      "checkout.summaryTitle": "Order summary",
      "checkout.deliveryFeeLabel": "Delivery",
      "checkout.deliveryInfoTitle": "How delivery is calculated",
      "checkout.deliveryInfoText": "Delivery cost depends on your Pause Club status — the more orders you've placed, the cheaper it gets (free at the top tiers). Status is calculated automatically from your order count.",
      "checkout.paymentTicket": "With a petal",
      "checkout.paymentTicketHint": "One petal = one set, free",
      "checkout.ticketRemainingTotal": "Total to pay",
      "checkout.noTicket": "You don't have an available petal right now.",
      "checkout.ticketSingleSetOnly": "A petal covers exactly one set at a time.",
      "checkout.ticketNewPointNotAllowed": "A petal can't pay for an order to a new point — pick a point from the list.",

      "bonuses.title": "Bonuses & promo codes",
      "bonuses.ticketName": "“PAUSE DAY” petal",
      "bonuses.ticketAvailable": "Available",
      "bonuses.ticketUsed": "Used",
      "bonuses.ticketWonOn": "Won on {date}",
      "bonuses.ticketUsedOn": "Used on {date}",
      "bonuses.ticketHint": "Pay with your petal for any one set next time — we'll apply it ourselves.",
      "bonuses.petalsLabel": "Your petals", "bonuses.noneLeft": "Win PAUSE DAY and a new petal will appear here.", "bonuses.use": "Use it",
      "checkout.petalApplied": "Petal applied — one set on us",
      "notif.new": "new", "notif.win.title": "You've got a petal", "notif.win.body": "Today PAUSE DAY picked you — thank you for being with us. Your petal is waiting in “{section}”: use it to pay for any one set.", "notif.win.cta": "Use it",
      "bonuses.empty": "No bonuses yet — win the “PAUSE DAY” draw and a petal will show up here 🌸",
      "bonuses.loadFailed": "Couldn't load bonuses.",
      "notifications.title": "Notifications",
      "notifications.empty": "Nothing yet — important news will show up here: giveaway wins and PAUSE App updates.",
      "notifications.loadFailed": "Couldn't load notifications.",
      "bonuses.notRegistered": "You're not registered yet. Send /start in the bot chat.",

      "messages.title": "Messages",
      "messages.empty": "No messages yet.",
      "messages.soon1": "We haven't decided what to put here yet :)", "messages.soon2": "Send your ideas through",
      "messages.loadFailed": "Couldn't load messages — pull down to try again.",

      "profile.title": "Profile", "profile.settings": "Settings",
      "profile.loadFailed": "Couldn't load profile: {msg}",
      "profile.notRegistered": "You're not registered yet. Send /start in the bot chat to create a profile.",
      "profile.noName": "No name",
      "profile.toNextLevel": "{left} orders left to «{emoji} {label}»",
      "club.level.guest": "PAUSE Guest.", "club.level.regular": "PAUSE Member.",
      "club.level.circle": "PAUSE Insider.", "club.level.ambassador": "Vip Pause Club.",
      "profile.topLevel": "You're already at the top PAUSE Club level 🎉",
      "profile.clubTitle": "Pause Club",
      "profile.clubOrders": "{range} orders",
      "profile.clubDelivery": "Delivery",
      "profile.clubGiveaways": "PAUSE GIFT",
      "profile.statOrders": "orders", "profile.statPromo": "promos", "profile.statPosts": "posts",
      "profile.myOrders": "My orders", "profile.favorites": "Favorites", "profile.notifications": "Notifications",
      "profile.myMessages": "My messages",
      "profile.myMessagesEmpty": "No messages yet — they appear after each order.",
      "profile.myMessagesLoadFailed": "Couldn't load your messages.",
      "profile.bonuses": "Bonuses & promo codes", "profile.support": "Support",
      "favorites.title": "Favorites",
      "favorites.empty": "Nothing here yet — add dishes with ♡ on the card in Menu.",
      "favorites.loadFailed": "Couldn't load favorites.",
      "profile.logout": "Log out",

      "settings.title": "Settings",
      "settings.editProfile": "Edit profile",
      "settings.deliveryAddress": "Delivery address",
      "settings.language": "Language",
      "settings.deleteProfile": "Delete profile",
      "settings.deleteConfirm": "Delete your PAUSE App profile? The request goes to an admin — the bot doesn't delete the account automatically.",
      "settings.deleteYes": "Yes, delete",
      "settings.deleteSubmitted": "Request sent for processing",
      "settings.deleteFailed": "Couldn't send the request: {msg}",

      "editProfile.title": "Edit profile",
      "editProfile.name": "Name", "editProfile.phone": "Phone",
      "editProfile.save": "Save", "editProfile.saved": "Saved",
      "editProfile.saveFailed": "Couldn't save: {msg}",
      "editProfile.phoneInvalid": "Enter the full number — 9 digits after +998",

      "address.title": "Delivery address",
      "address.locate": "My location", "address.locateFail": "Couldn't get your location",
      "address.noResults": "Nothing found — try another query or move the map", "address.edit": "Edit address and area",
      "address.point": "Delivery point", "address.setPoint": "Set an address", "address.notChosen": "Not chosen yet",
      "address.save": "Save", "address.saved": "Saved",
      "address.pickFirst": "Choose a point first",
      "address.saveFailed": "Couldn't save: {msg}",
      "address.newPoint": "New point", "address.newPointField": "Address / point name",
      "address.newZoneField": "Area", "address.done": "Done", "address.fillBoth": "Fill in the area and the point",
      "address.searchPlaceholder": "Address or place name",
      "address.mapHint": "Tap a pin to pick a place others already order from, or tap anywhere on the map to set a new one",
      "address.mapUnavailable": "The map isn't available right now — check your connection and try again.",
      "address.confirmHere": "Deliver here",

      "lang.title": "Language",

      "orders.title": "My orders",
      "orders.empty": "No orders yet.",
      "orders.allPaid": "You're all set — everything's paid 🤍",
      "orders.reviewing": "Under review",
      "orders.canceled": "Canceled", "orders.complete": "Completed", "orders.preparing": "Preparing",
      "orders.paid": "Paid", "orders.unpaid": "Unpaid", "orders.all": "All",
      "orders.debtTag": " (on credit)",
      "orders.payChecking": "Payment under review",
      "orders.method": "Payment method", "orders.method.card": "Card", "orders.method.cash": "Cash", "orders.method.ticket": "Ticket", "pay.title": "Today's payment", "pay.total": "Total due", "pay.send": "Send payment", "pay.sent": "Screenshot sent. We'll check the payment and confirm your order.", "pay.nothing": "No payment needed right now.", "orders.setsSum": "Sets", "orders.pay": "Pay {sum}", "orders.payHint": "Choose the days you want to pay for and attach a payment screenshot — we'll check and confirm it.",
      "orders.delivery": "Delivery", "orders.dlv.paid": "paid", "orders.dlv.review": "awaiting confirmation", "orders.dlv.debt": "on credit", "orders.dlv.unpaid": "unpaid",
      "orders.cancel": "Cancel",
      "orders.cancelConfirm": "Cancel the order for {date}?",
      "orders.cancelYes": "Yes, cancel",
      "orders.canceledToast": "Order canceled",
      "orders.cancelFailed": "Couldn't cancel the order",
      "orders.cancelTooLate": "Too late to cancel yourself — please contact support.",
      "orders.cancelCardPending": "Card payment is already being reviewed — cancel via support.",
      "orders.review": "★ Review",
      "orders.debtLine": "Current debt: {sum}",
      "orders.loadFailed": "Couldn't load orders.",

      "feedback.title": "Order review",
      "feedback.commentPlaceholder": "Comment — optional",
      "feedback.send": "Send",
      "feedback.needSomething": "Give a rating or write a few words",
      "feedback.thanks": "Thanks for sharing 🤎",
      "feedback.sendFailed": "Couldn't send: {msg}",

      "notify.title": "Notifications",
      "notify.morningTitle": "Morning reminder",
      "notify.morningSub": "A warm morning message reminding you to order",
      "notify.menuTitle": "Menu published",
      "notify.menuSub": "A message when today's new menu is published",
      "notify.on": "Enabled", "notify.off": "Disabled",
      "notify.saveFailed": "Couldn't save",
      "notify.loadFailed": "Couldn't load notification settings.",
      "notify.footnote": "Notification times are still the same for everyone — we'll add per-person timing separately if needed.",

      "support.title": "Support",
      "support.intro": "For any suggestions or issues, reach out here — we're always around and happy to help.",
      "support.social": "Social", "support.contacts": "Contacts",
      "support.telegram": "Telegram", "support.instagram": "Instagram", "support.phone": "Phone",
      "support.founderBlog": "Founder's blog",
    },
  };

  function t(key, vars) {
    var dict = I18N[state.lang] || I18N.ru;
    var str = (key in dict) ? dict[key] : ((key in I18N.ru) ? I18N.ru[key] : key);
    if (vars) {
      Object.keys(vars).forEach(function (k) {
        str = str.split("{" + k + "}").join(vars[k]);
      });
    }
    return str;
  }

  function clubLevelLabel(key, fallback) {
    return key ? t("club.level." + key) : fallback;
  }

  // Значки статусов PAUSE Club — ПОЛНОЦЕННЫЕ иконки (по метафоре
  // приближения к финальному статусу: дверь → росток → ключ → корона),
  // не текстовые эмодзи. Ключ ("guest"/"regular"/"circle"/"ambassador")
  // — тот же стабильный key, что и в config.CLUB_LEVELS/sheets.get_club_level,
  // emoji/next_emoji из ответа сервера тут сознательно не используются
  // (они остаются только для текста бота в чате, где своих иконок нет).
  // Единый визуальный язык: viewBox 24×24, одна толщина линии (1.6),
  // только обводка — ни один из четырёх не залит, чтобы не смешивать
  // стили внутри одного набора.
  var CLUB_LEVEL_ICONS = {
    guest: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" width="15" height="15" style="vertical-align:-3px"><rect x="6" y="3" width="12" height="18" rx="1.5"/><path d="M14.3 12h.01"/></svg>',
    // Был неразборчивый "капля/пламя" силуэт — по прямой просьбе заменён
    // на чёткий росток (стебель + два листа), метафора "рост" понятнее
    // считывается и не путается с другими тремя значками.
    regular: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" width="15" height="15" style="vertical-align:-3px"><path d="M12 21V10"/><path d="M12 10C12 6 9 3 5 3c0 4 3 7 7 7z"/><path d="M12 13c0-3.5 2.5-6 6-6c0 3.5-2.5 6-6 6z"/></svg>',
    circle: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" width="15" height="15" style="vertical-align:-3px"><circle cx="7" cy="12" r="3.3"/><path d="M10.1 12H20"/><path d="M17 12v3M20 12v3"/></svg>',
    ambassador: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" width="15" height="15" style="vertical-align:-3px"><path d="M4 18L6 8L9 13L12 6L15 13L18 8L20 18Z"/></svg>',
  };
  function clubLevelIcon(key) {
    return CLUB_LEVEL_ICONS[key] || "";
  }

  var ICON_CLUB_CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><path d="M5 12.5l4.5 4.5L19 7"/></svg>';

  // Экран "Pause Club" (по тапу на бейдж статуса в Профиле) — вся шкала
  // целиком: сколько осталось до следующего уровня (как раньше), затем
  // все 4 статуса по порядку, у пройденных — галочка, текущий —
  // подсвечен, у каждого можно развернуть, что он даёт (p.club.levels —
  // см. sheets.get_club_levels_overview, уже посчитано на сервере).
  function renderClubLevelsScreen(root, p) {
    root.innerHTML = "";

    var scale = el("div", "club-scale");
    p.club.levels.forEach(function (l) {
      scale.appendChild(el("div", "club-scale-seg" + (l.passed || l.current ? " filled" : "")));
    });
    root.appendChild(scale);

    if (p.club.next_label) {
      root.appendChild(el(
        "div", "club-progress-label",
        t("profile.toNextLevel", { emoji: clubLevelIcon(p.club.next_key), label: escapeHtml(clubLevelLabel(p.club.next_key, p.club.next_label)), left: p.club.left })
      ));
    } else {
      root.appendChild(el("div", "club-progress-label", t("profile.topLevel")));
    }

    var list = el("div", "club-level-list");
    p.club.levels.forEach(function (l) {
      list.appendChild(buildClubLevelCard(l));
    });
    root.appendChild(list);
  }

  function buildClubLevelCard(l) {
    var card = el("div", "card club-level-card" + (l.current ? " current" : ""));
    var expanded = false;

    function render() {
      card.innerHTML = "";
      card.classList.toggle("expanded", expanded);

      var head = el("div", "club-level-card-head");
      head.appendChild(el("span", "club-level-card-icon", clubLevelIcon(l.key)));
      var info = el("div", "club-level-card-info");
      info.appendChild(el("div", "club-level-card-name", escapeHtml(clubLevelLabel(l.key, l.label))));
      info.appendChild(el("div", "club-level-card-range", t("profile.clubOrders", { range: l.range_text })));
      head.appendChild(info);

      var right = el("div", "club-level-card-right");
      if (l.passed) right.appendChild(el("span", "club-level-card-check", ICON_CLUB_CHECK));
      right.appendChild(el("span", "club-level-card-chevron" + (expanded ? " up" : ""), ICON_CHEVRON));
      head.appendChild(right);
      card.appendChild(head);

      if (expanded) {
        var details = el("div", "club-level-card-details");
        details.innerHTML =
          '<div class="club-level-card-detail-row"><span>' + t("profile.clubDelivery") + '</span><span>' + escapeHtml(l.delivery) + '</span></div>' +
          '<div class="club-level-card-detail-row"><span>' + t("profile.clubGiveaways") + '</span><span>' + escapeHtml(l.giveaways) + '</span></div>';
        card.appendChild(details);
      }

      card.onclick = function () { haptic("select"); expanded = !expanded; render(); };
    }

    render();
    return card;
  }

  // Названия блюд/сетов и варианты ("С компотом"/"Без компота") — это
  // данные, которые вводит админ через бота (см. config.SET_VARIANTS,
  // texts.SET_DISPLAY_NAMES), а не интерфейсный текст, поэтому их нет в
  // I18N выше. Но сам каталог названий фиксирован и меняется редко, так
  // что для него (в отличие от свободного текста описаний/категорий,
  // которые админ вводит каждый день заново и которые пока остаются на
  // русском) есть смысл держать перевод здесь. Ключ — РУССКОЕ клиентское
  // название (то, что отдаёт texts.display_set_name — см. pauseapp.py:
  // _serialize_sets и api_orders), а не "сырое" админское имя сета: это
  // единственное, что приходит одинаково и в карточке Меню (s.display_name),
  // и в "Мои заказы" (item.set) — там технического/сырого имени наружу
  // уже не остаётся. Когда админ добавит новый сет, он просто покажется
  // на русском, пока сюда не добавят перевод — ничего не ломается.
  var SET_NAME_TRANSLATIONS = {
    "Пауза дня.": { uz: "Kun taomi.", en: "Dish of the day." },
    "Для тебя.": { uz: "Sen uchun.", en: "For you." },
    "Пауза в балансе.": { uz: "Pauza balansda.", en: "Pause in balance." },
    "Пауза дуо.": { uz: "Pauza duo.", en: "Pause duo." },
    "Chicken bowl.": { uz: "Chicken bowl.", en: "Chicken bowl." },
    "Beef bowl.": { uz: "Beef bowl.", en: "Beef bowl." },
    "Пауза Prime.": { uz: "Pauza Prime.", en: "Pause Prime." },
  };
  var VARIANT_LABEL_TRANSLATIONS = {
    "С компотом": { uz: "Kompot bilan", en: "With compote" },
    "Без компота": { uz: "Kompotsiz", en: "Without compote" },
  };
  function localizedSetName(name) {
    if (state.lang === "ru" || !name) return name;
    var entry = SET_NAME_TRANSLATIONS[name];
    return (entry && entry[state.lang]) || name;
  }
  function localizedVariantLabel(label) {
    if (state.lang === "ru" || !label) return label;
    var entry = VARIANT_LABEL_TRANSLATIONS[label];
    return (entry && entry[state.lang]) || label;
  }

  var ICON_LANG_CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';

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
    return (n || 0).toLocaleString("ru-RU") + " " + t("common.currency");
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

  // Новые номера теперь везде сохраняются уже в едином виде
  // "+998 XX XXX XX XX" (см. buildPhoneField ниже — ввод в самом
  // приложении, и sheets.format_uz_phone — регистрация/правка телефона
  // в боте). Но старые записи (внесённые вручную в CRM ещё до этого,
  // или просто написанные как попало в чат боту до этой правки) могут
  // быть в любом виде — пробелы/дефисы/без кода страны. Эта функция —
  // только для ПОКАЗА, сама таблица не трогается.
  function formatPhone(raw) {
    var digits = (raw || "").replace(/\D/g, "");
    if (digits.slice(0, 3) === "998") digits = digits.slice(3);
    digits = digits.slice(-9);
    if (digits.length < 9) return raw || "";
    return "+998 " + digits.slice(0, 2) + " " + digits.slice(2, 5) + " " + digits.slice(5, 7) + " " + digits.slice(7, 9);
  }

  // Поле ввода телефона с "прикреплённым" +998 и живым форматированием —
  // используется везде, где телефон редактируется (пока только Профиль →
  // Редактировать профиль, см. openEditProfileInfo). Код страны выводится
  // отдельным нередактируемым блоком, человек набирает только 9 цифр
  // абонентского номера — пробелы между группами (2-3-2-2) расставляются
  // сами по мере ввода. Если цифр не ровно 9 (в том числе если по
  // привычке ещё раз набрали "998" или "+998" вместо своего номера —
  // ровно тот случай, из-за которого это вообще понадобилось) — поле
  // подсвечивается, кнопка "Сохранить" должна блокироваться вызывающим
  // кодом, пока isValid() не вернёт true (см. getPhone/isValid ниже).
  function formatUzPhoneDigits(digits) {
    var groups = [2, 3, 2, 2];
    var parts = [];
    var i = 0;
    groups.forEach(function (len) {
      if (i >= digits.length) return;
      parts.push(digits.slice(i, i + len));
      i += len;
    });
    var out = parts.join(" ");
    if (i < digits.length) out += " " + digits.slice(i); // лишние цифры — видно, что номер не влезает
    return out;
  }

  function buildPhoneField(labelText, initialRaw) {
    var wrap = el("div", "field");
    wrap.innerHTML = '<label>' + escapeHtml(labelText) + '</label>';

    var row = el("div", "phone-input-row");
    row.appendChild(el("span", "phone-input-prefix", "+998"));
    var input = el("input");
    input.type = "tel";
    input.inputMode = "numeric";
    input.placeholder = "90 123 45 67";
    wrap.appendChild(row);
    row.appendChild(input);

    var errorEl = el("div", "phone-input-error", t("editProfile.phoneInvalid"));
    errorEl.hidden = true;
    wrap.appendChild(errorEl);

    // Из уже сохранённого значения (любого вида — см. formatPhone выше)
    // достаём ровно 9 цифр абонентского номера для предзаполнения.
    var initDigits = (initialRaw || "").replace(/\D/g, "");
    if (initDigits.slice(0, 3) === "998") initDigits = initDigits.slice(3);
    initDigits = initDigits.slice(-9);
    input.value = formatUzPhoneDigits(initDigits);

    // Пустое поле — это "не меняем номер" (у клиента и так уже может не
    // быть телефона в карточке, это не повод блокировать сохранение
    // имени), а вот НАЧАТОЕ, но неполное/слишком длинное — уже ошибка.
    function currentDigits() { return input.value.replace(/\D/g, ""); }
    function isAcceptable() { var n = currentDigits().length; return n === 0 || n === 9; }
    function refreshValidity(showError) {
      var ok = isAcceptable();
      row.classList.toggle("invalid", showError && !ok);
      errorEl.hidden = !(showError && !ok);
      return ok;
    }

    input.addEventListener("input", function () {
      var digits = currentDigits();
      input.value = formatUzPhoneDigits(digits);
      // Пока цифр меньше 9 — рано ругаться, человек ещё печатает. А вот
      // больше 9 — однозначно уже слишком длинно (та самая ситуация "ещё
      // раз набрали 998"), подсвечиваем сразу, не дожидаясь потери фокуса.
      refreshValidity(digits.length > 9);
    });
    input.addEventListener("blur", function () { refreshValidity(currentDigits().length > 0); });

    return {
      el: wrap,
      isValid: isAcceptable,
      // Показать красную ошибку принудительно — для попытки сохранить
      // незавершённый номер.
      showErrorIfInvalid: function () { return refreshValidity(true); },
      getPhone: function () { return currentDigits().length ? ("+998 " + formatUzPhoneDigits(currentDigits())) : ""; },
    };
  }

  // -------------------------------------------------------------------
  // Шапка экрана — своя на каждой вкладке, как на макете (единой сплошной
  // шапки на всё приложение больше нет, см. index.html). opts:
  //   back     — функция клика по стрелке "назад" слева (если есть)
  //   title    — текст заголовка
  //   center   — true, если заголовок по центру (Меню/Профиль), иначе слева
  //              прижатый к началу (Pause Club/Послания — как на макете)
  //   right    — {icon, label, onClick} — иконка справа, необязательна
  //   rightBell — true на Главной: колокольчик уведомлений справа вместо
  //              иконки (см. buildHeaderBell) — раньше тут был
  //              переключатель языка (RU/UZ/EN) в одно касание, убрали по
  //              прямой просьбе; сама смена языка никуда не делась,
  //              осталась в Профиль → Настройки → Язык.
  // -------------------------------------------------------------------

  function screenHeader(containerId, opts) {
    var root = document.getElementById(containerId);
    root.innerHTML = "";
    var bar = el("div", "screen-header" + (opts.center ? " screen-header-center" : ""));
    var left = el("div", "screen-header-side screen-header-left");
    if (opts.back) {
      var backBtn = el("button", "header-icon-btn", ICON_BACK);
      backBtn.setAttribute("aria-label", t("common.back"));
      backBtn.addEventListener("click", function () { haptic("select"); opts.back(); });
      left.appendChild(backBtn);
    }
    bar.appendChild(left);
    bar.appendChild(el("div", "screen-header-title", escapeHtml(opts.title || "")));
    var right = el("div", "screen-header-side screen-header-right");
    if (opts.rightBell) {
      right.appendChild(buildHeaderBell());
    } else if (opts.right) {
      var rightBtn = el("button", "header-icon-btn", opts.right.icon);
      rightBtn.setAttribute("aria-label", opts.right.label || "");
      rightBtn.addEventListener("click", function () { haptic("select"); opts.right.onClick(); });
      right.appendChild(rightBtn);
    }
    bar.appendChild(right);
    root.appendChild(bar);
  }

  // Колокольчик уведомлений в шапке Главной — см. config.
  // SHEET_APP_NOTIFICATIONS/sheets.get_app_notifications. Открывает
  // отдельный список (loadNotifications), точка над иконкой — пока есть
  // хоть одно непрочитанное (state.notifUnread, см. loadHome). ICON_BELL
  // определена чуть ниже, рядом с остальными иконками шапки.
  function buildHeaderBell() {
    var btn = el("button", "header-icon-btn header-bell-btn", ICON_BELL);
    btn.setAttribute("aria-label", t("notifications.title"));
    if (state.notifUnread > 0) btn.appendChild(el("span", "header-bell-dot"));
    btn.addEventListener("click", function () {
      haptic("select");
      openProfileSubscreen(t("notifications.title"), loadNotifications);
    });
    return btn;
  }

  var ICON_BACK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" width="22" height="22"><path d="M15 5l-7 7 7 7"/></svg>';
  // Стандартная, многократно проверенная иконка "шестерёнка" (Feather
  // Icons, settings) — прошлая версия была нарисована вручную и рендерилась
  // неровно (зубцы разного размера/шага), заменена на готовый, точный путь.
  var ICON_GEAR = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" width="21" height="21" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>';
  var ICON_KEBAB = '<svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20"><circle cx="12" cy="5" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="12" cy="19" r="1.8"/></svg>';
  // Стандартный колокольчик (Feather Icons, bell) — см. buildHeaderBell.
  var ICON_BELL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" width="21" height="21" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>';

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
    // ВАЖНО: каждая вкладка при заходе либо дорисовывает уже загруженные
    // данные, либо грузит их с нуля — никогда молча ничего не делает
    // (иначе первый заход в неё показывал бы вечный скелетон-плейсхолдер,
    // а повторный — старый текст на старом языке после смены языка в
    // Настройках, см. applyLangToUI ниже).
    //
    // Главная и Меню — особый случай: меню (сеты/цены/приём закрыт или
    // нет) правится координатором через бота прямо в течение дня, пока
    // клиент сидит в уже открытом PAUSE App — Telegram НЕ перезагружает
    // WebView при переключении вкладок, так что старые state.home/
    // state.menu просто остаются висеть в памяти сколько угодно (так и
    // поймали: обновили меню в боте, в уже открытом приложении ничего не
    // изменилось). Поэтому тут не "или кэш, или загрузка", а ОБА разом:
    // старое (если есть) показываем сразу, не дожидаясь сети, и тут же
    // следом грузим свежее — когда придёт, экран перерисуется сам.
    if (name === "home") { if (state.home) renderHomeScreen(); loadHome(); }
    if (name === "profile") { if (state.profile) renderProfileScreen(); else loadProfile(); }
    if (name === "menu") { if (state.menu) renderMenuScreen(); loadMenu(); }
    if (name === "club") {
      // Карточка статуса в шапке (renderClubHero) читает state.profile —
      // тем же приёмом, что и розыгрыш ниже: старое (если есть) сразу,
      // следом фоном подтягиваем свежее (статус мог измениться после
      // заказа в этой же сессии).
      if (state.profile) renderClubHero();
      api("/api/profile").then(function (p) { if (p && p.registered) { state.profile = p; renderClubHero(); } }).catch(function () {});
      if (state.feed) renderClubNowCards();
      loadFeed();
      loadMoments();
      // Пул розыгрыша — всегда свежий (как home), не "кэш или загрузка":
      // кто сегодня в пуле и подведён ли итог меняется в реальном
      // времени, старое показываем сразу, не дожидаясь сети, и тут же
      // следом грузим свежее.
      if (state.giveaway) renderClubGiveaway();
      loadClubGiveaway();
      // Рейтинг больше не рисуется инлайн на экране (см. renderClubLeaderboard) —
      // грузится фоном только чтобы держать свежим число "N человек" на
      // карточке и данные наготове, если по карточке тапнут.
      if (state.leaderboard) renderClubNowCards();
      loadClubLeaderboard();
      loadClubCards();
    }
    if (name === "messages") { if (state.feed) renderMessagesFeedScreen(); else loadFeed(); }
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
    document.getElementById("wizard").classList.remove("wizard-white");
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
  // Раньше здесь спрашивали подтверждение "Прервать оформление заказа?",
  // если в корзине были позиции — но корзина (state.cart) теперь не
  // зависит от того, открыт визард или нет: закрыть визард в любой
  // момент безопасно, ничего не потеряется, плавающая панель корзины
  // просто останется на месте.
  document.getElementById("wizard-close").addEventListener("click", closeWizard);

  // -------------------------------------------------------------------
  // ГЛАВНАЯ — приветствие + переход к разделам, всё на реальных данных
  // (профиль клиента + сегодняшнее меню, те же самые ответы API, что и у
  // экранов Меню/Профиль — просто дублируем их локально в state, чтобы
  // при заходе на сами эти вкладки не перезапрашивать то, что уже есть).
  // -------------------------------------------------------------------

  var QUICK_NAV = [
    { screen: "menu", labelKey: "home.qnMenu", icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="4" y="4" width="16" height="16" rx="4"/><path d="M8 10h8M8 14h5"/></svg>' },
    { screen: "club", labelKey: "home.qnClub", icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="5.5" cy="9.3" r="1.9"/><path d="M2.3 17 C2.3 13.8 3.6 12 5.5 12 C6.5 12 7.3 12.5 7.8 13.4"/><circle cx="18.5" cy="9.3" r="1.9"/><path d="M21.7 17 C21.7 13.8 20.4 12 18.5 12 C17.5 12 16.7 12.5 16.2 13.4"/><circle cx="12" cy="7.8" r="2.6"/><path d="M7.7 18 C7.7 14 9.4 11.6 12 11.6 C14.6 11.6 16.3 14 16.3 18"/></svg>' },
    { screen: "messages", labelKey: "home.qnMessages", icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="3.5" y="5.5" width="17" height="13" rx="2.5"/><path d="M4.5 7 12 12.5 19.5 7"/></svg>' },
    { screen: "profile", labelKey: "home.qnProfile", icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="12" cy="8" r="3.4"/><path d="M5 20c1.2-3.8 4-5.6 7-5.6s5.8 1.8 7 5.6"/></svg>' },
  ];

  function loadHome() {
    var root = document.getElementById("home-root");
    var hadCache = !!state.home;
    // Меню — всегда свежее (см. showScreen: приём/цены/сеты могут
    // поменяться в течение дня через бота, пока приложение уже открыто);
    // профиль — можно переиспользовать, он меняется куда реже.
    Promise.all([
      state.profile ? Promise.resolve(state.profile) : api("/api/profile"),
      api("/api/menu"),
      api("/api/notifications").catch(function () { return { unread_count: state.notifUnread || 0 }; }),
    ]).then(function (results) {
      state.profile = results[0];
      state.menu = results[1];
      state.notifUnread = results[2].unread_count || 0;
      state.home = true;
      renderHomeScreen();
    }).catch(function (err) {
      // Уже показан рабочий (пусть и чуть устаревший) экран — разовый сбой
      // фонового обновления не должен стирать его в пустой экран ошибки.
      if (hadCache) return;
      root.innerHTML = "";
      root.appendChild(el("div", "empty-note", t("home.loadError", { msg: err.message })));
    });
  }

  // --- Главная: карусель "новостей" ----------------------------------------

  var homeCarouselTimer = null;

  var HOME_PROMO_ARROW = '<div class="home-promo-arrow"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M9 6l6 6-6 6"/></svg></div>';

  // Слайды — в том же формате, что и прежняя плашка "Сегодняшнее меню"
  // (иконка, заголовок, подпись, стрелка).
  function buildHomeMenuSlide(m) {
    var card = el("div", "card home-promo");
    if (m.published && !m.cutoff_passed) {
      card.innerHTML =
        '<div class="home-promo-icon">' + ICON_LEAF + '</div>' +
        '<div><div class="home-promo-title">' + t("home.ordersOpenTitle", { date: escapeHtml(m.date || "") }) + '</div>' +
        '<div class="home-promo-sub">' + escapeHtml(t("home.todayMenu")) + '</div></div>' + HOME_PROMO_ARROW;
    } else {
      card.innerHTML =
        '<div class="home-promo-icon">' + ICON_CLOCK + '</div>' +
        '<div><div class="home-promo-title">' + t("home.menuToday") + '</div>' +
        '<div class="home-promo-sub">' + (m.published ? t("home.cutoffClosed") : t("home.cominSoon")) + '</div></div>';
    }
    card.addEventListener("click", function () { showScreen("menu"); });
    return card;
  }

  function buildHomeClubSlide(c) {
    var tx = clubCardTexts(c);
    var card = el("div", "card home-promo");
    card.innerHTML =
      '<div class="home-promo-icon">' + ICON_LEAF + '</div>' +
      '<div><div class="home-promo-title">' + escapeHtml(tx.heading || tx.eyebrow) + '</div>' +
      '<div class="home-promo-sub">' + escapeHtml(tx.heading ? tx.eyebrow : "") + '</div></div>' + HOME_PROMO_ARROW;
    var onTap = clubCardTapHandler(c, tx);
    card.addEventListener("click", function () { haptic("select"); onTap(); });
    return card;
  }

  function buildHomeNewsCarousel(m) {
    if (!state.clubCards && !state.clubCardsRequested) {
      state.clubCardsRequested = true;
      loadClubCards();
    }
    // Данные для страниц карточек (участники PAUSE DAY, рейтинг, стена) —
    // подгружаем один раз в фоне, чтобы тап с Главной не открывал пустое.
    if (!state.homeNewsPrefetched) {
      state.homeNewsPrefetched = true;
      if (!state.giveaway) loadClubGiveaway();
      if (!state.leaderboard) loadClubLeaderboard();
      if (!state.moments) loadMoments();
    }
    var slidesData = [buildHomeMenuSlide(m)];
    (state.clubCards || DEFAULT_CLUB_CARDS).forEach(function (c) { slidesData.push(buildHomeClubSlide(c)); });

    var carousel = el("div", "pday-carousel home-news");
    var track = el("div", "pday-carousel-track");
    var dots = el("div", "pday-carousel-dots");
    var dotEls = [];
    slidesData.forEach(function (card, i) {
      var slide = el("div", "pday-carousel-slide");
      slide.appendChild(card);
      track.appendChild(slide);
      var d = el("span", "pday-carousel-dot" + (i === 0 ? " active" : ""));
      dotEls.push(d);
      dots.appendChild(d);
    });
    carousel.appendChild(track);
    if (slidesData.length > 1) carousel.appendChild(dots);

    function currentIdx() { return Math.round(track.scrollLeft / Math.max(1, track.clientWidth)); }
    var scrollTimer = null;
    track.addEventListener("scroll", function () {
      if (scrollTimer) clearTimeout(scrollTimer);
      scrollTimer = setTimeout(function () {
        var idx = currentIdx();
        dotEls.forEach(function (d, i) { d.classList.toggle("active", i === idx); });
      }, 60);
    });

    if (homeCarouselTimer) { clearInterval(homeCarouselTimer); homeCarouselTimer = null; }
    if (slidesData.length > 1) {
      var pausedUntil = 0;
      var hold = function () { pausedUntil = Date.now() + 6000; };
      track.addEventListener("touchstart", hold, { passive: true });
      track.addEventListener("touchmove", hold, { passive: true });
      track.addEventListener("pointerdown", hold);
      homeCarouselTimer = setInterval(function () {
        // перестаём крутить, если карусель ушла с экрана (другая вкладка/перерисовка)
        if (!document.body.contains(track) || state.screen !== "home") {
          if (!document.body.contains(track)) { clearInterval(homeCarouselTimer); homeCarouselTimer = null; }
          return;
        }
        if (Date.now() < pausedUntil || !document.getElementById("wizard").hidden) return;
        var next = (currentIdx() + 1) % slidesData.length;
        track.scrollTo({ left: next * track.clientWidth, behavior: "smooth" });
      }, 10000);
    }
    return carousel;
  }

  function renderHomeScreen() {
    screenHeader("home-header", {
      rightBell: true,
    });
    var root = document.getElementById("home-root");
    root.innerHTML = "";
    var p = state.profile;
    var m = state.menu;

    // "PAUSE." раньше стояло отдельным лого в шапке — теперь это часть
    // самого приветствия: "Добро пожаловать" + имя отдельной строкой (см.
    // home.welcomeName — перенос строки прямо в переводе, через <br>), а
    // бренд "PAUSE" переехал вниз, в начало строки с таглайном (само
    // слово "PAUSE" не переводится ни на один язык — оставлено статикой,
    // а не частью i18n-ключа).
    var firstName = (p && p.registered && p.name) ? p.name.trim().split(/\s+/)[0] : "";
    var hero = el("div", "home-hero");
    hero.innerHTML =
      '<h2>' + (firstName ? t("home.welcomeName", { name: escapeHtml(firstName) }) : t("home.welcome")) + '</h2>' +
      '<p><span class="home-tagline-brand">PAUSE</span> — ' + t("home.tagline") + '</p>';
    root.appendChild(hero);

    // Новостная карусель вместо одной плашки "Сегодняшнее меню": первый
    // слайд — статус приёма заказов (с датой), дальше карточки PAUSE Club.
    // Каждые 5 секунд плавно листается сама, можно свайпнуть руками, тап
    // по слайду открывает именно эту карточку.
    root.appendChild(buildHomeNewsCarousel(m));

    var quickRow = el("div", "home-quick-row");
    QUICK_NAV.forEach(function (item) {
      var btn = el("button", "home-quick-item", item.icon + "<span>" + t(item.labelKey) + "</span>");
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
      root.appendChild(el("div", "profile-section-title", t("home.inMenuToday")));
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
    var hadCache = !!state.menu;
    // Категорию сбрасываем только на самом первом заходе — теперь
    // loadMenu() вызывается ещё и в фоне при каждом повторном открытии
    // вкладки (см. showScreen), и сброс фильтра на каждое такое
    // обновление сносил бы уже выбранную клиентом категорию без всякой
    // причины, хотя данные под ней просто обновились.
    if (!hadCache) state.menuCategory = "all";
    api("/api/menu").then(function (data) {
      state.menu = data;
      // Если человек прямо сейчас выбирает гарнир/количество в раскрытой
      // карточке — не выдёргиваем её перерисовкой из-под рук. Свежие
      // данные уже лежат в state.menu и применятся сами на следующий
      // обычный показ экрана (свернул карточку, ушёл и вернулся и т.п.).
      if (!document.querySelector("#menu-root .menu-set-card.expanded")) {
        renderMenuScreen();
      }
    }).catch(function (err) {
      // Уже показано рабочее (пусть и чуть устаревшее) меню — разовый сбой
      // фонового обновления не должен стирать его в пустой экран ошибки.
      if (hadCache) return;
      root.innerHTML = "";
      root.appendChild(el("div", "menu-state", "<p>" + t("menu.loadErr") + "</p>"));
      var retry = el("button", "btn-ghost", t("menu.retry"));
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
  // Веточка с листьями вместо одиночного "лепестка" — по прямой просьбе
  // (старый вариант путали с чем-то непонятным). Один источник для ВСЕХ
  // мест, где раньше стоял ICON_LEAF (пустое фото сета, заглушки
  // Pause Club/Послания, промо на Главной, подтверждение заказа) —
  // меняется теперь всегда и везде разом, отдельно синхронизировать не
  // нужно.
  var ICON_LEAF = '<svg width="44" height="44" viewBox="0 0 18.71 24.6" fill="currentColor" stroke="none"><path d="M11.1,0.56C10.9,0.71 10.46,1.02 10.09,1.24C9.14,1.85 8.81,2.09 8.4,2.5C7.31,3.61 6.7,5.16 6.6,7.11C6.58,7.44 6.53,8.01 6.48,8.37C6.39,9.08 6.37,10.2 6.43,10.95L6.47,11.44L6.24,10.96C6,10.48 5.96,10.36 5.64,9.3C5.41,8.53 5.18,8.06 4.83,7.69C4.43,7.25 4.15,7.06 3.07,6.44C2.57,6.16 2.06,5.85 1.95,5.78C1.84,5.69 1.74,5.64 1.72,5.65C1.71,5.66 1.81,5.94 1.95,6.28C2.08,6.62 2.23,7.02 2.29,7.17C2.56,7.84 3.1,8.47 3.81,8.94C4.01,9.07 4.44,9.35 4.77,9.57C5.93,10.33 6.25,10.87 6.8,13.03C7.01,13.85 7.32,14.67 7.71,15.45L7.98,15.99L7.57,15.61C7.15,15.24 7.08,15.16 6.3,14.1C5.31,12.76 4.5,12.21 3.23,12.04C2.81,11.98 0.23,11.98 0.3,12.04C0.33,12.05 0.46,12.15 0.6,12.27C0.73,12.38 1.04,12.66 1.28,12.88C2.44,13.98 3.12,14.32 4.92,14.67C6.63,15.01 6.93,15.15 7.73,15.95C8.13,16.35 8.36,16.64 8.62,17.05C8.97,17.61 9.71,18.63 10.03,19C10.13,19.11 10.44,19.44 10.73,19.73C11.2,20.22 11.23,20.26 11.02,20.14C10.89,20.07 10.49,19.86 10.11,19.67C9.66,19.44 9.26,19.19 8.89,18.9C7.87,18.11 7.23,17.83 6.35,17.78C5.66,17.75 5.41,17.8 4.17,18.21C3.63,18.4 3.08,18.56 2.95,18.58C2.82,18.59 2.68,18.62 2.62,18.64C2.49,18.67 4.57,19.36 5.12,19.46C5.64,19.55 6.85,19.56 7.53,19.49C8.14,19.41 8.98,19.41 9.32,19.49C9.93,19.62 11.33,20.41 12.45,21.24C13.98,22.4 15.46,23.26 16.91,23.84C17.56,24.11 18.41,24.36 18.41,24.29C18.41,24.27 18.15,24.16 17.83,24.06C16.26,23.53 14.62,22.68 13.13,21.6C12.39,21.07 12.11,20.76 11.83,20.15C11.69,19.87 11.67,19.76 11.67,19.43C11.67,19.04 11.74,18.78 12.04,17.96C12.38,17.05 12.44,16.7 12.42,15.73C12.39,14.18 12.39,13.88 12.41,13.72C12.47,13.4 12.31,13.54 11.9,14.16C11.43,14.88 11.08,15.56 10.91,16.12C10.8,16.46 10.79,16.61 10.79,17.31C10.79,18.07 10.8,18.13 10.95,18.58C11.11,19.03 11.59,20.04 11.88,20.51L12.02,20.75L11.74,20.52C11.3,20.16 10.25,19.09 9.86,18.6C9.36,17.98 8.41,16.53 8.17,16.03C7.88,15.42 7.8,15.03 7.82,14.26C7.84,13.64 7.85,13.59 8.01,13.26C8.24,12.8 8.6,12.43 9.42,11.85C10.57,11.03 10.93,10.62 11.56,9.44C11.72,9.13 11.96,8.73 12.1,8.55L12.35,8.22L12.01,8.37C11.82,8.45 11.34,8.61 10.94,8.73C10.54,8.85 10.05,9.02 9.84,9.12C8.83,9.59 8.15,10.33 7.78,11.39C7.63,11.8 7.63,11.81 7.64,12.94C7.65,13.57 7.66,14.32 7.68,14.62L7.71,15.16L7.55,14.83C7.14,13.96 6.7,12.32 6.57,11.13C6.49,10.44 6.51,9.08 6.6,8.5C6.7,7.84 6.86,7.59 7.7,6.79C8.93,5.63 9.45,5.08 9.77,4.59C10.13,4.04 10.49,3.18 10.81,2.08C11.17,0.87 11.23,0.71 11.36,0.5C11.43,0.39 11.48,0.3 11.47,0.3C11.46,0.3 11.29,0.42 11.1,0.56M10.79,1.77C10.08,4.07 9.77,4.63 8.49,5.86C8.1,6.22 7.56,6.76 7.28,7.04C7,7.33 6.78,7.51 6.8,7.46C6.82,7.4 6.88,7.2 6.94,7C7.28,5.9 8.06,4.45 8.72,3.72C9.06,3.35 8.96,3.31 8.61,3.69C8,4.34 7.29,5.6 6.9,6.73C6.8,7.03 6.71,7.27 6.7,7.27C6.67,7.23 6.79,6.23 6.88,5.74C7.25,3.86 8.15,2.61 9.94,1.48C10.38,1.2 10.82,0.91 10.92,0.82C11.01,0.74 11.1,0.68 11.11,0.68C11.11,0.68 10.97,1.18 10.79,1.77M3.64,6.92C4.4,7.36 4.91,7.86 5.19,8.42C5.34,8.73 5.69,9.78 5.69,9.91C5.69,9.92 5.57,9.76 5.43,9.55C4.86,8.72 3.99,7.78 3.46,7.39C3.09,7.13 3.16,7.27 3.59,7.65C4,8.02 4.53,8.57 4.85,8.96C5.1,9.28 5.54,9.89 5.54,9.94C5.54,9.95 5.4,9.86 5.24,9.74C5.08,9.62 4.78,9.41 4.58,9.3C3.07,8.38 2.71,7.95 2.17,6.52C2.06,6.22 1.97,5.97 1.97,5.96C1.97,5.95 2.21,6.09 2.51,6.26C2.81,6.44 3.32,6.73 3.64,6.92M11.83,8.76C11.73,8.9 11.51,9.28 11.33,9.6C10.78,10.62 10.55,10.86 9.31,11.79C8.52,12.37 8.15,12.72 7.96,13.07L7.86,13.25L7.9,13.07C8.07,12.14 8.7,11.12 9.46,10.52C9.63,10.37 9.77,10.25 9.75,10.24C9.74,10.22 9.61,10.29 9.47,10.38C9.19,10.56 8.74,11.02 8.49,11.39C8.26,11.72 7.93,12.43 7.85,12.74C7.75,13.19 7.69,13.06 7.73,12.46C7.77,11.8 7.86,11.42 8.11,10.91C8.61,9.9 9.47,9.27 10.94,8.85C11.3,8.75 11.68,8.63 11.76,8.59C12.01,8.49 12.01,8.5 11.83,8.76M3.57,12.21C4.17,12.34 4.83,12.69 5.31,13.13C5.64,13.44 6.7,14.77 6.66,14.81C6.65,14.82 6.35,14.63 5.98,14.39C5.19,13.87 3.88,13.2 3.21,12.97C2.51,12.74 2.35,12.78 3.01,13.01C3.67,13.26 4.28,13.54 4.98,13.93C5.55,14.24 6.54,14.88 6.51,14.91C6.49,14.92 6.39,14.9 6.27,14.86C6.16,14.82 5.64,14.7 5.11,14.6C3.08,14.19 2.56,13.92 1.03,12.49L0.62,12.11L1.9,12.12C2.86,12.12 3.28,12.15 3.57,12.21M12.24,14.07C12.22,14.16 12.23,14.47 12.26,14.76C12.34,15.53 12.33,16.39 12.23,16.86C12.19,17.09 12.03,17.6 11.89,18C11.75,18.41 11.6,18.91 11.57,19.12L11.5,19.5L11.42,19.2C11.19,18.41 11.21,17.42 11.45,16.59C11.57,16.18 11.58,16.05 11.5,16.13C11.49,16.15 11.42,16.33 11.35,16.53C11.17,17.05 11.09,17.86 11.16,18.43C11.19,18.68 11.2,18.9 11.2,18.9C11.19,18.91 11.13,18.77 11.08,18.57C10.72,17.42 10.82,16.43 11.41,15.27C11.72,14.65 12.18,13.9 12.24,13.9C12.25,13.9 12.25,13.97 12.24,14.07M7.14,18.02C7.3,18.08 7.55,18.19 7.71,18.27C8.2,18.51 9.2,19.24 8.92,19.14C8.52,19.01 7.92,18.84 7.53,18.75C7.01,18.63 5.72,18.56 5.4,18.63C5.25,18.66 5.4,18.68 6.06,18.71C6.96,18.75 7.64,18.86 8.4,19.1C8.81,19.23 9.09,19.38 8.79,19.3C8.71,19.29 8.24,19.31 7.75,19.35C6.61,19.45 5.71,19.45 5.17,19.35C4.93,19.3 4.34,19.13 3.86,18.97C3,18.69 2.98,18.68 3.19,18.64C3.3,18.62 3.78,18.47 4.25,18.32C4.72,18.16 5.26,18 5.44,17.96C5.89,17.85 6.76,17.89 7.14,18.02Z"/></svg>';

  function renderMenuScreen() {
    screenHeader("menu-header", {
      back: function () { showScreen("home"); },
      title: "",
      center: true,
      right: { icon: ICON_SLIDERS, label: t("menu.sort"), onClick: function () { toast(t("menu.sortSoon")); } },
    });
    var root = document.getElementById("menu-root");
    root.innerHTML = "";
    var data = state.menu;

    if (!data.published) {
      root.appendChild(menuStateBlock(ICON_LEAF, t("menu.soonTitle"), t("menu.soonText")));
      return;
    }

    // Приём после отсечки больше не блокирует весь экран — карточки всё
    // равно показываются (можно посмотреть состав на завтра), просто у
    // каждой вместо кнопки "Добавить в заказ" мягкая пометка о закрытом
    // приёме (см. buildMenuSetCard: canOrderNow()).
    var hero = el("div", "menu-hero");
    hero.appendChild(el("h1", "menu-hero-title", escapeHtml(t("menu.title"))));
    hero.appendChild(el("p", "menu-hero-sub", escapeHtml(t("menu.hero"))));
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
    var allChip = el("button", "filter-chip" + (state.menuCategory === "all" ? " active" : ""), t("menu.all"));
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
      root.appendChild(el("div", "menu-state", "<p>" + t("menu.emptyCategory") + "</p>"));
      return;
    }
    var grid = el("div", "menu-set-grid");
    sets.forEach(function (s) { grid.appendChild(buildMenuSetCard(s, true)); });
    root.appendChild(grid);
  }

  var ICON_CHEVRON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M9 6l6 6-6 6"/></svg>';

  // Карточка блюда — сворачиваемая прямо в списке (Меню/Главная/Избранное):
  // свёрнутая — миниатюра слева, название+стрелка, буллеты состава, цена;
  // по тапу фото переезжает наверх на всю ширину и под ним раскрывается
  // весь состав, выбор гарнира/варианта, счётчик количества и кнопка
  // "Добавить в заказ" (см. ТЗ — плавающая корзина ниже). Своё локальное
  // состояние (что выбрано, развёрнута ли) живёт в замыкании — у каждой
  // карточки отдельный экземпляр, поэтому Главная/Меню/Избранное не мешают
  // друг другу, даже отображая один и тот же сет одновременно.
  function buildMenuSetCard(s, wide) {
    var card = el("div", "card menu-set-card" + (wide ? " menu-wide-card" : ""));
    var expanded = false;
    var sel = { variantIdx: 0, garnish: "", garnishPicks: [], qty: 1 };
    var localizedName = localizedSetName(s.display_name);

    // Гарнир можно смешать (как в самом боте — см. handlers/order.py:
    // chosen_garnish_mix1/2) — до двух чипов, порядок выбора не важен,
    // итог "a/b 50/50" (сырые значения, не отображаемый текст — так же,
    // как и одиночный гарнир, см. texts.display_garnish для рендера).
    function pickGarnish(value) {
      var picks = sel.garnishPicks;
      var idx = picks.indexOf(value);
      if (idx !== -1) {
        picks.splice(idx, 1);
      } else {
        picks.push(value);
        if (picks.length > 2) picks.shift();
      }
      sel.garnish = picks.length === 2 ? (picks[0] + "/" + picks[1] + " 50/50") : (picks[0] || "");
    }

    function currentEffSet() {
      if (!s.is_variant_group) {
        return {
          key: s.key, display_name: localizedName, price: s.price,
          has_garnish: s.has_garnish, garnish_options: s.garnish_options,
        };
      }
      var v = s.variants[sel.variantIdx] || s.variants[0];
      return {
        key: v.technical, display_name: localizedName + " · " + localizedVariantLabel(v.label), price: v.price,
        has_garnish: v.has_garnish, garnish_options: v.garnish_options,
      };
    }

    function canOrderNow() {
      return !state.menu || state.menu.can_order !== false;
    }

    // Цена, выбор варианта/гарнира, количество и "Добавить" — общий блок для
    // обычной (render) и широкой (renderDetails) карточки.
    function appendSelectors(body, rerender) {
      var effSet = currentEffSet();
      body.appendChild(el("div", "menu-set-card-price", fmtSum(effSet.price)));

      if (s.is_variant_group) {
        var variantRow = el("div", "menu-set-chip-row");
        variantRow.addEventListener("click", function (e) { e.stopPropagation(); });
        s.variants.forEach(function (v, idx) {
          var chip = el("button", "menu-set-chip" + (sel.variantIdx === idx ? " active" : ""), escapeHtml(localizedVariantLabel(v.label)));
          chip.addEventListener("click", function () { sel.variantIdx = idx; sel.garnish = ""; sel.garnishPicks = []; rerender(); });
          variantRow.appendChild(chip);
        });
        body.appendChild(variantRow);
      }

      if (effSet.has_garnish && effSet.garnish_options.length) {
        var canMix = effSet.garnish_options.length >= 2;
        if (canMix) {
          body.appendChild(el("div", "menu-set-card-note", t("menu.garnishMixHint")));
        }
        var garnishRow = el("div", "menu-set-chip-row");
        garnishRow.addEventListener("click", function (e) { e.stopPropagation(); });
        effSet.garnish_options.forEach(function (g) {
          var picked = sel.garnishPicks.indexOf(g.value) !== -1;
          var chip = el("button", "menu-set-chip" + (picked ? " active" : ""), escapeHtml(g.display));
          chip.addEventListener("click", function () {
            if (!canMix) { sel.garnish = picked ? "" : g.value; sel.garnishPicks = picked ? [] : [g.value]; }
            else pickGarnish(g.value);
            rerender();
          });
          garnishRow.appendChild(chip);
        });
        body.appendChild(garnishRow);
        if (sel.garnishPicks.length === 2) {
          body.appendChild(el("div", "menu-set-card-note", "🔀 " + t("menu.garnishMixed", { text: displayGarnishText(sel.garnish) })));
        }
      }

      if (!canOrderNow()) {
        body.appendChild(el("div", "menu-set-closed-note", t("menu.orderClosedNote")));
      } else {
        var qtyRow = el("div", "menu-set-qty-row");
        qtyRow.addEventListener("click", function (e) { e.stopPropagation(); });
        var minus = el("button", "menu-set-qty-btn", "–");
        var value = el("div", "menu-set-qty-value", String(sel.qty));
        var plus = el("button", "menu-set-qty-btn", "+");
        minus.addEventListener("click", function () { if (sel.qty > 1) { sel.qty--; value.textContent = sel.qty; haptic(); } });
        plus.addEventListener("click", function () { sel.qty++; value.textContent = sel.qty; haptic(); });
        qtyRow.appendChild(minus); qtyRow.appendChild(value); qtyRow.appendChild(plus);
        body.appendChild(qtyRow);

        var addBtnWrap = el("div", "menu-set-add-wrap");
        addBtnWrap.addEventListener("click", function (e) { e.stopPropagation(); });
        var addBtn = el("button", "btn-primary", t("menu.addToCart"));
        addBtn.addEventListener("click", function () {
          if (effSet.has_garnish && effSet.garnish_options.length && !sel.garnish) { toast(t("menu.pickGarnishFirst")); return; }
          addToCart(effSet, sel);
          haptic("success");
          toast(t("menu.addedToCart"));
          // Карточка остаётся раскрытой (можно сразу добавить ещё одну
          // порцию с другим гарниром) — сбрасываем только сам выбор.
          sel = { variantIdx: 0, garnish: "", garnishPicks: [], qty: 1 };
          rerender();
        });
        addBtnWrap.appendChild(addBtn);
        body.appendChild(addBtnWrap);
      }

    }

    // --- Широкая карточка меню: фото сверху, название+цена и "+" под ним;
    // по тапу вниз плавно раскрывается состав и выбор (grid-rows анимация).
    function buildWide() {
      var photo = el("div", "menu-wide-photo");
      if (s.photo_url) {
        var img = el("img");
        img.alt = ""; img.loading = "lazy";
        img.addEventListener("error", function () { img.remove(); photo.classList.add("empty"); photo.innerHTML = ICON_LEAF; });
        setPhotoSrc(img, s.photo_url);
        photo.appendChild(img);
      } else {
        photo.classList.add("empty");
        photo.innerHTML = ICON_LEAF;
      }
      card.appendChild(photo);

      var foot = el("div", "menu-wide-foot");
      var info = el("div", "menu-wide-info");
      info.appendChild(el("div", "menu-wide-name", escapeHtml(localizedName)));
      var priceText = s.is_variant_group
        ? t("menu.from", { sum: fmtSum(Math.min.apply(null, s.variants.map(function (v) { return v.price; }))) })
        : fmtSum(s.price);
      info.appendChild(el("div", "menu-wide-price", priceText));
      foot.appendChild(info);
      var plus = el("div", "menu-wide-plus", "+");
      foot.appendChild(plus);
      card.appendChild(foot);

      var details = el("div", "menu-wide-details");
      var inner = el("div", "menu-wide-inner");
      details.appendChild(inner);
      card.appendChild(details);

      function renderDetails() {
        inner.innerHTML = "";
        var favBtn = el("button", "menu-set-fav-btn menu-wide-fav", ICON_HEART);
        ensureFavoriteKeys().then(function (keys) {
          favBtn.classList.toggle("active", keys.has(s.key));
          favBtn.innerHTML = keys.has(s.key) ? ICON_HEART_FILLED : ICON_HEART;
        });
        favBtn.addEventListener("click", function () {
          favBtn.disabled = true;
          toggleFavorite(s.key).then(function (favorited) {
            favBtn.disabled = false;
            favBtn.classList.toggle("active", favorited);
            favBtn.innerHTML = favorited ? ICON_HEART_FILLED : ICON_HEART;
            haptic("success");
            toast(favorited ? t("menu.favAdded") : t("menu.favRemoved"));
          }).catch(function (err) {
            favBtn.disabled = false;
            toast(t("menu.favFailed", { msg: err.message }));
          });
        });
        inner.appendChild(favBtn);
        if (s.description && s.description.length) {
          var list = el("ul", "menu-set-card-desc");
          s.description.forEach(function (line) { list.appendChild(el("li", null, escapeHtml(line))); });
          inner.appendChild(list);
        }
        appendSelectors(inner, renderDetails);
      }
      inner.addEventListener("click", function (e) { e.stopPropagation(); });

      foot.addEventListener("click", toggle);
      photo.addEventListener("click", toggle);
      function toggle() {
        haptic("select");
        expanded = !expanded;
        if (expanded) renderDetails();
        card.classList.toggle("expanded", expanded);
      }
    }

    function render() {
      card.innerHTML = "";
      card.onclick = null;
      card.classList.toggle("expanded", expanded);

      if (s.photo_url) {
        var img = el("img", "menu-set-thumb");
        img.alt = "";
        img.loading = "lazy";
        img.addEventListener("error", function () { img.remove(); });
        setPhotoSrc(img, s.photo_url);
        card.appendChild(img);
      } else {
        card.appendChild(el("div", "menu-set-thumb menu-set-thumb-empty", ICON_LEAF));
      }

      var body = el("div", "menu-set-card-body");
      var head = el("div", "menu-set-card-head");
      head.appendChild(el("div", "menu-set-card-name", escapeHtml(localizedName)));

      if (expanded) {
        var favBtn = el("button", "menu-set-fav-btn", ICON_HEART);
        ensureFavoriteKeys().then(function (keys) {
          favBtn.classList.toggle("active", keys.has(s.key));
          favBtn.innerHTML = keys.has(s.key) ? ICON_HEART_FILLED : ICON_HEART;
        });
        favBtn.addEventListener("click", function (e) {
          e.stopPropagation();
          favBtn.disabled = true;
          toggleFavorite(s.key).then(function (favorited) {
            favBtn.disabled = false;
            favBtn.classList.toggle("active", favorited);
            favBtn.innerHTML = favorited ? ICON_HEART_FILLED : ICON_HEART;
            haptic("success");
            toast(favorited ? t("menu.favAdded") : t("menu.favRemoved"));
          }).catch(function (err) {
            favBtn.disabled = false;
            toast(t("menu.favFailed", { msg: err.message }));
          });
        });
        head.appendChild(favBtn);
      }
      head.appendChild(el("div", "menu-set-card-chevron" + (expanded ? " up" : ""), ICON_CHEVRON));
      body.appendChild(head);

      if (s.description && s.description.length && expanded) {
        var list = el("ul", "menu-set-card-desc");
        s.description.forEach(function (line) { list.appendChild(el("li", null, escapeHtml(line))); });
        body.appendChild(list);
      }

      if (!expanded) {
        var foot = el("div", "menu-set-card-foot");
        if (s.is_variant_group) {
          var minP = Math.min.apply(null, s.variants.map(function (v) { return v.price; }));
          foot.appendChild(el("div", "menu-set-card-price", t("menu.from", { sum: fmtSum(minP) })));
        } else {
          foot.appendChild(el("div", "menu-set-card-price", fmtSum(s.price)));
          if (s.has_garnish) foot.appendChild(el("span", "menu-set-card-pill", escapeHtml(t("menu.withGarnish"))));
        }
        body.appendChild(foot);
        card.appendChild(body);
        // Состав — отдельным блоком под фото и заголовком, на всю ширину
        // карточки: каждая строка начинается с левого края, а размер фото
        // от числа строк не зависит.
        if (s.description && s.description.length) {
          var fullList = el("ul", "menu-set-card-desc menu-set-card-list");
          s.description.forEach(function (line) { fullList.appendChild(el("li", null, escapeHtml(line))); });
          card.appendChild(fullList);
        }
        card.onclick = function () { haptic("select"); expanded = true; render(); };
        return;
      }

      // --- развёрнутое состояние ---
      // Сворачивание — по клику в ЛЮБОМ пустом месте карточки (фото,
      // описание, цена, поля вокруг кнопок), см. card.onclick ниже. Сами
      // интерактивные зоны (варианты/гарнир/счётчик/кнопка "Добавить")
      // останавливают всплытие на уровне СТРОКИ целиком (не только
      // отдельной кнопки) — иначе промах на пару пикселей мимо кнопки, но
      // внутри её ряда, всё равно схлопывал бы карточку. Важно также: при
      // пересборке card.innerHTML изнутри обработчика клика по вложенному
      // элементу card получает НОВЫЙ card.onclick ещё до того, как текущий
      // клик закончил всплытие — без stopPropagation тот же клик долетает
      // до card и немедленно отменяет то, что только что сделал обработчик
      // (поймано и подтверждено тестом на кнопке "Добавить").
      card.onclick = function () { haptic("select"); expanded = false; render(); };

      appendSelectors(body, render);
      card.appendChild(body);
    }

    if (wide) buildWide(); else render();
    return card;
  }

  function escapeHtml(s) {
    var d = document.createElement("div");
    d.textContent = s;
    return d.innerHTML;
  }

  // -------------------------------------------------------------------
  // PAUSE CLUB — лента
  // -------------------------------------------------------------------

  function feedTypeLabel(type) { return t("feed.type." + type); }
  // Картинки ленты (и, ниже, аватарки в таблице лидеров Pause Club) идут
  // через свой прокси-эндпоинт, который требует ту же подпись initData,
  // что и остальные запросы (см. pauseapp.py: admin_auth_middleware — гейт
  // на КАЖДЫЙ /api/*, без исключений). Обычный <img src="..."> заголовков
  // не шлёт, поэтому картинку сначала тянем сами через fetch() с
  // заголовком и превращаем в blob-URL — простое кэширование в памяти по
  // URL, чтобы при повторном рендере не качать те же файлы заново (общий
  // кэш для любых авторизованных картинок, не только ленты).
  var _authedImageCache = {};
  function fetchAuthedImageBlobUrl(url) {
    if (!_authedImageCache[url]) {
      _authedImageCache[url] = fetch(url, { headers: { "X-Telegram-Init-Data": initData() } })
        .then(function (resp) { if (!resp.ok) throw new Error("HTTP " + resp.status); return resp.blob(); })
        .then(function (blob) { return URL.createObjectURL(blob); });
    }
    return _authedImageCache[url];
  }
  function loadFeedImage(url, imgEl) {
    fetchAuthedImageBlobUrl(url).then(function (blobUrl) { imgEl.src = blobUrl; }).catch(function () { imgEl.style.display = "none"; });
  }

  // Фото блюд (карточка Меню/Избранного, детальный экран) приходят двумя
  // видами: либо обычная публичная ссылка, вписанная вручную в таблицу
  // (grep pauseapp.py:_resolve_photo_url — тогда она начинается с
  // http(s), обычный <img src> подходит), либо тот же самый защищённый
  // прокси, что и у фото ленты (загружено через /admin → "🖼 Фото блюд" —
  // относительный путь вида "/pauseapp/api/feed/image/{file_id}", тоже за
  // admin_auth_middleware, нужен loadFeedImage). Раньше здесь везде стоял
  // голый img.src — для внешних ссылок работало, а для нового прокси
  // молча падало на 401 и фото просто исчезало (см. отчёт пользователя).
  function setPhotoSrc(imgEl, url) {
    if (/^https?:\/\//.test(url)) {
      imgEl.src = url;
    } else {
      loadFeedImage(url, imgEl);
    }
  }

  function loadFeed() {
    api("/api/feed").then(function (data) {
      state.feed = data.posts;
      // Один и тот же /api/feed кормит два места — Послания (всегда
      // видимый экран, renderMessagesFeedScreen) и карточку "PAUSE
      // MOMENTS" в CLUB (только число постов на самой карточке, см.
      // renderClubNowCards — полный список строится заново только когда
      // карточку открывают, см. renderMomentsFeed).
      renderClubNowCards();
      renderMessagesFeedScreen();
    }).catch(function () {
      renderMessagesFeedScreen();
    });
  }

  // "Шапка" экрана PAUSE Club — большой заголовок + подзаголовок, карточка
  // статуса (как "PAUSE Select" на присланном макете, только с нашими
  // реальными статусами из профиля) и ряд из 3 плашек-ссылок. По прямой
  // просьбе: тот же шрифт/вид, что на макете, но без листика над
  // заголовком. Старую простую шапку (screenHeader с "Ещё") заменяет
  // целиком — "Ещё" там всё равно вела только в toast-заглушку.
  var ICON_CLUB_CALENDAR = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" width="20" height="20" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M3.5 9.5h17M8 3v4M16 3v4"/></svg>';

  function renderClubSelectCard(p) {
    var c = p.club;
    var orderCount = p.order_count || 0;
    var left = c.left || 0;
    var total = orderCount + left;
    var pct = left > 0 && total > 0 ? Math.min(100, Math.round((orderCount / total) * 100)) : 100;
    var subText = left > 0 ? t("club.hero.toNextLevel", { left: left }) : t("club.hero.topLevel");
    var card = el("div", "card club-select-card");
    card.innerHTML =
      '<div class="club-select-head">' +
        '<span class="club-select-icon">' + clubLevelIcon(c.key) + '</span>' +
        '<div class="club-select-info">' +
          '<div class="club-select-name">' + escapeHtml(clubLevelLabel(c.key, c.label)) + '</div>' +
          '<div class="club-select-sub">' + escapeHtml(subText) + '</div>' +
        '</div>' +
        '<span class="club-select-chevron">' + ICON_CHEVRON + '</span>' +
      '</div>' +
      '<div class="club-select-progress">' +
        '<div class="club-select-progress-track"><div class="club-select-progress-fill" style="width:' + pct + '%"></div></div>' +
        '<span class="club-select-progress-num">' + orderCount + (left > 0 ? " / " + total : "") + '</span>' +
      '</div>';
    card.addEventListener("click", function () {
      haptic("select");
      openProfileSubscreen(t("profile.clubTitle"), function (sub) { renderClubLevelsScreen(sub, p); }, true);
    });
    return card;
  }

  function renderClubTileRow() {
    var row = el("div", "club-tile-row");

    // "Розыгрыш" — своего отдельного экрана пока нет, виджет уже и так
    // рисуется ниже на этом же экране (см. #club-giveaway) — тап просто
    // прокручивает к нему, ничего нового строить не пришлось.
    var giveawayTile = el("button", "club-tile");
    giveawayTile.innerHTML = ICON_OPS_GIVEAWAY + "<span>" + escapeHtml(t("feed.type.giveaway")) + "</span>";
    giveawayTile.addEventListener("click", function () {
      haptic("select");
      var target = document.getElementById("club-giveaway");
      if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    row.appendChild(giveawayTile);

    // "Ближайшие события" и "PAUSE Care" — по макету, самих этих разделов
    // ещё нет (отдельная задача позже) — пока просто заглушка, тем же
    // способом, что и остальные "скоро" в приложении.
    var eventsTile = el("button", "club-tile");
    eventsTile.innerHTML = ICON_CLUB_CALENDAR + "<span>" + escapeHtml(t("club.tile.events")) + "</span>";
    eventsTile.addEventListener("click", function () { haptic("select"); toast(t("club.moreSoon")); });
    row.appendChild(eventsTile);

    var careTile = el("button", "club-tile");
    careTile.innerHTML = ICON_HEART + "<span>" + escapeHtml(t("club.tile.care")) + "</span>";
    careTile.addEventListener("click", function () { haptic("select"); toast(t("club.moreSoon")); });
    row.appendChild(careTile);

    return row;
  }

  function renderClubHero() {
    var root = document.getElementById("club-header");
    root.innerHTML = "";
    var hero = el("div", "club-hero");
    hero.innerHTML =
      '<div class="club-hero-leaf">' + ICON_LEAF + '</div>' +
      '<div class="club-hero-title">' + escapeHtml(t("club.title")).toUpperCase() + '</div>' +
      '<div class="club-hero-subtitle">' + escapeHtml(t("club.hero.subtitle1")) + '<br>' + escapeHtml(t("club.hero.subtitle2")) + '</div>';
    root.appendChild(hero);

    if (state.profile && state.profile.club) {
      root.appendChild(renderClubSelectCard(state.profile));
    }
    root.appendChild(renderClubTileRow());
    // "Сейчас в клубе" — дальше по прежнему идёт то, что уже было
    // (розыгрыш/рейтинг/лента), карточки-карусель с макета сюда ещё не
    // делаем (прямая просьба — "дойди до этого момента").
    root.appendChild(el("h3", "club-now-heading", t("club.nowHeading")));
  }

  // -------------------------------------------------------------------
  // PAUSE MOMENTS — стена постов клиентов (в духе Threads/ВК): аватарка,
  // имя, время, текст и/или фото, комментарии. Свои листы "Моменты" /
  // "Моменты комментарии" (см. sheets.get_moments), старая "Лента" живёт
  // только для вкладки "Послания". Публиковать и комментировать может
  // любой зарегистрированный клиент, удалять — только админ.
  // -------------------------------------------------------------------

  var ICON_MOM_COMMENT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" width="19" height="19" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.5 8.5 0 0 1-12.4 7.6L3 20.5l1.5-5A8.5 8.5 0 1 1 21 11.5z"/></svg>';
  var ICON_MOM_HEART = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" width="19" height="19" stroke-linecap="round" stroke-linejoin="round"><path d="M20.8 5.6a5 5 0 0 0-7.1 0L12 7.3l-1.7-1.7a5 5 0 0 0-7.1 7.1l1.7 1.7L12 21.5l7.1-7.1 1.7-1.7a5 5 0 0 0 0-7.1z"/></svg>';
  var ICON_MOM_IMAGE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" width="22" height="22" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="9" cy="10" r="1.8"/><path d="M21 16l-5-5-8 9"/></svg>';
  var ICON_MOM_SEND = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>';
  var MOM_MAX_PHOTOS = 4;
  var MOM_MAX_TEXT = 2000;

  function isAnyAdmin() { return !!(state.isMainAdmin || state.paFinance || state.paDebtors || state.paMenu); }
  function momCanWrite() { return !state.profile || state.profile.registered !== false; }
  function momMyName() { return (state.profile && state.profile.name) || ""; }
  function momMyId() { return state.myTgId || (state.profile && state.profile.tg_id) || ""; }

  function momAgo(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    var s = Math.round((Date.now() - d.getTime()) / 1000);
    if (s < 60) return t("mom.justNow");
    var lang = state.lang === "uz" ? "uz" : (state.lang === "en" ? "en" : "ru");
    try {
      var rtf = new Intl.RelativeTimeFormat(lang, { numeric: "auto", style: "short" });
      if (s < 3600) return rtf.format(-Math.floor(s / 60), "minute");
      if (s < 86400) return rtf.format(-Math.floor(s / 3600), "hour");
      if (s < 86400 * 7) return rtf.format(-Math.floor(s / 86400), "day");
    } catch (e) {}
    return d.toLocaleDateString(lang, { day: "numeric", month: "short" });
  }

  function momErrText(err) {
    if (err && err.code === "not_registered") return t("mom.registerFirst");
    return (err && err.message) || "";
  }

  function momAvatar(tgId, name, small) {
    var w = el("div", "mom-av" + (small ? " sm" : ""));
    w.appendChild(buildLeaderboardAvatar(tgId, name));
    return w;
  }

  // Уменьшаем фото перед отправкой (телефонные снимки по 5-10 МБ грузились
  // бы очень долго): длинная сторона до 1600 px, JPEG.
  function momDownscale(file) {
    return new Promise(function (resolve) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        var max = 1600, w = img.naturalWidth, h = img.naturalHeight;
        var k = Math.min(1, max / Math.max(w, h));
        if (k === 1 && file.size < 900 * 1024) { URL.revokeObjectURL(url); resolve(file); return; }
        var cv = document.createElement("canvas");
        cv.width = Math.round(w * k); cv.height = Math.round(h * k);
        cv.getContext("2d").drawImage(img, 0, 0, cv.width, cv.height);
        URL.revokeObjectURL(url);
        cv.toBlob(function (blob) { resolve(blob || file); }, "image/jpeg", 0.86);
      };
      img.onerror = function () { URL.revokeObjectURL(url); resolve(file); };
      img.src = url;
    });
  }

  function openMomPhotoViewer(url) {
    var ov = el("div", "mom-viewer");
    var img = el("img");
    img.alt = "";
    setPhotoSrc(img, url);
    ov.appendChild(img);
    ov.addEventListener("click", function () { ov.remove(); });
    document.body.appendChild(ov);
  }

  function buildMomPhotos(urls) {
    var wrap = el("div", "mom-photos n" + Math.min(urls.length, 4));
    urls.forEach(function (u) {
      var img = el("img");
      img.alt = "";
      setPhotoSrc(img, u);
      img.addEventListener("click", function (e) { e.stopPropagation(); haptic("select"); openMomPhotoViewer(u); });
      wrap.appendChild(img);
    });
    return wrap;
  }

  function momDeleteBtn(onClick) {
    var b = el("button", "mom-del", ICON_TRASH);
    b.setAttribute("aria-label", t("mom.delete"));
    b.addEventListener("click", function (e) { e.stopPropagation(); onClick(); });
    return b;
  }

  function buildMomentPost(post, onOpen, onDeleted) {
    var row = el("div", "mom-post" + (onOpen ? " tappable" : ""));
    row.appendChild(momAvatar(post.tg_id, post.name));
    var main = el("div", "mom-main");
    var head = el("div", "mom-head");
    head.appendChild(el("span", "mom-name", escapeHtml(post.name || t("profile.noName"))));
    head.appendChild(el("span", "mom-time", escapeHtml(momAgo(post.ts))));
    if (isAnyAdmin()) {
      head.appendChild(momDeleteBtn(function () {
        showConfirm(t("mom.deleteConfirm"), t("mom.delete"), function () {
          api("/api/moments/delete", { method: "POST", body: { id: post.id } }).then(function () {
            haptic("success");
            state.moments = (state.moments || []).filter(function (p) { return p.id !== post.id; });
            renderClubNowCards();
            toast(t("mom.deleted"));
            if (onDeleted) onDeleted();
          }).catch(function (err) { toast(momErrText(err)); });
        });
      }));
    }
    main.appendChild(head);
    if (post.text) main.appendChild(el("div", "mom-text", escapeHtml(post.text)));
    if ((post.image_urls || []).length) main.appendChild(buildMomPhotos(post.image_urls));
    var acts = el("div", "mom-actions");
    var likeBtn = el("button", "mom-act mom-like" + (post.liked ? " liked" : ""));
    function drawLike() {
      likeBtn.classList.toggle("liked", !!post.liked);
      likeBtn.innerHTML = ICON_MOM_HEART + (post.like_count ? '<b>' + post.like_count + '</b>' : "");
    }
    drawLike();
    likeBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      haptic("select");
      // сразу меняем на экране, сервер подтвердит точным числом
      post.liked = !post.liked;
      post.like_count = Math.max(0, (post.like_count || 0) + (post.liked ? 1 : -1));
      drawLike();
      api("/api/moments/" + encodeURIComponent(post.id) + "/like", { method: "POST", body: {} }).then(function (res) {
        post.liked = res.liked; post.like_count = res.like_count; drawLike();
      }).catch(function (err) {
        post.liked = !post.liked;
        post.like_count = Math.max(0, (post.like_count || 0) + (post.liked ? 1 : -1));
        drawLike();
        toast(momErrText(err));
      });
    });
    acts.appendChild(likeBtn);
    acts.appendChild(el("span", "mom-act", ICON_MOM_COMMENT + (post.comment_count ? '<b>' + post.comment_count + '</b>' : "")));
    main.appendChild(acts);
    row.appendChild(main);
    if (onOpen) row.addEventListener("click", function () { haptic("select"); onOpen(post); });
    return row;
  }

  function loadMoments(onDone) {
    api("/api/moments").then(function (data) {
      state.moments = data.posts || [];
      renderClubNowCards();
      if (onDone) onDone(true);
    }).catch(function () { if (onDone) onDone(false); });
  }

  function openClubMoments() {
    haptic("select");
    openWizard(function (body) { renderMomentsFeed(body); });
  }

  function renderMomentsFeed(body) {
    wizardPhaseEl.innerHTML = "";
    document.getElementById("wizard").classList.add("wizard-white");
    body.appendChild(el("h2", "wizard-title club-serif", escapeHtml(t("club.moments.eyebrow"))));

    if (momCanWrite()) {
      var composer = el("div", "mom-composer");
      composer.appendChild(momAvatar(momMyId(), momMyName(), true));
      composer.appendChild(el("span", "mom-composer-ph", escapeHtml(t("mom.placeholder"))));
      composer.appendChild(el("span", "mom-composer-ic", ICON_MOM_IMAGE));
      composer.addEventListener("click", function () { haptic("select"); wizardStep(renderMomentCompose); });
      body.appendChild(composer);
    } else {
      body.appendChild(el("div", "mom-note", escapeHtml(t("mom.registerFirst"))));
    }

    var list = el("div", "mom-list");
    body.appendChild(list);
    var stillHere = function () { return document.body.contains(list); };

    function draw() {
      list.innerHTML = "";
      var posts = state.moments;
      if (!posts) { list.appendChild(el("div", "skeleton-block")); return; }
      if (!posts.length) {
        list.appendChild(el("div", "feed-empty", "<div>" + ICON_LEAF + "</div><p>" + escapeHtml(t("mom.empty")) + "</p>"));
        return;
      }
      posts.forEach(function (p) {
        list.appendChild(buildMomentPost(p, function (post) {
          wizardStep(function (b) { renderMomentDetail(b, post.id); });
        }, draw));
      });
    }
    draw();
    loadMoments(function (ok) {
      if (!stillHere()) return;
      if (ok) draw();
      else if (!state.moments) { list.innerHTML = ""; list.appendChild(el("div", "empty-note", escapeHtml(t("mom.loadFailed")))); }
    });
  }

  function renderMomentCompose(body) {
    wizardPhaseEl.innerHTML = "";
    document.getElementById("wizard").classList.add("wizard-white");
    var files = [];
    var head = el("div", "mom-compose-head");
    head.appendChild(momAvatar(momMyId(), momMyName()));
    head.appendChild(el("div", "mom-name", escapeHtml(momMyName() || t("profile.noName"))));
    body.appendChild(head);

    var ta = el("textarea", "mom-compose-text");
    ta.placeholder = t("mom.placeholder");
    ta.maxLength = MOM_MAX_TEXT;
    ta.rows = 5;
    body.appendChild(ta);
    function autosize() { ta.style.height = "auto"; ta.style.height = Math.max(120, ta.scrollHeight) + "px"; }

    var thumbs = el("div", "mom-thumbs");
    body.appendChild(thumbs);

    var bar = el("div", "mom-compose-bar");
    var input = el("input");
    input.type = "file"; input.accept = "image/*"; input.multiple = true; input.style.display = "none";
    var addBtn = el("button", "mom-add-photo", ICON_MOM_IMAGE + '<span>' + escapeHtml(t("mom.addPhoto")) + '</span>');
    addBtn.addEventListener("click", function () { input.click(); });
    var counter = el("span", "mom-counter");
    var publish = el("button", "mom-publish", escapeHtml(t("mom.publish")));
    bar.appendChild(addBtn); bar.appendChild(counter); bar.appendChild(publish); bar.appendChild(input);
    body.appendChild(bar);

    function sync() {
      var len = ta.value.length;
      counter.textContent = len > MOM_MAX_TEXT * 0.8 ? (len + "/" + MOM_MAX_TEXT) : (files.length ? files.length + "/" + MOM_MAX_PHOTOS : "");
      publish.disabled = !(ta.value.trim() || files.length);
      addBtn.disabled = files.length >= MOM_MAX_PHOTOS;
    }
    function drawThumbs() {
      thumbs.innerHTML = "";
      files.forEach(function (f, i) {
        var w = el("div", "mom-thumb");
        var img = el("img");
        img.alt = "";
        img.src = URL.createObjectURL(f);
        var x = el("button", "mom-thumb-x", "×");
        x.addEventListener("click", function () { files.splice(i, 1); drawThumbs(); sync(); });
        w.appendChild(img); w.appendChild(x);
        thumbs.appendChild(w);
      });
    }
    input.addEventListener("change", function () {
      Array.prototype.slice.call(input.files || []).forEach(function (f) {
        if (files.length < MOM_MAX_PHOTOS) files.push(f); else toast(t("mom.photosMax", { n: MOM_MAX_PHOTOS }));
      });
      input.value = "";
      drawThumbs(); sync();
    });
    ta.addEventListener("input", function () { autosize(); sync(); });
    sync();

    publish.addEventListener("click", function () {
      publish.disabled = true;
      publish.textContent = t("mom.publishing");
      Promise.all(files.map(momDownscale)).then(function (blobs) {
        var fd = new FormData();
        fd.append("text", ta.value.trim());
        blobs.forEach(function (b, i) { fd.append("photo", b, "moment" + i + ".jpg"); });
        return fetch(API_BASE + "/api/moments", { method: "POST", headers: { "X-Telegram-Init-Data": initData() }, body: fd });
      }).then(function (resp) {
        return resp.json().catch(function () { return {}; }).then(function (data) {
          if (!resp.ok) { var e = new Error(data.error || ("HTTP " + resp.status)); e.code = data.error; throw e; }
          return data;
        });
      }).then(function (data) {
        haptic("success");
        toast(t("mom.published"));
        state.moments = [data.post].concat(state.moments || []);
        renderClubNowCards();
        wizardBack();
      }).catch(function (err) {
        publish.textContent = t("mom.publish");
        sync();
        toast(momErrText(err));
      });
    });
    setTimeout(function () { ta.focus(); }, 150);
  }

  function renderMomentDetail(body, postId) {
    wizardPhaseEl.innerHTML = "";
    document.getElementById("wizard").classList.add("wizard-white");
    var post = (state.moments || []).filter(function (p) { return p.id === postId; })[0];
    if (!post) { body.appendChild(el("div", "empty-note", escapeHtml(t("mom.loadFailed")))); return; }
    body.appendChild(buildMomentPost(post, null, function () { wizardBack(); }));
    body.appendChild(el("h3", "club-serif-h", escapeHtml(t("mom.comments"))));
    var list = el("div", "mom-comments");
    list.appendChild(el("div", "skeleton-block"));
    body.appendChild(list);

    var comments = null;
    function drawComments() {
      list.innerHTML = "";
      if (!comments.length) { list.appendChild(el("div", "mom-no-comments", escapeHtml(t("mom.noComments")))); return; }
      comments.forEach(function (c) {
        var row = el("div", "mom-comment");
        row.appendChild(momAvatar(c.tg_id, c.name, true));
        var main = el("div", "mom-main");
        var head = el("div", "mom-head");
        head.appendChild(el("span", "mom-name", escapeHtml(c.name || t("profile.noName"))));
        head.appendChild(el("span", "mom-time", escapeHtml(momAgo(c.ts))));
        if (isAnyAdmin()) {
          head.appendChild(momDeleteBtn(function () {
            showConfirm(t("mom.deleteCommentConfirm"), t("mom.delete"), function () {
              api("/api/moments/comments/delete", { method: "POST", body: { id: c.id } }).then(function () {
                comments = comments.filter(function (x) { return x.id !== c.id; });
                post.comment_count = comments.length;
                drawComments();
              }).catch(function (err) { toast(momErrText(err)); });
            });
          }));
        }
        main.appendChild(head);
        main.appendChild(el("div", "mom-text", escapeHtml(c.text)));
        row.appendChild(main);
        list.appendChild(row);
      });
    }
    api("/api/moments/" + encodeURIComponent(postId) + "/comments").then(function (data) {
      comments = data.comments || [];
      drawComments();
    }).catch(function () { list.innerHTML = ""; list.appendChild(el("div", "empty-note", escapeHtml(t("mom.loadFailed")))); });

    if (!momCanWrite()) { body.appendChild(el("div", "mom-note", escapeHtml(t("mom.registerFirst")))); return; }
    var bar = el("div", "mom-comment-bar");
    var input = el("input", "mom-comment-input");
    input.type = "text"; input.placeholder = t("mom.commentPh"); input.maxLength = 600;
    var send = el("button", "mom-comment-send", ICON_MOM_SEND);
    send.setAttribute("aria-label", t("mom.send"));
    function doSend() {
      var text = input.value.trim();
      if (!text || comments === null) return;
      send.disabled = true;
      api("/api/moments/" + encodeURIComponent(postId) + "/comments", { method: "POST", body: { text: text } }).then(function (data) {
        haptic("success");
        input.value = "";
        comments.push(data.comment);
        post.comment_count = comments.length;
        drawComments();
        send.disabled = false;
        input.focus();
      }).catch(function (err) { send.disabled = false; toast(momErrText(err)); });
    }
    send.addEventListener("click", doSend);
    input.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); doSend(); } });
    bar.appendChild(input); bar.appendChild(send);
    body.appendChild(bar);
  }

  // -------------------------------------------------------------------
  // Pause Club — таблица лидеров (топ-10 по числу заказов). Топ-3 всегда
  // на виду, места 4-10 — под разворачивающейся кнопкой (см.
  // state.leaderboardExpanded). Аватарка — реальное фото профиля
  // человека из Telegram (см. pauseapp.py: api_avatar_image), не своё —
  // поэтому тем же авторизованным прокси, что и картинки ленты
  // (fetchAuthedImageBlobUrl), с откатом на инициалы, если фото нет.
  // -------------------------------------------------------------------

  function buildLeaderboardAvatar(tgId, name) {
    var wrap = el("div", "leaderboard-avatar");
    var img = document.createElement("img");
    img.alt = "";
    wrap.appendChild(img);
    fetchAuthedImageBlobUrl("/pauseapp/api/avatar/" + encodeURIComponent(tgId))
      .then(function (blobUrl) { img.src = blobUrl; })
      .catch(function () {
        wrap.innerHTML = "";
        wrap.textContent = initials(name);
      });
    return wrap;
  }

  function lbIsMe(entry) {
    return !!(state.leaderboardMe && entry && String(entry.tg_id) === String(state.leaderboardMe.tg_id));
  }

  function buildLeaderboardRow(entry, rank) {
    var me = lbIsMe(entry);
    var row = el("div", "lb-row" + (me ? " me" : ""));
    row.appendChild(el("div", "lb-rank", String(rank)));
    row.appendChild(buildLeaderboardAvatar(entry.tg_id, entry.name));
    var info = el("div", "leaderboard-info");
    var nameHtml = escapeHtml(entry.name || t("profile.noName")) + (me ? ' <span class="lb-you">' + escapeHtml(t("club.lb.you")) + '</span>' : "");
    info.appendChild(el("div", "leaderboard-name", nameHtml));
    var clubLine = el("div", "leaderboard-club");
    clubLine.innerHTML = clubLevelIcon(entry.club.key) + "<span>" + escapeHtml(clubLevelLabel(entry.club.key, entry.club.label)) + "</span>";
    info.appendChild(clubLine);
    row.appendChild(info);
    var count = el("div", "leaderboard-count");
    count.innerHTML = '<div class="leaderboard-count-value">' + entry.order_count + '</div><div class="leaderboard-count-label">' + t("profile.statOrders") + '</div>';
    row.appendChild(count);
    return row;
  }

  // Пьедестал топ-3: по центру первое место (выше всех), слева второе,
  // справа третье. Только оттенки шалфейного цвета страницы Club — без
  // красного/цветных обводок.
  function buildLeaderboardPodium(entries) {
    var podium = el("div", "lb-podium");
    [1, 0, 2].forEach(function (idx) {
      var entry = entries[idx];
      if (!entry) return;
      var rank = idx + 1;
      var pod = el("div", "lb-pod lb-pod-" + rank + (lbIsMe(entry) ? " me" : ""));
      var av = el("div", "lb-pod-avatar");
      av.appendChild(buildLeaderboardAvatar(entry.tg_id, entry.name));
      av.appendChild(el("span", "lb-pod-medal", String(rank)));
      pod.appendChild(av);
      pod.appendChild(el("div", "lb-pod-name", escapeHtml(entry.name || t("profile.noName"))));
      pod.appendChild(el("div", "lb-pod-count", '<b>' + entry.order_count + '</b> ' + escapeHtml(t("profile.statOrders"))));
      pod.appendChild(el("div", "lb-pod-base", '<span>' + rank + '</span>'));
      podium.appendChild(pod);
    });
    return podium;
  }

  function buildLeaderboardMeBar() {
    var list = state.leaderboard || [];
    var me = state.leaderboardMe;
    if (me && me.rank <= list.length) return null; // уже в топе — строка подсвечена в списке
    var bar = el("div", "lb-me-bar");
    if (!me) {
      bar.classList.add("empty");
      bar.appendChild(el("div", "lb-me-note", escapeHtml(t("club.lb.noRank"))));
      return bar;
    }
    var row = el("div", "lb-me-row");
    row.appendChild(el("div", "lb-me-rank", "#" + me.rank));
    row.appendChild(buildLeaderboardAvatar(me.tg_id, me.name));
    var info = el("div", "leaderboard-info");
    info.appendChild(el("div", "leaderboard-name", escapeHtml(t("club.lb.you")) + (state.rankedTotal ? ' <span class="lb-me-of">' + escapeHtml(t("club.lb.of", { n: state.rankedTotal })) + '</span>' : "")));
    var tenth = list.length >= 10 ? list[9].order_count : 0;
    var gap = Math.max(1, tenth - me.order_count + 1);
    if (tenth) info.appendChild(el("div", "lb-me-gap", escapeHtml(t("club.lb.toTop", { n: gap, orders: t("profile.statOrders") }))));
    row.appendChild(info);
    row.appendChild(el("div", "lb-me-count", '<b>' + me.order_count + '</b><span>' + escapeHtml(t("profile.statOrders")) + '</span>'));
    bar.appendChild(row);
    return bar;
  }

  // root — контейнер открытого по тапу на карточку "Герои паузы" окна
  // (см. clubCardTapHandler). Заголовок рисует сам оверлей (serif).
  function renderClubLeaderboard(root) {
    root.innerHTML = "";
    var list = state.leaderboard || [];
    var page = el("div", "lb-page");
    root.appendChild(page);
    page.appendChild(el("div", "lb-subtitle", escapeHtml(t("club.lb.subtitle"))));
    if (!list.length) {
      page.appendChild(el("div", "empty-note", t("club.leaderboardEmpty")));
      return;
    }
    page.appendChild(buildLeaderboardPodium(list.slice(0, 3)));
    var rest = list.slice(3);
    if (rest.length) {
      var card = el("div", "lb-list");
      rest.forEach(function (entry, i) { card.appendChild(buildLeaderboardRow(entry, i + 4)); });
      page.appendChild(card);
    }
    var bar = buildLeaderboardMeBar();
    if (bar) page.appendChild(bar);
  }

  function loadClubLeaderboard() {
    api("/api/club/leaderboard").then(function (data) {
      state.leaderboard = data.leaderboard || [];
      state.totalClients = data.total_clients || 0;
      state.leaderboardMe = data.me || null;
      state.rankedTotal = data.ranked_total || 0;
      renderClubNowCards();
    }).catch(function () {
      // Карточка "Рейтинг" и так уже отрисована (с 0 человек при первой
      // загрузке) — отдельного сообщения об ошибке тут больше негде
      // показать, т.к. всегда видимого блока под рейтинг больше нет.
    });
  }

  // -------------------------------------------------------------------
  // Карточка "PAUSE DAY" под "Сейчас в клубе" (см. renderClubHero) — по
  // присланному макету: фон-"фото" (у нас пока декоративный градиент +
  // листик вместо настоящей фотографии — своей фотографии ещё нет),
  // эйбрау "PAUSE GIFT", тёплое описание, кнопка (чисто визуальная — вся
  // карточка кликабельна целиком) и строка статистики. Данные — те же
  // state.giveaway, что и у виджета ниже (#club-giveaway), поэтому
  // перерисовывается вместе с ним, см. renderClubGiveaway. Счётчик до
  // 12:00 — специально СТАТИЧНАЯ заглушка (прямая просьба: "визуально но
  // не рабочий"), никакого живого таймера здесь нет.
  // -------------------------------------------------------------------

  var ICON_PDAY_PEOPLE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" width="14" height="14" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3"/><path d="M3 19c0.8-3.2 2.9-4.8 6-4.8s5.2 1.6 6 4.8"/><circle cx="17.5" cy="8.5" r="2.3"/><path d="M15.8 14.4c2.4 0.3 3.9 1.8 4.6 4.6"/></svg>';
  var ICON_PDAY_CLOCK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" width="14" height="14" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5v5l3.2 2"/></svg>';

  // Карточки приходят с сервера (/api/club/cards, правятся в "Операционный
  // центр" → "Управление Pause Club"). Пока не загрузились — показываем
  // стандартный набор, чтобы экран не мигал пустым. У встроенных карточек
  // (kind != "custom") пустое текстовое поле = стандартный i18n-текст.
  var DEFAULT_CLUB_CARDS = [
    { id: "pday", kind: "pday", color: "green", carousel: true },
    { id: "biggift", kind: "biggift", color: "gold", carousel: true },
    { id: "top", kind: "top", color: "terracotta", carousel: false },
    { id: "moments", kind: "moments", color: "caramel", carousel: false },
  ];
  var CLUB_COLOR_LABELS = { green: "Зелёный", gold: "Золотой", terracotta: "Терракот", caramel: "Карамель" };
  var CLUB_COLOR_CLASS = { green: "", gold: " pday-card-biggift", terracotta: " pday-card-top", caramel: " pday-card-moments" };
  var CLUB_KIND_LABELS = { pday: "PAUSE DAY", biggift: "Большой приз месяца", top: "PAUSE TOP", moments: "PAUSE MOMENTS", custom: "Своя карточка" };

  function clubCardDefaultTexts(kind) {
    var names = (state.giveaway && state.giveaway.participant_names) || [];
    if (kind === "pday") return {
      eyebrow: t("feed.type.giveaway"), heading: t("club.pday.heading"), desc: t("club.pday.desc"), cta: t("club.pday.cta"),
      stat1: t("club.pday.participants", { count: names.length }), stat2: t("club.pday.countdownStub") };
    if (kind === "biggift") return {
      eyebrow: t("feed.type.giveaway"), heading: t("club.pdayBig.heading"), desc: t("club.pdayBig.desc"), cta: t("club.pday.cta"),
      stat1: t("club.pday.participants", { count: 0 }), stat2: t("club.pdayBig.daysStub", { days: 30 }) };
    if (kind === "top") return {
      eyebrow: t("club.top.eyebrow"), heading: t("club.top.heading"), desc: t("club.top.desc"), cta: t("club.top.cta"),
      stat1: t("club.top.peopleCount", { count: state.totalClients || 0 }), stat2: "" };
    if (kind === "moments") return {
      eyebrow: t("club.moments.eyebrow"), heading: t("club.moments.heading"), desc: t("club.moments.desc"), cta: t("club.moments.cta"),
      stat1: t("club.moments.count", { count: (state.moments || []).length }), stat2: "" };
    return { eyebrow: "", heading: "", desc: "", cta: "", stat1: "", stat2: "" };
  }

  // Что реально видно на карточке: свой текст админа, иначе стандартный.
  function clubCardTexts(c) {
    var d = clubCardDefaultTexts(c.kind);
    var out = {};
    ["eyebrow", "heading", "desc", "cta", "stat1", "stat2"].forEach(function (f) { out[f] = c[f] || d[f]; });
    return out;
  }

  function clubCardTapHandler(c, tx) {
    if (c.kind === "pday") return function () {
      openProfileSubscreen(tx.heading || tx.eyebrow, function (sub) {
        buildGiveawayPage(sub);
      }, true);
    };
    if (c.kind === "biggift") return function () {
      openProfileSubscreen(tx.eyebrow, function (sub) {
        sub.innerHTML = "";
        sub.appendChild(el("div", "feed-empty", "<div>" + ICON_LEAF + "</div><p>" + t("club.pdayBig.comingSoon") + "</p>"));
      }, true);
    };
    if (c.kind === "top") return function () {
      openProfileSubscreen(tx.heading || t("club.leaderboardTitle"), function (sub) {
        sub.innerHTML = "";
        renderClubLeaderboard(sub);
      }, true);
    };
    if (c.kind === "moments") return openClubMoments;
    // Своя карточка — простая страница: фото, заголовок, описание.
    return function () {
      openProfileSubscreen(tx.heading || tx.eyebrow || "PAUSE CLUB", function (sub) {
        sub.innerHTML = "";
        var page = el("div", "card");
        if (c.photo_url) {
          var img = el("img", "club-card-page-photo");
          img.alt = "";
          setPhotoSrc(img, c.photo_url);
          page.appendChild(img);
        }
        if (tx.heading) page.appendChild(el("h3", "club-card-page-title", escapeHtml(tx.heading)));
        if (tx.desc) page.appendChild(el("div", "club-card-page-desc", escapeHtml(tx.desc).replace(/\n/g, "<br>")));
        sub.appendChild(page);
      }, true);
    };
  }

  function buildClubCard(c) {
    var tx = clubCardTexts(c);
    var builtin = c.kind !== "custom";
    var card = el("div", "pday-card" + (CLUB_COLOR_CLASS[c.color] || ""));
    var html = "";
    if (c.photo_url) html += '<img class="pday-card-photo" alt=""><div class="pday-card-shade"></div>';
    else html += '<div class="pday-card-bg">' + ICON_LEAF + '</div>';
    html += '<div class="pday-card-content">';
    if (tx.eyebrow) html += '<div class="pday-card-eyebrow">' + escapeHtml(tx.eyebrow) + '</div>';
    if (tx.heading) html += '<div class="pday-card-heading">' + escapeHtml(tx.heading) + '</div>';
    if (tx.desc) html += '<div class="pday-card-desc">' + escapeHtml(tx.desc).replace(/\n/g, "<br>") + '</div>';
    if (tx.cta) html += '<div class="pday-card-btn">' + escapeHtml(tx.cta) + '</div>';
    if (tx.stat1 || tx.stat2) {
      html += '<div class="pday-card-stats">';
      if (tx.stat1) html += '<span>' + (builtin ? ICON_PDAY_PEOPLE : "") + escapeHtml(tx.stat1) + '</span>';
      if (tx.stat2) html += '<span>' + (builtin ? ICON_PDAY_CLOCK : "") + escapeHtml(tx.stat2) + '</span>';
      html += '</div>';
    }
    html += '</div>';
    card.innerHTML = html;
    if (c.photo_url) setPhotoSrc(card.querySelector(".pday-card-photo"), c.photo_url);
    var onTap = clubCardTapHandler(c, tx);
    card.addEventListener("click", function () { haptic("select"); onTap(); });
    return card;
  }

  // Соседние карточки с carousel=true собираются в одну карусель (нативный
  // scroll-snap, как "Мои послания"), остальные идут отдельными карточками.
  function buildClubCarousel(group) {
    var carousel = el("div", "pday-carousel");
    var track = el("div", "pday-carousel-track");
    var dots = el("div", "pday-carousel-dots");
    var dotEls = [];
    group.forEach(function (c, i) {
      var slide = el("div", "pday-carousel-slide");
      slide.appendChild(buildClubCard(c));
      track.appendChild(slide);
      var d = el("span", "pday-carousel-dot" + (i === 0 ? " active" : ""));
      dotEls.push(d);
      dots.appendChild(d);
    });
    carousel.appendChild(track);
    carousel.appendChild(dots);
    var timer = null;
    track.addEventListener("scroll", function () {
      if (timer) clearTimeout(timer);
      timer = setTimeout(function () {
        var idx = Math.round(track.scrollLeft / track.clientWidth);
        dotEls.forEach(function (d, i) { d.classList.toggle("active", i === idx); });
      }, 80);
    });
    return carousel;
  }

  function renderClubNowCards() {
    var root = document.getElementById("club-now-cards");
    if (!root) return;
    root.innerHTML = "";
    var cards = state.clubCards || DEFAULT_CLUB_CARDS;
    var i = 0;
    while (i < cards.length) {
      if (cards[i].carousel) {
        var group = [];
        while (i < cards.length && cards[i].carousel) group.push(cards[i++]);
        root.appendChild(group.length > 1 ? buildClubCarousel(group) : buildClubCard(group[0]));
      } else {
        root.appendChild(buildClubCard(cards[i++]));
      }
    }
  }

  function loadClubCards() {
    api("/api/club/cards").then(function (data) {
      state.clubCards = data.cards || [];
      renderClubNowCards();
      if (state.home && state.screen === "home") renderHomeScreen();
    }).catch(function () {});
  }

  // -------------------------------------------------------------------
  // "PAUSE DAY" — ежедневный розыгрыш, видимый ВСЕМ во вкладке
  // Pause Club (см. pauseapp.py: api_club_giveaway). Статус "Внутренний
  // круг" и выше даёт автодобавление в сегодняшний пул сразу после
  // заказа (см. _refresh_giveaway_state на сервере) — кому статус пока
  // не позволяет, просто видят, сколько заказов осталось набрать. После
  // розыгрыша в 12:00 пул закрывается, и вместо него все видят имя
  // победителя — так до следующей публикации меню (closed/winner_name
  // приходят с сервера уже готовыми, здесь только отображение).
  // -------------------------------------------------------------------

  // Секунд до ближайшего розыгрыша (HH:MM по Ташкенту — как на сервере).
  function secondsToDraw(drawTime) {
    var hm = String(drawTime || "12:00").split(":");
    var now = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Tashkent" }));
    var target = new Date(now.getTime());
    target.setHours(parseInt(hm[0], 10) || 0, parseInt(hm[1], 10) || 0, 0, 0);
    var diff = Math.round((target - now) / 1000);
    return diff > 0 ? diff : 0;
  }

  function fmtCountdown(sec) {
    function p(n) { return n < 10 ? "0" + n : "" + n; }
    return p(Math.floor(sec / 3600)) + ":" + p(Math.floor((sec % 3600) / 60)) + ":" + p(sec % 60);
  }

  // Страница по тапу на карточку PAUSE DAY: герой со статусом/таймером,
  // "ваш статус", как это работает, участники.
  function buildGiveawayPage(root) {
    root.innerHTML = "";
    var g = state.giveaway || {};
    var names = g.participant_names || [];
    var drawTime = g.draw_time || "12:00";
    var rl = g.required_level || {};
    var page = el("div", "gp-page");

    // --- герой
    var hero = el("div", "gp-hero");
    hero.appendChild(el("div", "gp-hero-bg", ICON_LEAF));
    var inner = el("div", "gp-hero-inner");
    inner.appendChild(el("div", "gp-eyebrow", escapeHtml(t("club.gp.eyebrow"))));
    if (g.closed && g.winner_name) {
      inner.appendChild(el("div", "gp-hero-label", escapeHtml(t("club.gp.winnerLabel"))));
      inner.appendChild(el("div", "gp-hero-main", escapeHtml(g.winner_name)));
      inner.appendChild(el("div", "gp-hero-note", escapeHtml(t("club.giveaway.winnerNote", { name: g.winner_name }))));
    } else if (g.closed) {
      inner.appendChild(el("div", "gp-hero-note", escapeHtml(t("club.giveaway.noWinner"))));
    } else {
      inner.appendChild(el("div", "gp-hero-label", escapeHtml(t("club.gp.countdown"))));
      var clock = el("div", "gp-hero-main gp-clock", fmtCountdown(secondsToDraw(drawTime)));
      inner.appendChild(clock);
      var timer = setInterval(function () {
        if (!document.body.contains(clock)) { clearInterval(timer); return; }
        clock.textContent = fmtCountdown(secondsToDraw(drawTime));
      }, 1000);
    }
    var chips = el("div", "gp-chips");
    chips.innerHTML =
      '<span>' + ICON_PDAY_PEOPLE + escapeHtml(t("club.pday.participants", { count: names.length })) + '</span>' +
      '<span>' + ICON_PDAY_CLOCK + escapeHtml(t("club.gp.drawAt", { time: drawTime })) + '</span>';
    inner.appendChild(chips);
    hero.appendChild(inner);
    page.appendChild(hero);

    // --- ваш статус
    var me = el("div", "gp-me");
    var lvlLabel = rl.key ? clubLevelLabel(rl.key, rl.label) : (rl.label || "");
    var meTitle, meNote, meCls = "";
    if (g.joined) { meTitle = t("club.gp.youIn"); meNote = t("club.gp.youInNote", { time: drawTime }); meCls = " ok"; }
    else if (g.eligible) { meTitle = t("club.gp.youOut"); meNote = t("club.gp.youOutNote"); }
    else { meTitle = t("club.gp.locked", { label: lvlLabel }); meNote = t("club.gp.lockedNote", { left: rl.left || 0 }); meCls = " locked"; }
    me.className = "gp-me" + meCls;
    me.innerHTML = '<span class="gp-me-dot"></span><div><div class="gp-me-title">' + escapeHtml(meTitle) + '</div><div class="gp-me-note">' + escapeHtml(meNote) + '</div></div>';
    page.appendChild(me);

    // --- как это работает
    page.appendChild(el("h3", "gp-section club-serif-h", escapeHtml(t("club.gp.howTitle"))));
    var steps = el("div", "gp-steps");
    [["step1", { label: lvlLabel }], ["step2", { time: drawTime }], ["step3", {}]].forEach(function (st, i) {
      var row = el("div", "gp-step");
      row.innerHTML = '<span class="gp-step-n">' + (i + 1) + '</span><div><div class="gp-step-t">' + escapeHtml(t("club.gp." + st[0])) +
        '</div><div class="gp-step-d">' + escapeHtml(t("club.gp." + st[0] + "d", st[1])) + '</div></div>';
      steps.appendChild(row);
    });
    page.appendChild(steps);

    // --- участники
    page.appendChild(el("h3", "gp-section club-serif-h", escapeHtml(t("club.gp.poolTitle")) + ' <span class="gp-count">' + names.length + '</span>'));
    var pool = el("div", "gp-pool");
    page.appendChild(pool);
    function drawPool() {
      pool.innerHTML = "";
      if (!names.length) { pool.appendChild(el("div", "gp-empty", escapeHtml(t("club.giveaway.empty")))); return; }
      var VISIBLE = 12;
      var shown = state.giveawayExpanded ? names : names.slice(0, VISIBLE);
      var grid = el("div", "gp-people");
      shown.forEach(function (name) {
        grid.appendChild(el("div", "gp-person", '<span class="gp-person-av">' + escapeHtml(initials(name)) + '</span><span class="gp-person-name">' + escapeHtml(name) + '</span>'));
      });
      pool.appendChild(grid);
      if (names.length > VISIBLE) {
        var toggle = el("button", "btn-text leaderboard-toggle", state.giveawayExpanded ? t("club.giveaway.showLess") : t("club.giveaway.showAll"));
        toggle.addEventListener("click", function () { haptic("select"); state.giveawayExpanded = !state.giveawayExpanded; drawPool(); });
        pool.appendChild(toggle);
      }
    }
    drawPool();
    root.appendChild(page);
  }

  // Старый инлайн-виджет (заголовок "PAUSE DAY" + статус "Вы участвуете"/
  // победитель + список участников прямо на экране) убран — теперь это
  // дублировало новую карточку PAUSE DAY под "Сейчас в клубе"
  // (renderClubNowCards), которая уже открывает список участников по
  // тапу. #club-giveaway в разметке больше не используется.
  function renderClubGiveaway() {
    renderClubNowCards();
  }

  function loadClubGiveaway() {
    api("/api/club/giveaway").then(function (data) {
      state.giveaway = data;
      renderClubGiveaway();
    }).catch(function () {
      // Карточка и так уже отрисована с тем, что было (или пусто, если
      // это первая загрузка) — renderClubNowCards не требует g, просто
      // покажет 0 участников, отдельного сообщения об ошибке тут не
      // нужно (в отличие от старого виджета, который теперь убран).
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

    var allChip = el("button", "filter-chip" + (state.messagesFilter === "all" ? " active" : ""), t("menu.all"));
    allChip.addEventListener("click", function () { state.messagesFilter = "all"; renderMessagesFeedScreen(); });
    root.appendChild(allChip);

    MESSAGES_TYPES_ORDER.forEach(function (ft) {
      if (!counts[ft]) return;
      var chip = el("button", "filter-chip" + (state.messagesFilter === ft ? " active" : ""), feedTypeLabel(ft));
      chip.addEventListener("click", function () { state.messagesFilter = ft; renderMessagesFeedScreen(); });
      root.appendChild(chip);
    });
  }

  function renderMessagesFeedScreen() {
    screenHeader("messages-header", {
      title: t("messages.title"),
      right: { icon: ICON_KEBAB, label: t("club.more"), onClick: function () { toast(t("club.moreSoon")); } },
    });
    // Вкладка пока пустая: старая лента "Послания" не используется, вместо
    // неё — заглушка со ссылкой на "Поддержка" (предложения, что сюда добавить).
    document.getElementById("messages-feed-filters").innerHTML = "";
    var root = document.getElementById("messages-feed-root");
    root.innerHTML = "";
    var box = el("div", "feed-empty messages-soon");
    box.appendChild(el("div", null, ICON_LEAF));
    box.appendChild(el("p", null, escapeHtml(t("messages.soon1"))));
    var line = el("p", null, escapeHtml(t("messages.soon2")) + " ");
    var link = el("button", "messages-soon-link", escapeHtml(t("profile.support")));
    link.addEventListener("click", function () { haptic("select"); openSupportSubscreen(); });
    line.appendChild(link);
    box.appendChild(line);
    root.appendChild(box);
  }

  function buildFeedPostCard(post) {
    var card = el("div", "card feed-post feed-post-" + post.type);

    if (isAnyAdmin()) {
      var delBtn = el("button", "feed-post-delete", "×");
      delBtn.addEventListener("click", function (e) {
        e.stopPropagation();
        showConfirm(t("club.deleteConfirm"), t("club.deleteYes"), function () { deleteFeedPost(post.id); });
      });
      card.appendChild(delBtn);
    }

    (post.image_urls || []).forEach(function (url) {
      var img = el("img", "feed-post-photo");
      img.alt = "";
      card.appendChild(img);
      loadFeedImage(url, img);
    });

    var body = el("div", "feed-post-body");
    if (post.type !== "message") {
      var typeRow = el("div", "feed-post-type-row");
      typeRow.appendChild(el("span", "pill" + (post.type === "giveaway" ? " gold" : " muted") + " feed-type-pill", feedTypeLabel(post.type)));
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
      toast(t("club.deleted"));
      state.feed = (state.feed || []).filter(function (p) { return p.id !== id; });
      renderClubNowCards();
    }).catch(function (err) { toast(t("club.deleteFailed", { msg: err.message })); });
  }

  // -------------------------------------------------------------------
  // КОРЗИНА + ОФОРМЛЕНИЕ ЗАКАЗА — корзина (state.cart) не зависит от
  // визарда: свернуть/закрыть визард не теряет добавленные позиции,
  // только явное удаление позиции или успешная отправка заказа его
  // очищает. checkout — черновик полей оформления (точка/комментарий/
  // оплата), живёт, пока не отправлен заказ.
  // -------------------------------------------------------------------

  var checkout = {};
  function resetCheckout() {
    checkout = { zone: "", point: "", isNewPoint: false, lat: null, lon: null, comment: "", deliveryComment: "", payment: "", screenshotFileId: null, screenshotDeferred: false, useTicket: false, ticketItemIndex: null };
  }
  resetCheckout();

  // Зеркало texts.display_garnish (Python) — нужно на фронте, чтобы
  // показать смешанный гарнир ("рис/пюре 50/50" -> "Рис/Пюре 50/50") до
  // отправки заказа на сервер: такого значения нет среди garnish_options
  // ни у одного сета (это не справочный вариант, а сочетание двух).
  function displayGarnishText(g) {
    g = (g || "").trim();
    if (!g) return g;
    if (g.indexOf("/") !== -1) {
      var spIdx = g.indexOf(" ");
      var head = spIdx === -1 ? g : g.slice(0, spIdx);
      var tail = spIdx === -1 ? "" : g.slice(spIdx + 1);
      var headCap = head.split("/").map(function (p) { return p ? p.charAt(0).toUpperCase() + p.slice(1) : p; }).join("/");
      return tail ? (headCap + " " + tail).trim() : headCap;
    }
    return g.charAt(0).toUpperCase() + g.slice(1);
  }

  function garnishDisplayFor(s, value) {
    if (!value || !s.garnish_options) return "";
    var found = s.garnish_options.filter(function (g) { return g.value === value; })[0];
    return found ? found.display : displayGarnishText(value);
  }

  function addToCart(effSet, sel) {
    state.cart.push({
      set: effSet.key, display: effSet.display_name,
      garnish: sel.garnish || "", garnishDisplay: garnishDisplayFor(effSet, sel.garnish),
      price: effSet.price || 0, qty: sel.qty,
    });
    syncCartBar();
  }

  function cartTotal() { return state.cart.reduce(function (s, i) { return s + i.price * i.qty; }, 0); }

  // Плавающая панель над нижней навигацией — появляется, как только в
  // корзине есть хоть одна позиция, и исчезает сама, как только корзина
  // опустела (см. stepCart ниже — там же закрывается и сам экран
  // корзины, если в нём убрали последнюю позицию).
  function syncCartBar() {
    var bar = document.getElementById("cart-bar");
    var content = document.getElementById("content");
    if (!state.cart.length) {
      bar.hidden = true;
      bar.onclick = null;
      content.classList.remove("cart-bar-space");
      return;
    }
    bar.innerHTML =
      '<div class="cart-bar-info"><span class="cart-bar-count">' + escapeHtml(t("cart.barLabel", { count: state.cart.length })) + '</span><span class="cart-bar-total">' + fmtSum(cartTotal()) + '</span></div>' +
      '<button class="cart-bar-btn">' + escapeHtml(t("cart.barButton")) + '</button>';
    bar.hidden = false;
    bar.onclick = openCartScreen;
    // Запас места внизу экрана Меню, чтобы плавающая панель не перекрывала
    // последнюю карточку (см. styles.css: #content.cart-bar-space).
    content.classList.add("cart-bar-space");
  }

  function openCartScreen() {
    haptic("select");
    openWizard(function (body) { stepCart(body); });
  }

  // wizardStep()/wizardReplace() кладут в стек функции рендера, а не
  // "именованные экраны" — если из stepCheckout уйти в выбор района/
  // точки (несколько шагов вглубь) и там всё выбрать, возврат должен
  // схлопнуть стек обратно к самому stepCheckout (индекс 1: [stepCart,
  // stepCheckout, ...]), а не плодить второй его экземпляр поверх.
  function backToCheckout() {
    if (wizardStack.length > 2) wizardStack.length = 2;
    renderWizardCurrent();
  }

  function stepCart(body) {
    wizardPhaseEl.innerHTML = "";
    body.appendChild(el("h2", "wizard-title", t("cart.title")));
    var card = el("div", "card");
    state.cart.forEach(function (item, idx) {
      var row = el("div", "cart-row");
      var left = el("div");
      left.appendChild(el("div", "cart-row-name", escapeHtml(item.display)));
      if (item.garnishDisplay) left.appendChild(el("div", "cart-row-sub", escapeHtml(item.garnishDisplay)));
      row.appendChild(left);

      var right = el("div", "cart-row-right");
      var qtyRow = el("div", "menu-set-qty-row cart-row-qty");
      var minus = el("button", "menu-set-qty-btn", "–");
      var value = el("div", "menu-set-qty-value", String(item.qty));
      var plus = el("button", "menu-set-qty-btn", "+");
      minus.addEventListener("click", function () { if (item.qty > 1) { item.qty--; haptic(); wizardReplace(stepCart); } });
      plus.addEventListener("click", function () { item.qty++; haptic(); wizardReplace(stepCart); });
      qtyRow.appendChild(minus); qtyRow.appendChild(value); qtyRow.appendChild(plus);
      right.appendChild(qtyRow);
      right.appendChild(el("span", "cart-row-sum", fmtSum(item.price * item.qty)));
      var rm = el("button", "cart-row-remove", "×");
      rm.addEventListener("click", function () {
        state.cart.splice(idx, 1);
        syncCartBar();
        if (!state.cart.length) { closeWizard(); return; }
        wizardReplace(stepCart);
      });
      right.appendChild(rm);
      row.appendChild(right);
      card.appendChild(row);
    });
    var totalRow = el("div", "summary-total");
    totalRow.innerHTML = '<span class="summary-total-label">' + escapeHtml(t("cart.total")) + '</span><span class="summary-total-value">' + fmtSum(cartTotal()) + '</span>';
    card.appendChild(totalRow);
    body.appendChild(card);

    var next = el("button", "btn-primary wizard-footer-btn", t("cart.checkoutBtn"));
    next.addEventListener("click", function () { wizardStep(stepCheckout); });
    body.appendChild(next);
  }

  // --- Оформление заказа — один экран, без пошаговых переходов --------

  function stepCheckout(body) {
    wizardPhaseEl.innerHTML = "";
    body.appendChild(el("h2", "wizard-title", t("checkout.title")));

    var profile = state.profile;
    if (!checkout.zone && !checkout.point && profile && profile.zone && profile.point) {
      checkout.zone = profile.zone; checkout.point = profile.point; checkout.isNewPoint = false;
    }
    var deliveryField = el("div", "field");
    deliveryField.innerHTML = '<label>' + escapeHtml(t("checkout.deliveryTitle")) + '</label>';
    if (checkout.zone && checkout.point) {
      var ptCard = el("div", "card option-row selected");
      ptCard.innerHTML = '<div><div class="option-row-label" style="font-weight:600">' + escapeHtml(checkout.zone) + '</div><div class="option-row-sub">' + escapeHtml(checkout.point) + '</div></div>';
      deliveryField.appendChild(ptCard);
      var change = el("button", "btn-text", t("checkout.change"));
      change.addEventListener("click", function () { wizardStep(function (b) { renderDeliveryMapPicker(b, applyCheckoutPoint); }); });
      deliveryField.appendChild(change);
    } else {
      var setBtn = el("div", "card option-row");
      setBtn.innerHTML = '<div><div class="option-row-label" style="font-weight:600">' + escapeHtml(t("address.notChosen")) + '</div><div class="option-row-sub">' + escapeHtml(t("address.setPoint")) + ' ›</div></div>';
      setBtn.addEventListener("click", function () { wizardStep(function (b) { renderDeliveryMapPicker(b, applyCheckoutPoint); }); });
      deliveryField.appendChild(setBtn);
    }
    body.appendChild(deliveryField);
    if (checkout.isNewPoint) body.appendChild(el("p", "center-note", t("checkout.newPointNote")));

    function commentFieldWithInfo(titleKey, infoKey, placeholderKey, value, onInput) {
      var f = el("div", "field");
      f.innerHTML =
        '<label>' + escapeHtml(t(titleKey)) +
          ' <button type="button" class="checkout-delivery-info-btn">' + ICON_CHECKOUT_INFO + '</button></label>' +
        '<textarea rows="2" placeholder="' + escapeHtml(t(placeholderKey)) + '"></textarea>';
      f.querySelector("button").addEventListener("click", function (e) {
        e.preventDefault(); e.stopPropagation();
        haptic("select");
        showInfo('<p style="margin:0">' + escapeHtml(t(infoKey)) + '</p>');
      });
      var ta = f.querySelector("textarea");
      ta.value = value || "";
      ta.addEventListener("input", function (e) { onInput(e.target.value); });
      return f;
    }
    body.appendChild(commentFieldWithInfo("checkout.commentTitle", "checkout.commentInfo", "checkout.commentPlaceholder",
      checkout.comment, function (v) { checkout.comment = v; }));
    body.appendChild(commentFieldWithInfo("checkout.deliveryCommentTitle", "checkout.deliveryCommentInfo", "checkout.deliveryCommentPlaceholder",
      checkout.deliveryComment, function (v) { checkout.deliveryComment = v; }));

    var cashValue = (state.menu.payment_options || []).filter(function (p) { return !/карт/i.test(p); })[0] || t("checkout.cash");
    var cardValue = (state.menu.payment_options || []).filter(function (p) { return /карт/i.test(p); })[0] || t("checkout.card");

    // Билетом — ровно ОДНА ШТУКА из выбранной позиции корзины, выбираемый
    // отдельно от способа оплаты остального (см. pauseapp.py:
    // api_order_submit — делит эту позицию на две строки заказа, если в
    // ней было больше 1 шт.), а не как раньше — отдельная
    // взаимоисключающая плитка "Билетом" вместо наличных/карты. Не
    // требует qty===1 — можно взять билетом одну порцию даже из позиции
    // "Сет А ×2" (воспроизведено: раньше кнопка пропадала именно в этом
    // случае, хотя билет логически применим). Остальное в корзине (та же
    // позиция за вычетом 1 шт. + другие позиции) всё равно нужно оплатить
    // наличными/картой как обычно. Только на уже известную точку (не на
    // новую, ждущую модерации) — то же условие, что проверяет сервер.
    var ticketAvailable = !!(state.profile && state.profile.has_ticket) && !checkout.isNewPoint && state.cart.length > 0;
    if (!ticketAvailable) { checkout.useTicket = false; checkout.ticketItemIndex = null; }
    if (checkout.useTicket && (checkout.ticketItemIndex == null || checkout.ticketItemIndex < 0 || checkout.ticketItemIndex >= state.cart.length)) {
      checkout.ticketItemIndex = 0;
    }
    var ticketItemPrice = (checkout.useTicket && checkout.ticketItemIndex != null && state.cart[checkout.ticketItemIndex])
      ? state.cart[checkout.ticketItemIndex].price : 0;
    // Доставка по статусу Pause Club — пока приходит только для
    // тестового аккаунта (см. pauseapp.api_profile), у всех остальных
    // state.profile.delivery_enabled будет false, билет её не покрывает
    // (см. комментарий выше про has_remaining на сервере). enabled и fee
    // — РАЗНЫЕ вещи: у "Гостя" (первый заказ) fee легитимно 0, но строку
    // "Доставка" всё равно нужно показать (с прочерком), раз доставка
    // для этого клиента вообще считается — просто сейчас бесплатно.
    var deliveryEnabled = !!(state.profile && state.profile.delivery_enabled);
    var deliveryFee = (state.profile && state.profile.delivery_fee) || 0;
    var remainingTotal = cartTotal() - ticketItemPrice + deliveryFee;

    // Сверка по сумме — сколько каких сетов, доставка (если есть) и
    // итог — показываем ВСЕГДА на этом последнем шаге, перед выбором
    // оплаты (а не только когда включён билет, как раньше), по прямой
    // просьбе: раньше это было видно только на экране "Корзина" на шаг
    // раньше, тут же, перед самой оплатой, не повторялось вовсе.
    var summaryField = el("div", "field");
    summaryField.innerHTML = '<label>' + escapeHtml(t("checkout.summaryTitle")) + '</label>';
    var summaryBox = el("div", "card checkout-ticket-summary");
    state.cart.forEach(function (item, idx) {
      var isTicketItem = checkout.useTicket && idx === checkout.ticketItemIndex;
      if (isTicketItem) {
        // Билетом берётся РОВНО 1 шт. этой позиции — если их было
        // больше, остаток (qty - 1) показываем отдельной строкой по
        // обычной цене, а не перечёркиваем всю позицию целиком.
        var freeLine = el("div", "checkout-summary-row is-ticket-item");
        freeLine.innerHTML =
          '<span class="checkout-summary-name">' + escapeHtml(item.display) + (item.qty > 1 ? " (1 шт., лепестком)" : "") + '</span>' +
          '<span class="checkout-summary-price is-struck">' + fmtSum(item.price) + '</span>';
        summaryBox.appendChild(freeLine);
        if (item.qty > 1) {
          var restLine = el("div", "checkout-summary-row");
          restLine.innerHTML =
            '<span class="checkout-summary-name">' + escapeHtml(item.display) + " ×" + (item.qty - 1) + '</span>' +
            '<span class="checkout-summary-price">' + fmtSum(item.price * (item.qty - 1)) + '</span>';
          summaryBox.appendChild(restLine);
        }
        return;
      }
      var line = el("div", "checkout-summary-row");
      line.innerHTML =
        '<span class="checkout-summary-name">' + escapeHtml(item.display) + (item.qty > 1 ? " ×" + item.qty : "") + '</span>' +
        '<span class="checkout-summary-price">' + fmtSum(item.price * item.qty) + '</span>';
      summaryBox.appendChild(line);
    });
    if (deliveryEnabled) {
      var deliveryLine = el("div", "checkout-summary-row");
      deliveryLine.innerHTML =
        '<span class="checkout-summary-name">' + escapeHtml(t("checkout.deliveryFeeLabel")) +
          ' <button type="button" class="checkout-delivery-info-btn">' + ICON_CHECKOUT_INFO + '</button></span>' +
        '<span class="checkout-summary-price">' + (deliveryFee > 0 ? fmtSum(deliveryFee) : "—") + '</span>';
      deliveryLine.querySelector(".checkout-delivery-info-btn").addEventListener("click", function (e) {
        e.stopPropagation();
        haptic("select");
        showInfo(buildDeliveryInfoHtml());
      });
      summaryBox.appendChild(deliveryLine);
    }
    var summaryTotalRow = el("div", "summary-total");
    summaryTotalRow.innerHTML = '<span class="summary-total-label">' + escapeHtml(t("checkout.ticketRemainingTotal")) + '</span><span class="summary-total-value">' + fmtSum(remainingTotal) + '</span>';
    summaryBox.appendChild(summaryTotalRow);
    summaryField.appendChild(summaryBox);
    body.appendChild(summaryField);

    var payField = el("div", "field");
    payField.innerHTML = '<label>' + escapeHtml(t("checkout.paymentTitle")) + '</label>';

    if (ticketAvailable) {
      var ticketToggle = el("div", "petal-pay" + (checkout.useTicket ? " selected" : ""));
      ticketToggle.innerHTML =
        '<span class="petal-pay-icon">' + ICON_PETAL + '</span>' +
        '<div class="petal-pay-text"><div class="petal-pay-label">' + escapeHtml(t("checkout.paymentTicket")) + '</div>' +
        '<div class="petal-pay-sub">' + escapeHtml(checkout.useTicket ? t("checkout.petalApplied") : t("checkout.paymentTicketHint")) + '</div></div>' +
        '<span class="petal-pay-check">' + (checkout.useTicket ? "✓" : "") + '</span>';
      if (checkout.useTicket && checkout.petalFresh) {
        // Один раз при выборе — лепестки разлетаются от иконки.
        checkout.petalFresh = false;
        var burst = el("div", "petal-burst");
        for (var bi = 0; bi < 7; bi++) burst.appendChild(el("span", "petal-burst-p p" + bi, ICON_PETAL));
        ticketToggle.appendChild(burst);
      }
      ticketToggle.addEventListener("click", function () {
        haptic(checkout.useTicket ? "select" : "success");
        checkout.useTicket = !checkout.useTicket;
        checkout.petalFresh = checkout.useTicket;
        wizardReplace(stepCheckout);
      });
      payField.appendChild(ticketToggle);
    }

    if (checkout.useTicket && state.cart.length > 1) {
      var pickerBox = el("div", "card ticket-set-picker");
      state.cart.forEach(function (item, idx) {
        var pickRow = el("div", "option-row ticket-set-option" + (idx === checkout.ticketItemIndex ? " selected" : ""));
        pickRow.innerHTML = '<div class="option-row-label">' + escapeHtml(item.display) + (item.qty > 1 ? " ×" + item.qty : "") + '</div><div class="option-row-sub">' + fmtSum(item.price) + '</div>';
        pickRow.addEventListener("click", function () {
          haptic("select");
          checkout.ticketItemIndex = idx;
          wizardReplace(stepCheckout);
        });
        pickerBox.appendChild(pickRow);
      });
      payField.appendChild(pickerBox);
    }

    // Наличные/карта нужны только на ту часть заказа, что не покрыта
    // билетом — если билет целиком закрывает всю корзину (один сет,
    // remainingTotal === 0), способ оплаты вообще не нужен, как и раньше.
    if (remainingTotal > 0) {
      var tileOptions = [{ value: cashValue, label: t("checkout.cash") }, { value: cardValue, label: t("checkout.card") }];
      var tilesRow = el("div", "payment-tiles-row");
      tileOptions.forEach(function (opt) {
        var tileClass = "payment-tile" + (checkout.payment === opt.value ? " active" : "");
        var tile = el("button", tileClass, escapeHtml(opt.label));
        tile.addEventListener("click", function () {
          haptic("select");
          checkout.payment = opt.value;
          if (opt.value !== cardValue) { checkout.screenshotFileId = null; checkout.screenshotDeferred = false; }
          wizardReplace(stepCheckout);
        });
        tilesRow.appendChild(tile);
      });
      payField.appendChild(tilesRow);
    } else {
      checkout.payment = "";
    }

    if (checkout.payment && checkout.payment === cardValue) {
      payField.appendChild(el("div", "requisites-box", escapeHtml(state.menu.card_requisites || "")));
      if (checkout.screenshotFileId) {
        payField.appendChild(el("div", "checkout-screenshot-ok", escapeHtml(t("checkout.screenshotAttached"))));
      } else if (checkout.screenshotDeferred) {
        var deferredRow = el("div", "checkout-screenshot-deferred");
        deferredRow.innerHTML = escapeHtml(t("checkout.screenshotDeferredNote")) + " ";
        var undoBtn = el("button", "btn-text", t("checkout.screenshotDeferredUndo"));
        undoBtn.addEventListener("click", function () { checkout.screenshotDeferred = false; wizardReplace(stepCheckout); });
        deferredRow.appendChild(undoBtn);
        payField.appendChild(deferredRow);
      } else {
        var attachRow = el("div", "checkout-attach-row");
        var fileInput = el("input");
        fileInput.type = "file"; fileInput.accept = "image/*"; fileInput.style.display = "none";
        var attachBtn = el("button", "btn-ghost", t("checkout.attachScreenshot"));
        var laterBtn = el("button", "btn-ghost", t("checkout.attachLater"));
        attachBtn.addEventListener("click", function () { fileInput.click(); });
        fileInput.addEventListener("change", function () {
          if (!fileInput.files || !fileInput.files[0]) return;
          var file = fileInput.files[0];
          attachBtn.disabled = true;
          attachBtn.textContent = t("checkout.uploading");
          apiUpload("/api/order/screenshot", file, file.name).then(function (data) {
            checkout.screenshotFileId = data.file_id;
            haptic("success");
            wizardReplace(stepCheckout);
          }).catch(function (err) {
            attachBtn.disabled = false;
            attachBtn.textContent = t("checkout.attachScreenshot");
            toast(t("checkout.uploadFailed", { msg: err.message }));
          });
        });
        laterBtn.addEventListener("click", function () { checkout.screenshotFileId = null; checkout.screenshotDeferred = true; wizardReplace(stepCheckout); });
        attachRow.appendChild(fileInput);
        attachRow.appendChild(attachBtn);
        attachRow.appendChild(laterBtn);
        payField.appendChild(attachRow);
      }
    }
    body.appendChild(payField);

    var confirmBtn = el("button", "btn-primary wizard-footer-btn", t("checkout.confirmBtn"));
    confirmBtn.addEventListener("click", function () { submitCheckoutOrder(confirmBtn); });
    body.appendChild(confirmBtn);
  }

  // Точка доставки при оформлении выбирается на карте (см.
  // renderDeliveryMapPicker — общий пикер, тот же самый, что и в
  // Профиле → Адрес доставки) — applyCheckoutPoint просто кладёт
  // результат в черновик оформления и возвращается на сам экран.
  function applyCheckoutPoint(sel) {
    checkout.zone = sel.zone; checkout.point = sel.point; checkout.isNewPoint = sel.isNewPoint;
    checkout.lat = sel.lat || null; checkout.lon = sel.lon || null;
    backToCheckout();
  }

  // --- Отправка — тот же /api/order, что и раньше (см. pauseapp.py:
  // api_order_submit — дата активного меню/отсечка/ID клиента/статус
  // "на модерации" для новой точки/привязка скрина уже реализованы там,
  // здесь только вызов). ------------------------------------------------

  function submitCheckoutOrder(btn) {
    if (!checkout.zone || !checkout.point) { toast(t("checkout.needPoint")); return; }
    var ticketItem = checkout.useTicket ? state.cart[checkout.ticketItemIndex] : null;
    var deliveryFee = (state.profile && state.profile.delivery_fee) || 0;
    var remaining = cartTotal() - (ticketItem ? ticketItem.price : 0) + deliveryFee;
    if (remaining > 0 && !checkout.payment) { toast(t("checkout.needPayment")); return; }
    var cardValue = (state.menu.payment_options || []).filter(function (p) { return /карт/i.test(p); })[0] || t("checkout.card");
    // Скрин оплаты картой — обязательный шаг: либо прикреплён, либо явно
    // отложен кнопкой "Прикреплю позже" — раньше оба этих поля были
    // одинаково "пустыми" по умолчанию, и заказ уходил даже если клиент
    // вообще ничего не нажал на этом шаге, воспроизведено и подтверждено.
    if (checkout.payment === cardValue && !checkout.screenshotFileId && !checkout.screenshotDeferred) {
      toast(t("checkout.screenshotStepRequired"));
      return;
    }
    btn.disabled = true;
    btn.textContent = t("checkout.sending");
    api("/api/order", {
      method: "POST",
      body: {
        cart: state.cart.map(function (i) { return { set: i.set, garnish: i.garnish, qty: i.qty }; }),
        zone: checkout.zone, point: checkout.point, is_new_point: checkout.isNewPoint,
        lat: checkout.lat, lon: checkout.lon,
        comment: checkout.comment, delivery_comment: checkout.deliveryComment, payment: checkout.payment, screenshot_file_id: checkout.screenshotFileId,
        ticket_item_index: checkout.useTicket ? checkout.ticketItemIndex : null,
      },
    }).then(function (data) {
      haptic("success");
      var pending = data.status === "pending";
      var care = data.care || null;
      // Корзину чистим только сейчас, после реального успеха — при
      // ошибке (см. catch ниже) она остаётся нетронутой, как и просили.
      state.cart = [];
      resetCheckout();
      syncCartBar();
      state.menu = null; // перечитаем актуальное меню при следующем открытии
      // state.profile НЕ сбрасываем: zone/point в нём не устарели (при
      // заказе на уже известную точку они и так не менялись, при заказе
      // на новую точку sheets.update_client_point вообще не вызывается,
      // пока модератор не подтвердит) — а сброс здесь обнулил бы точку
      // по умолчанию на экране оформления следующего заказа в этой же
      // сессии, что и происходило до фикса. has_ticket в нём патчим
      // точечно, не дожидаясь следующей полной загрузки профиля — иначе
      // следующий заказ в той же сессии увидел бы уже потраченный билет
      // как доступный.
      if (state.profile && data.giveaway) state.profile.has_ticket = data.giveaway.has_ticket;
      // order_count/club/delivery_fee — раньше НЕ обновлялись после
      // заказа вовсе (только has_ticket патчился точечно), поэтому
      // статус Pause Club и доставка на следующем заказе в этой же
      // сессии ещё долго показывали состояние "до заказа" (тот самый
      // репорт "сделал заказ, статус/доставка не обновились") —
      // воспроизведено и подтверждено. Перечитываем профиль фоном, не
      // задерживая сам экран подтверждения заказа — если не получится,
      // не страшно, обновится при следующей полной загрузке.
      api("/api/profile").then(function (fresh) {
        if (fresh && fresh.registered) state.profile = fresh;
      }).catch(function () {});
      wizardStep(function (b) { stepOrderConfirmed(b, pending, care); });
    }).catch(function (err) {
      btn.disabled = false;
      btn.textContent = t("checkout.confirmBtn");
      haptic("error");
      var TICKET_ERROR_KEYS = {
        no_ticket: "checkout.noTicket",
        ticket_single_set_only: "checkout.ticketSingleSetOnly",
        ticket_new_point_not_allowed: "checkout.ticketNewPointNotAllowed",
      };
      toast(TICKET_ERROR_KEYS[err.code] ? t(TICKET_ERROR_KEYS[err.code]) : t("checkout.submitFailed"));
    });
  }

  // --- Подтверждение — тёплая фраза, через секунду-две сменяется
  // карточкой цифрового послания (та же нумерация, что у бота, см.
  // sheets.get_next_message_number/save_care_message). -------------------

  function stepOrderConfirmed(body, pending, care) {
    wizardPhaseEl.innerHTML = "";
    document.getElementById("wizard-back").style.visibility = "hidden";
    var wrap = el("div", "order-confirm-anim");
    wrap.innerHTML =
      '<div class="order-confirm-icon">' + ICON_LEAF + '</div>' +
      '<h2>' + escapeHtml(pending ? t("checkout.donePendingTitle") : t("checkout.doneWarm")) + '</h2>' +
      (pending ? '<p style="margin-top:10px">' + escapeHtml(t("checkout.donePendingText")) + '</p>' : "");
    body.appendChild(wrap);

    if (care) {
      setTimeout(function () {
        if (document.getElementById("wizard").hidden) return;
        wizardReplace(function (b) { stepCareMessageCard(b, care); });
      }, 1400);
    } else {
      var done = el("button", "btn-primary wizard-footer-btn", t("checkout.doneBtn"));
      done.style.marginTop = "26px";
      done.addEventListener("click", function () { closeWizard(); showScreen("menu"); loadMenu(); });
      body.appendChild(done);
    }
  }

  // Разметка самой карточки послания — общий билдер для (1) показа сразу
  // после заказа (stepCareMessageCard, одна карточка внутри визарда) и
  // (2) просмотра из "Мои послания" (openCareViewer, несколько карточек
  // со свайпом) — дизайн по присланному макету должен быть ОДИН и тот же
  // в обоих местах, меняются только номер/текст.
  function careCardHtml(number, total, text) {
    return (
      '<div class="care-card">' +
        '<div class="care-card-top">' +
          '<span class="care-card-brand">PAUSE</span>' +
          '<span class="care-card-num">' + escapeHtml(String(number)) + '/' + escapeHtml(String(total)) + '</span>' +
        '</div>' +
        '<div class="care-card-body"><div class="care-card-text">' + escapeHtml(text) + '</div></div>' +
        '<div class="care-card-icon">' + ICON_LEAF + '</div>' +
        '<div class="care-card-divider"></div>' +
        '<div class="care-card-footer"><div>' + escapeHtml(t("care.thankYou1")) + '</div><div>' + escapeHtml(t("care.thankYou2")) + '</div></div>' +
        '<div class="care-card-stub"></div>' +
      '</div>'
    );
  }

  function stepCareMessageCard(body, care) {
    wizardPhaseEl.innerHTML = "";
    document.getElementById("wizard-back").style.visibility = "hidden";
    var wrap = el("div", "care-message-wrap");
    wrap.innerHTML = careCardHtml(care.number, care.total, care.phrase);
    body.appendChild(wrap);
    var done = el("button", "btn-primary wizard-footer-btn", t("checkout.doneBtn"));
    done.addEventListener("click", function () { closeWizard(); showScreen("menu"); loadMenu(); });
    body.appendChild(done);
  }

  // --- Полноэкранный просмотр карточек-посланий (свайп) ------------------
  // Открывается кликом по записи в "Мои послания" (см. loadMessages ниже).
  // Листание между несколькими карточками — нативный горизонтальный
  // scroll-snap у #care-viewer-track, без ручной обработки touch-жестов.

  var careViewerEl = document.getElementById("care-viewer");
  var careViewerTrack = document.getElementById("care-viewer-track");
  var careViewerDots = document.getElementById("care-viewer-dots");
  var careViewerScrollTimer = null;

  var careViewerOnClose = null;
  function openCareViewer(messages, total, startIndex, opts) {
    opts = opts || {};
    careViewerOnClose = opts.onClose || null;
    var oldBanner = careViewerEl.querySelector(".care-viewer-banner");
    if (oldBanner) oldBanner.remove();
    if (opts.banner) {
      var banner = el("div", "care-viewer-banner", escapeHtml(opts.banner));
      careViewerEl.insertBefore(banner, careViewerTrack);
    }
    careViewerTrack.innerHTML = "";
    messages.forEach(function (m) {
      var slide = el("div", "care-viewer-slide");
      slide.innerHTML = careCardHtml(m.number, total, m.text);
      careViewerTrack.appendChild(slide);
    });
    careViewerDots.innerHTML = "";
    careViewerDots.style.display = messages.length > 1 ? "flex" : "none";
    messages.forEach(function (_, i) {
      careViewerDots.appendChild(el("span", "care-viewer-dot" + (i === startIndex ? " active" : "")));
    });
    careViewerEl.hidden = false;
    if (tg && tg.BackButton) {
      tg.BackButton.show();
      tg.BackButton.onClick(closeCareViewer);
    }
    // scrollLeft по ширине трека доступен только после того, как он
    // реально отрисован (hidden=false только что снят) — без rAF прыжок
    // к нужной карточке иногда проскакивал на первом открытии.
    requestAnimationFrame(function () {
      careViewerTrack.scrollLeft = careViewerTrack.clientWidth * startIndex;
    });
  }

  function closeCareViewer() {
    careViewerEl.hidden = true;
    careViewerTrack.innerHTML = "";
    var cb = careViewerOnClose;
    careViewerOnClose = null;
    if (cb) cb();
    if (tg && tg.BackButton) {
      tg.BackButton.offClick(closeCareViewer);
      tg.BackButton.hide();
    }
  }

  document.getElementById("care-viewer-close").addEventListener("click", closeCareViewer);

  careViewerTrack.addEventListener("scroll", function () {
    if (careViewerScrollTimer) clearTimeout(careViewerScrollTimer);
    careViewerScrollTimer = setTimeout(function () {
      var idx = Math.round(careViewerTrack.scrollLeft / careViewerTrack.clientWidth);
      var dots = careViewerDots.children;
      for (var i = 0; i < dots.length; i++) dots[i].classList.toggle("active", i === idx);
    }, 80);
  });

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
      root.appendChild(el("div", "empty-note", t("profile.loadFailed", { msg: err.message })));
    });
  }

  // photo_url в tg.initDataUnsafe.user Telegram отдаёт ТОЛЬКО когда Mini
  // App открыт из attachment menu — у нас же вход всегда через обычную
  // inline-кнопку (web_app) в сообщении бота (/admin, /pauseapp), так что
  // это поле пустое всегда, независимо от того, есть у человека аватарка
  // или нет — отсюда и "поставил аватарку, а в профиле всё равно пусто".
  // tgUserId ниже используется вместо этого — настоящий аватар теперь
  // берём тем же способом, что и чужие на таблице лидеров (см.
  // buildLeaderboardAvatar/api/avatar/{tg_id} — живой запрос к Bot API
  // при каждом открытии профиля, без кеша на сервере).
  function tgPhotoUrl() {
    try {
      var u = tg && tg.initDataUnsafe && tg.initDataUnsafe.user;
      return u && u.photo_url ? u.photo_url : null;
    } catch (e) { return null; }
  }

  function tgUserId() {
    try {
      var u = tg && tg.initDataUnsafe && tg.initDataUnsafe.user;
      return u && u.id ? u.id : null;
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
  // Та же самая форма, просто залитая — состояние "уже в избранном"
  // (см. buildMenuSetCard/.menu-set-fav-btn.active).
  var ICON_HEART_FILLED = '<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.6" width="20" height="20" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>';
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
  function openProfileSubscreen(title, loaderFn, serif) {
    openWizard(function (body) {
      wizardPhaseEl.innerHTML = "";
      body.appendChild(el("h2", "wizard-title" + (serif ? " club-serif" : ""), title));
      var sub = el("div");
      sub.appendChild(el("div", "skeleton-block"));
      body.appendChild(sub);
      loaderFn(sub);
    });
  }

  var ICON_EDIT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" width="20" height="20" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>';
  var ICON_PIN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" width="20" height="20" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>';
  var ICON_GLOBE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" width="20" height="20" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><line x1="3" y1="12" x2="21" y2="12"/><path d="M12 3a13.7 13.7 0 0 1 3.5 9 13.7 13.7 0 0 1-3.5 9 13.7 13.7 0 0 1-3.5-9A13.7 13.7 0 0 1 12 3z"/></svg>';
  var ICON_TRASH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" width="20" height="20" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>';

  function openSettingsSubscreen() {
    openWizard(function (body) {
      wizardPhaseEl.innerHTML = "";
      body.appendChild(el("h2", "wizard-title", t("settings.title")));
      var rows = el("div", "card profile-nav-list");
      rows.appendChild(buildProfileRow(ICON_EDIT, t("settings.editProfile"), function () { editState = {}; openEditProfileInfo(); }));
      rows.appendChild(buildProfileRow(ICON_PIN, t("settings.deliveryAddress"), function () { editState = {}; openEditDeliveryAddress(); }));
      rows.appendChild(buildProfileRow(ICON_GLOBE, t("settings.language"), openLanguageSubscreen));
      body.appendChild(rows);
      var dangerRows = el("div", "card profile-nav-list");
      var delRow = buildProfileRow(ICON_TRASH, t("settings.deleteProfile"), openDeleteAccountConfirm);
      delRow.classList.add("profile-nav-row-danger");
      dangerRows.appendChild(delRow);
      body.appendChild(dangerRows);
    });
  }

  function openEditProfileInfo() {
    var p = state.profile;
    openWizard(function (body) {
      wizardPhaseEl.innerHTML = "";
      body.appendChild(el("h2", "wizard-title", t("editProfile.title")));

      var nameField = el("div", "field");
      nameField.innerHTML = '<label>' + escapeHtml(t("editProfile.name")) + '</label><input type="text" id="edit-name" value="' + escapeHtml(p.name || "") + '">';
      body.appendChild(nameField);

      var phoneField = buildPhoneField(t("editProfile.phone"), p.phone);
      body.appendChild(phoneField.el);

      var save = el("button", "btn-primary wizard-footer-btn", t("editProfile.save"));
      save.addEventListener("click", function () {
        // Номер — либо пустой (не меняли), либо ровно 9 цифр после +998;
        // ничего среднего сохранить нельзя (см. ТЗ: показать красным и не
        // дать сохранить, пока не будет правильно).
        if (!phoneField.isValid()) { phoneField.showErrorIfInvalid(); return; }
        save.disabled = true;
        var reqBody = {
          name: document.getElementById("edit-name").value.trim(),
          phone: phoneField.getPhone(),
        };
        api("/api/profile", { method: "POST", body: reqBody }).then(function () {
          haptic("success");
          toast(t("editProfile.saved"));
          closeWizard();
          state.profile = null;
          loadProfile();
        }).catch(function (err) { save.disabled = false; toast(t("editProfile.saveFailed", { msg: err.message })); });
      });
      body.appendChild(save);
    });
  }

  function openEditDeliveryAddress() {
    var p = state.profile;
    openWizard(function (body) {
      wizardPhaseEl.innerHTML = "";
      body.appendChild(el("h2", "wizard-title", t("address.title")));

      var curZone = editState.zone || p.zone || "";
      var curPoint = editState.point || p.point || "";
      var pointField = el("div", "field");
      pointField.innerHTML = '<label>' + escapeHtml(t("address.point")) + '</label>';
      var pointBtn = el("div", "card option-row selected");
      pointBtn.innerHTML = (curZone && curPoint)
        ? '<div class="option-row-label">' + escapeHtml(curZone + ", " + curPoint) + '</div>'
        : '<div><div class="option-row-label" style="font-weight:600">' + escapeHtml(t("address.notChosen")) + '</div><div class="option-row-sub">' + escapeHtml(t("address.setPoint")) + ' ›</div></div>';
      pointBtn.addEventListener("click", function () {
        wizardStep(function (b) { renderDeliveryMapPicker(b, applyEditPoint); });
      });
      pointField.appendChild(pointBtn);
      body.appendChild(pointField);

      var save = el("button", "btn-primary wizard-footer-btn", t("address.save"));
      save.disabled = !(editState.zone && editState.point);
      save.addEventListener("click", function () {
        if (!editState.zone || !editState.point) { toast(t("address.pickFirst")); return; }
        save.disabled = true;
        api("/api/profile", { method: "POST", body: {
          zone: editState.zone, point: editState.point, is_new_point: !!editState.isNewPoint,
          lat: editState.lat || null, lon: editState.lon || null,
        } }).then(function () {
          haptic("success");
          toast(t("address.saved"));
          closeWizard();
          state.profile = null;
          loadProfile();
        }).catch(function (err) { save.disabled = false; toast(t("address.saveFailed", { msg: err.message })); });
      });
      body.appendChild(save);
    });
  }

  function openDeleteAccountConfirm() {
    showConfirm(
      t("settings.deleteConfirm"),
      t("settings.deleteYes"),
      function () {
        api("/api/account/delete-request", { method: "POST", body: {} }).then(function () {
          haptic("success");
          toast(t("settings.deleteSubmitted"));
        }).catch(function (err) { toast(t("settings.deleteFailed", { msg: err.message })); });
      }
    );
  }

  // Названия языков — всегда на самом этом языке (стандартная практика
  // языковых переключателей), поэтому не через t().
  var LANGUAGES = [
    { code: "ru", label: "Русский" },
    { code: "uz", label: "O'zbekcha" },
    { code: "en", label: "English" },
  ];

  function openLanguageSubscreen() {
    openWizard(function (body) {
      wizardPhaseEl.innerHTML = "";
      body.appendChild(el("h2", "wizard-title", t("lang.title")));
      var rows = el("div", "card profile-nav-list");
      LANGUAGES.forEach(function (lng) {
        var row = el("div", "profile-nav-row");
        row.innerHTML =
          '<span class="profile-nav-row-label">' + escapeHtml(lng.label) + '</span>' +
          '<span class="lang-row-check">' + (state.lang === lng.code ? ICON_LANG_CHECK : "") + '</span>';
        row.addEventListener("click", function () {
          haptic("select");
          setLang(lng.code);
          closeWizard();
          applyLangToUI();
        });
        rows.appendChild(row);
      });
      body.appendChild(rows);
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
      body.appendChild(el("h2", "wizard-title", t("notify.title")));
      var listWrap = el("div");
      listWrap.appendChild(el("div", "skeleton-block"));
      body.appendChild(listWrap);

      api("/api/notify").then(function (data) {
        listWrap.innerHTML = "";
        var card = el("div", "card");
        card.appendChild(buildToggleRow(
          t("notify.morningTitle"),
          t("notify.morningSub"),
          data.morning_on,
          function (on) {
            api("/api/notify", { method: "POST", body: { morning_on: on } })
              .then(function () { toast(on ? t("notify.on") : t("notify.off")); })
              .catch(function () { toast(t("notify.saveFailed")); });
          }
        ));
        card.appendChild(buildToggleRow(
          t("notify.menuTitle"),
          t("notify.menuSub"),
          data.menu_on,
          function (on) {
            api("/api/notify", { method: "POST", body: { menu_on: on } })
              .then(function () { toast(on ? t("notify.on") : t("notify.off")); })
              .catch(function () { toast(t("notify.saveFailed")); });
          }
        ));
        listWrap.appendChild(card);
        listWrap.appendChild(el("p", "center-note", t("notify.footnote")));
      }).catch(function () {
        listWrap.innerHTML = "";
        listWrap.appendChild(el("div", "empty-note", t("notify.loadFailed")));
      });
    });
  }

  function openSupportSubscreen() {
    openWizard(function (body) {
      wizardPhaseEl.innerHTML = "";
      body.appendChild(el("h2", "wizard-title", t("support.title")));
      body.appendChild(el("p", null, t("support.intro")));

      body.appendChild(el("div", "profile-section-title", t("support.social")));
      var social = el("div", "card profile-nav-list");
      social.appendChild(buildContactRow(ICON_TELEGRAM, t("support.telegram"), "@ssaavveeyy", "https://t.me/ssaavveeyy"));
      social.appendChild(buildContactRow(ICON_INSTAGRAM, t("support.instagram"), "@pause.tashkent", "https://instagram.com/pause.tashkent"));
      social.appendChild(buildContactRow(ICON_INSTAGRAM, t("support.founderBlog"), "@ssaavveeyy", "https://instagram.com/ssaavveeyy"));
      body.appendChild(social);

      body.appendChild(el("div", "profile-section-title", t("support.contacts")));
      var contacts = el("div", "card profile-nav-list");
      contacts.appendChild(buildContactRow(ICON_PHONE, t("support.phone"), "+998 91 776 34 09", "tel:+998917763409"));
      body.appendChild(contacts);
    });
  }

  function renderProfileScreen() {
    screenHeader("profile-header", {
      back: function () { showScreen("home"); },
      title: t("profile.title"),
      center: true,
      right: { icon: ICON_GEAR, label: t("profile.settings"), onClick: openSettingsSubscreen },
    });
    var root = document.getElementById("profile-root");
    root.innerHTML = "";
    var p = state.profile;

    if (!p.registered) {
      root.appendChild(el("div", "empty-note", t("profile.notRegistered")));
      return;
    }

    var head = el("div", "profile-head");
    // Сразу инициалы (не ждём сеть) — подменяем на настоящее фото, если
    // Telegram его отдаст (см. tgUserId выше про то, почему не из
    // initDataUnsafe.user.photo_url напрямую).
    var avatarSlot = el("div", "avatar", initials(p.name));
    head.appendChild(avatarSlot);
    var myId = tgUserId();
    if (myId) {
      // "?t=" — не для сервера (он и так не кеширует, см. pauseapp.py:
      // api_avatar_image), а чтобы обойти fetchAuthedImageBlobUrl: его
      // кеш живёт в памяти по точному URL и держит даже неудачный ответ
      // (не было фото) — Telegram же нередко не убивает WebView при
      // закрытии мини-аппа, а замораживает его и возвращает ПРИ
      // следующем открытии ТУ ЖЕ страницу без перезагрузки, так что без
      // этого штрих и новую аватарку, и старое "фото нет" можно было бы
      // видеть сколько угодно переоткрытий подряд — JS ни разу не
      // перезапускался, сходить за аватаркой заново было неоткуда.
      fetchAuthedImageBlobUrl("/pauseapp/api/avatar/" + encodeURIComponent(myId) + "?t=" + Date.now())
        .then(function (blobUrl) {
          var img = el("img", "avatar");
          img.alt = "";
          img.src = blobUrl;
          if (avatarSlot.parentNode) avatarSlot.parentNode.replaceChild(img, avatarSlot);
        })
        .catch(function () { /* нет фото в Telegram — инициалы и остаются */ });
    }
    head.appendChild(el("div", "profile-name", p.name || t("profile.noName")));
    head.appendChild(el("div", "profile-contact", formatPhone(p.phone)));

    // Статус клуба виден сразу, с первого заказа (даже на "PAUSE Guest.",
    // 0 заказов) — не прячем, пока не наберётся хоть один, как было
    // раньше. По тапу — полный экран со всеми статусами (см.
    // renderClubLevelsScreen), а не короткая подсказка.
    var badge = el("button", "pill profile-club-badge", clubLevelIcon(p.club.key) + "<span>" + clubLevelLabel(p.club.key, p.club.label) + "</span>");
    badge.addEventListener("click", function () {
      haptic("select");
      openProfileSubscreen(t("profile.clubTitle"), function (sub) { renderClubLevelsScreen(sub, p); });
    });
    head.appendChild(badge);
    root.appendChild(head);

    // 3 плашки статистики — "заказов" и "постов" реальные (заказы из
    // профиля, посты — те же самые /api/feed, посчитанные по автору);
    // "акции" — тире, а не выдуманное число: участие в розыгрышах нигде
    // не считается (см. отчёт пользователю).
    var statRow = el("div", "profile-stat-row");
    var s1 = el("button", "profile-stat profile-stat-clickable");
    s1.innerHTML = '<div class="profile-stat-value">' + p.order_count + '</div><div class="profile-stat-label">' + t("profile.statOrders") + '</div>';
    s1.addEventListener("click", function () { haptic("select"); openProfileSubscreen(t("orders.title"), loadOrders); });
    var s2 = el("div", "profile-stat");
    s2.innerHTML = '<div class="profile-stat-value">—</div><div class="profile-stat-label">' + t("profile.statPromo") + '</div>';
    // "Постов" — мои посты на стене PAUSE MOMENTS (по tg_id автора); тап
    // открывает саму стену. Стена могла ещё не загружаться — подтягиваем.
    var s3 = el("button", "profile-stat profile-stat-clickable");
    function myMomentsCount() {
      return (state.moments || []).filter(function (post) { return String(post.tg_id) === String(state.myTgId); }).length;
    }
    function drawPostsStat() {
      s3.innerHTML = '<div class="profile-stat-value">' + myMomentsCount() + '</div><div class="profile-stat-label">' + t("profile.statPosts") + '</div>';
    }
    drawPostsStat();
    if (!state.moments) loadMoments(function (ok) { if (ok && document.body.contains(s3)) drawPostsStat(); });
    s3.addEventListener("click", openClubMoments);
    statRow.appendChild(s1); statRow.appendChild(s2); statRow.appendChild(s3);
    root.appendChild(statRow);

    // "Настройки" (точка доставки, имя/телефон) сюда не входит — это
    // отдельная иконка-шестерёнка в шапке. "Мои послания" — ЦИФРОВЫЕ
    // карточки с номером, которые человек получает при каждом заказе (см.
    // loadMessages/sheets.get_client_messages) — отдельная личная история,
    // не то же самое, что вкладка нижней навигации "Послания" (там общая
    // лента постов PAUSE Club), поэтому обе показываются, а не дублируют
    // друг друга.
    var rows = el("div", "card profile-nav-list");
    rows.appendChild(buildProfileRow(ICON_ORDERS, t("profile.myOrders"), function () { openProfileSubscreen(t("orders.title"), loadOrders); }));
    rows.appendChild(buildProfileRow(ICON_ENVELOPE, t("profile.myMessages"), function () { openProfileSubscreen(t("profile.myMessages"), loadMessages); }));
    rows.appendChild(buildProfileRow(ICON_HEART, t("profile.favorites"), function () { openProfileSubscreen(t("favorites.title"), loadFavorites); }));
    rows.appendChild(buildProfileRow(ICON_BELL, t("profile.notifications"), openNotifySubscreen));
    rows.appendChild(buildProfileRow(ICON_TAG, t("profile.bonuses"), function () { openProfileSubscreen(t("bonuses.title"), loadBonuses); }));
    rows.appendChild(buildProfileRow(ICON_SUPPORT, t("profile.support"), openSupportSubscreen));
    root.appendChild(rows);

    // Операционный центр — пока отдельная карточка под основным списком,
    // не строка внутри него: это админский инструмент, а не часть
    // клиентского профиля, визуально не путаем одно с другим (хотя
    // доступ к ЛЮБОЙ части PAUSE App сейчас и так только у админа).
    // У делегированного админа без единой выданной функции (см.
    // "Операционный центр" → "Администраторы") скрываем саму карточку —
    // незачем вести в пустой хаб без единой доступной кнопки.
    if (state.isMainAdmin || state.paFinance || state.paDebtors || state.paMenu) {
      var adminRows = el("div", "card profile-nav-list");
      adminRows.appendChild(buildProfileRow(ICON_OPS, "Операционный центр", function () { openProfileSubscreen("Операционный центр", loadOpsHub); }));
      root.appendChild(adminRows);
    }

    if (tg) {
      var exitBtn = el("button", "btn-ghost profile-exit-btn", t("profile.logout"));
      // Отдельного "логина" в системе нет — личность приходит из Telegram
      // автоматически при каждом открытии, выходить не из чего технически;
      // честный эквивалент "Выйти" здесь — просто закрыть Mini App.
      exitBtn.addEventListener("click", function () { tg.close(); });
      root.appendChild(exitBtn);
    }
  }

  // --- Мои заказы --------------------------------------------------------

  function ORDERS_PAY_FILTERS() {
    return [
      { key: "all", label: t("orders.all") },
      { key: "paid", label: t("orders.paid") },
      { key: "unpaid", label: t("orders.unpaid") },
    ];
  }

  function loadOrders(root) {
    var payFilter = "all";
    api("/api/orders").then(function (data) {
      renderOrders();

      function renderOrders() {
        root.innerHTML = "";
        if (!data.pending.length && !data.orders.length) {
          root.appendChild(el("div", "empty-note", t("orders.empty")));
          return;
        }

        // Фильтр по оплате имеет смысл только для оформленных заказов —
        // "На рассмотрении" (pending, точка ещё не подтверждена) своего
        // статуса оплаты пока не имеет, показываем их только на "Все".
        if (data.orders.length) {
          var chips = el("div", "feed-filters");
          ORDERS_PAY_FILTERS().forEach(function (f) {
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
              '<div class="order-card-head"><span class="order-card-date">' + p.date + '</span><span class="pill gold">' + t("orders.reviewing") + '</span></div>' +
              '<div class="order-card-items">' + itemsText(p.items) + '</div>';
            root.appendChild(card);
          });
        }

        var filteredOrders = data.orders.filter(function (g) {
          if (payFilter === "paid") return g.paid;
          if (payFilter === "unpaid") return !g.paid;
          return true;
        });

        // По фильтру "Не оплачено" пустой список — это хорошая новость,
        // а не "ничего не нашлось": долгов нет, повод похвалить, а не
        // показать нейтральную заглушку.
        if (payFilter === "unpaid" && !filteredOrders.length) {
          root.appendChild(el("div", "empty-note", t("orders.allPaid")));
          return;
        }

        filteredOrders.forEach(function (g) {
          var card = el("div", "card");
          var statusPill = g.canceled
            ? '<span class="pill muted">' + t("orders.canceled") + '</span>'
            : g.complete ? '<span class="pill">' + t("orders.complete") + '</span>' : '<span class="pill gold">' + t("orders.preparing") + '</span>';
          var payPill = g.review && !g.paid
            ? '<span class="pill gold">' + t("orders.payChecking") + '</span>'
            : '<span class="pill ' + (g.paid ? "paid" : "unpaid") + '">' + (g.paid ? t("orders.paid") : t("orders.unpaid")) + '</span>';
          card.innerHTML =
            '<div class="order-card-head"><span class="order-card-date">' + g.date + '</span>' +
            '<span class="order-card-pills">' + payPill + statusPill + '</span></div>' +
            '<div class="order-card-items">' + itemsText(g.items) + (g.is_debt ? t("orders.debtTag") : "") + '</div>' +
            (g.methods && g.methods.length ? '<div class="order-card-method">' + escapeHtml(t("orders.method")) + ': ' + g.methods.map(function (m) { return escapeHtml(t("orders.method." + m)); }).join(" + ") + '</div>' : "") +
            (g.delivery_fee
              ? '<div class="order-card-sums"><div><span>' + escapeHtml(t("orders.setsSum")) + '</span><span>' + fmtSum(g.sets_sum) + '</span></div>' +
                '<div><span>' + escapeHtml(t("orders.delivery")) + '</span><span>' + fmtSum(g.delivery_fee) + '</span></div></div>'
              : "");
          if (g.can_cancel || (!g.canceled && g.row_for_feedback)) {
            var actions = el("div", "order-card-actions");
            if (g.can_cancel) {
              var cancelBtn = el("button", "btn-ghost", t("orders.cancel"));
              cancelBtn.addEventListener("click", function () {
                showConfirm(t("orders.cancelConfirm", { date: g.date }), t("orders.cancelYes"), function () { cancelOrder(root); });
              });
              actions.appendChild(cancelBtn);
            }
            if (!g.canceled && g.row_for_feedback) {
              var fbBtn = el("button", "btn-text", t("orders.review"));
              fbBtn.addEventListener("click", function () { openFeedback(g); });
              actions.appendChild(fbBtn);
            }
            card.appendChild(actions);
          }
          root.appendChild(card);
        });

        if (data.debt > 0) {
          root.appendChild(el("div", "center-note", t("orders.debtLine", { sum: fmtSum(data.debt) })));
          var payBtn = el("button", "btn-primary orders-pay-btn", t("orders.pay", { sum: fmtSum(data.debt) }));
          payBtn.addEventListener("click", function () { openDebtPay(root, data.debt_days || []); });
          root.appendChild(payBtn);
        }
      }
    }).catch(function () {
      root.innerHTML = "";
      root.appendChild(el("div", "empty-note", t("orders.loadFailed")));
    });
  }

  function openDebtPay(ordersRoot, days) {
    showInfo(escapeHtml(t("orders.payHint")));
    var body = document.getElementById("info-modal-body");
    var selected = {};
    days.forEach(function (d) { selected[d.date] = true; });
    var list = el("div", "debt-days");
    var attach = el("button", "btn-primary orders-pay-btn");
    function total() {
      return days.reduce(function (s, d) { return s + (selected[d.date] ? d.amount : 0); }, 0);
    }
    function refresh() {
      attach.textContent = t("orders.pay", { sum: fmtSum(total()) }) + " · " + t("checkout.attachScreenshot");
      attach.disabled = total() <= 0;
    }
    days.forEach(function (d) {
      var row = el("label", "debt-day-row");
      var cb = el("input"); cb.type = "checkbox"; cb.checked = true;
      cb.addEventListener("change", function () { selected[d.date] = cb.checked; refresh(); });
      row.appendChild(cb);
      row.appendChild(el("span", "debt-day-date", escapeHtml(d.date)));
      row.appendChild(el("span", "debt-day-sum", fmtSum(d.amount)));
      list.appendChild(row);
    });
    var fileInput = el("input");
    fileInput.type = "file"; fileInput.accept = "image/*"; fileInput.style.display = "none";
    attach.addEventListener("click", function () { fileInput.click(); });
    fileInput.addEventListener("change", function () {
      if (!fileInput.files || !fileInput.files[0]) return;
      var file = fileInput.files[0];
      var dates = days.filter(function (d) { return selected[d.date]; }).map(function (d) { return d.date; });
      attach.disabled = true;
      attach.textContent = t("checkout.uploading");
      apiUpload("/api/order/screenshot", file, file.name).then(function (data) {
        return api("/api/debt/pay", { method: "POST", body: { file_id: data.file_id, dates: dates } });
      }).then(function () {
        hideInfo();
        haptic("success");
        toast(t("orders.payChecking"));
        loadOrders(ordersRoot);
      }).catch(function (err) {
        refresh();
        toast(t("checkout.uploadFailed", { msg: err.message }));
      });
    });
    refresh();
    body.appendChild(list);
    body.appendChild(fileInput);
    body.appendChild(attach);
  }

  // Страница оплаты за сегодня — открывается по кнопке из напоминания в боте (?pay=today).
  function loadPayToday(root) {
    api("/api/pay/today").then(function (data) {
      root.innerHTML = "";
      if (!data.items.length) {
        root.appendChild(el("div", "empty-note", t("pay.nothing")));
        return;
      }
      var card = el("div", "card");
      card.innerHTML = '<div class="order-card-head"><span class="order-card-date">' + escapeHtml(data.date) + '</span></div>' +
        '<div class="order-card-items">' + itemsText(data.items) + '</div>' +
        '<div class="order-card-sums"><div><b>' + escapeHtml(t("pay.total")) + '</b><b>' + fmtSum(data.total) + '</b></div></div>';
      root.appendChild(card);
      var fileInput = el("input");
      fileInput.type = "file"; fileInput.accept = "image/*"; fileInput.style.display = "none";
      var btn = el("button", "btn-primary orders-pay-btn", t("pay.send"));
      btn.addEventListener("click", function () { fileInput.click(); });
      fileInput.addEventListener("change", function () {
        if (!fileInput.files || !fileInput.files[0]) return;
        var file = fileInput.files[0];
        btn.disabled = true;
        btn.textContent = t("checkout.uploading");
        apiUpload("/api/order/screenshot", file, file.name).then(function (up) {
          return api("/api/pay/today", { method: "POST", body: { file_id: up.file_id } });
        }).then(function () {
          haptic("success");
          toast(t("orders.payChecking"));
          root.innerHTML = "";
          root.appendChild(el("div", "empty-note", t("pay.sent")));
        }).catch(function (err) {
          btn.disabled = false;
          btn.textContent = t("pay.send");
          toast(t("checkout.uploadFailed", { msg: err.message }));
        });
      });
      root.appendChild(fileInput);
      root.appendChild(btn);
    }).catch(function () {
      root.innerHTML = "";
      root.appendChild(el("div", "empty-note", t("orders.loadFailed")));
    });
  }

  function itemsText(items) {
    return items.map(function (i) { return i.qty + "× " + localizedSetName(i.set); }).join(", ");
  }

  function cancelOrder(ordersRoot) {
    api("/api/orders/cancel", { method: "POST", body: {} }).then(function () {
      toast(t("orders.canceledToast"));
      haptic("success");
      loadOrders(ordersRoot);
    }).catch(function (err) {
      var msg = t("orders.cancelFailed");
      if (err.code === "too_late") msg = t("orders.cancelTooLate");
      else if (err.code === "card_pending") msg = t("orders.cancelCardPending");
      toast(msg);
    });
  }

  function openFeedback(group) {
    var label = group.date + " — " + itemsText(group.items);
    var stars = 0;
    openWizard(function (body) {
      wizardPhaseEl.innerHTML = "";
      body.appendChild(el("h2", "wizard-title", t("feedback.title")));
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
      field.innerHTML = '<textarea id="feedback-input" rows="4" placeholder="' + escapeHtml(t("feedback.commentPlaceholder")) + '"></textarea>';
      body.appendChild(field);

      var send = el("button", "btn-primary wizard-footer-btn", t("feedback.send"));
      send.addEventListener("click", function () {
        var text = document.getElementById("feedback-input").value.trim();
        // Можно отправить просто оценку без комментария, но не пустую
        // форму совсем — хотя бы звёзды или хотя бы текст.
        if (!stars && !text) { toast(t("feedback.needSomething")); return; }
        send.disabled = true;
        api("/api/feedback", { method: "POST", body: { text: text, stars: stars, order_label: label } }).then(function () {
          haptic("success");
          toast(t("feedback.thanks"));
          closeWizard();
        }).catch(function (err) { send.disabled = false; toast(t("feedback.sendFailed", { msg: err.message })); });
      });
      body.appendChild(send);
    });
  }

  // --- Избранное -----------------------------------------------------------
  // s.key (см. pauseapp.py:_serialize_sets) — то же самое, что хранится в
  // листе "Избранное": для обычного сета его имя, для группы переменной
  // цены "__variant__:{группа}". state.favoriteKeys — Set этих ключей,
  // грузится один раз за сессию (лениво, при первом обращении — либо
  // открытии карточки блюда, либо самого экрана "Избранное") и дальше
  // обновляется локально при каждом тапе на сердечко, без повторных
  // походов на сервер.

  function ensureFavoriteKeys() {
    if (state.favoriteKeys) return Promise.resolve(state.favoriteKeys);
    return api("/api/favorites").then(function (data) {
      state.favoriteKeys = new Set(data.keys || []);
      return state.favoriteKeys;
    }).catch(function () {
      return new Set();
    });
  }

  function toggleFavorite(key) {
    return api("/api/favorites/toggle", { method: "POST", body: { key: key } }).then(function (data) {
      if (!state.favoriteKeys) state.favoriteKeys = new Set();
      if (data.favorited) state.favoriteKeys.add(key); else state.favoriteKeys.delete(key);
      return data.favorited;
    });
  }

  function loadFavorites(root) {
    api("/api/favorites").then(function (data) {
      state.favoriteKeys = new Set(data.keys || []);
      root.innerHTML = "";
      if (!data.favorites.length) {
        root.appendChild(el("div", "empty-note", t("favorites.empty")));
        return;
      }
      var grid = el("div", "menu-set-grid");
      data.favorites.forEach(function (s) { grid.appendChild(buildMenuSetCard(s)); });
      root.appendChild(grid);
    }).catch(function () {
      root.innerHTML = "";
      root.appendChild(el("div", "empty-note", t("favorites.loadFailed")));
    });
  }

  // --- Операционный центр (админ) -------------------------------------------
  // Текст экрана — на русском без i18n-ключей, как и остальные
  // admin-only части проекта (бот, /admin и т.п. тоже не переведены):
  // смысла переводить внутренний инструмент для одного русскоязычного
  // админа нет. Доступ не проверяется отдельно здесь — весь PAUSE App уже
  // закрыт admin_auth_middleware на сервере (см. pauseapp.py), этот
  // экран ничем не отличается от остальных.
  //
  // Подразделы — отдельные шаги того же wizard-стека (см. wizardStep),
  // а не отдельные экраны: "Назад" естественно возвращает из Должников/
  // Финансов на хаб, а из карточки должника — обратно в список.

  var ICON_OPS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" width="20" height="20" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19V10M12 19V5M20 19v-6"/></svg>';
  var ICON_OPS_FINANCE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" width="22" height="22" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v10M9.5 9.5c0-1.4 1.1-2.5 2.5-2.5s2.5 1 2.5 2.2c0 2.8-5 1.6-5 4.4 0 1.2 1.1 2.2 2.5 2.2s2.5-1.1 2.5-2.5"/></svg>';
  var ICON_OPS_DELIVERY = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" width="22" height="22" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h11v10H3zM14 9h4l3 3v4h-7"/><circle cx="7.5" cy="17.5" r="1.8"/><circle cx="17.5" cy="17.5" r="1.8"/></svg>';
  var ICON_OPS_DEBTORS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" width="22" height="22" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3.2"/><path d="M3 20c0.9-3.6 3.2-5.4 6-5.4s5.1 1.8 6 5.4"/><path d="M17 4.5c1.6 0.4 2.8 1.8 2.8 3.5s-1.2 3.1-2.8 3.5M21 20c-0.6-2.4-1.8-4-3.5-4.8"/></svg>';
  var ICON_OPS_ADMINS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" width="22" height="22" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 3v5c0 4.5-2.9 8-7 10-4.1-2-7-5.5-7-10V6l7-3z"/><path d="M9 12l2 2 4-4"/></svg>';
  var ICON_OPS_GIVEAWAY = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" width="22" height="22" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="8" width="18" height="12" rx="1.5"/><path d="M3 12h18"/><path d="M12 8v12"/><path d="M12 8c-1.8 0-3.2-1.3-3.2-2.8S9.2 3 10.5 3c1.3 0 1.8 1.6 1.5 2.8M12 8c1.8 0 3.2-1.3 3.2-2.8S14.8 3 13.5 3c-1.3 0-1.8 1.6-1.5 2.8"/></svg>';
  var ICON_OPS_MENU = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" width="22" height="22" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/></svg>';
  var ICON_OPS_CRM = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" width="22" height="22" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18"/><circle cx="8" cy="13.5" r="1.6"/><path d="M12.5 13h5M12.5 16.5h5"/></svg>';
  var ICON_OPS_LEADS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" width="22" height="22" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16l-6.5 8.5V19l-3 2v-8.5z"/></svg>';
  var ICON_CRM_SEARCH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" width="18" height="18" stroke-linecap="round" stroke-linejoin="round"><circle cx="10.5" cy="10.5" r="6.5"/><path d="M20 20l-4.8-4.8"/></svg>';
  var ICON_CHECKOUT_INFO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" width="15" height="15" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v5.5"/><circle cx="12" cy="8" r="0.6" fill="currentColor" stroke="none"/></svg>';

  // Разъяснение "почему доставка платная" по значку (i) рядом со строкой
  // "Доставка" в сверке заказа — переиспользует те же данные, что уже
  // грузит /api/profile для экрана "Pause Club" (state.profile.club.levels,
  // см. renderClubLevelsScreen), ни одного нового запроса.
  function buildDeliveryInfoHtml() {
    var levels = (state.profile && state.profile.club && state.profile.club.levels) || [];
    var rows = levels.map(function (l) {
      return '<div class="delivery-info-row' + (l.current ? ' is-current' : '') + '">' +
        '<span class="delivery-info-row-icon">' + clubLevelIcon(l.key) + '</span>' +
        '<span class="delivery-info-row-name">' + escapeHtml(clubLevelLabel(l.key, l.label)) +
          '<span class="delivery-info-row-range">' + escapeHtml(t("profile.clubOrders", { range: l.range_text })) + '</span>' +
        '</span>' +
        '<span class="delivery-info-row-price">' + escapeHtml(l.delivery) + '</span>' +
      '</div>';
    }).join("");
    return (
      '<h3 style="margin-top:0">' + escapeHtml(t("checkout.deliveryInfoTitle")) + '</h3>' +
      '<p>' + escapeHtml(t("checkout.deliveryInfoText")) + '</p>' +
      '<div class="delivery-info-list">' + rows + '</div>'
    );
  }
  var CRM_STAGE_LABELS = { cold: "Холодный", warm: "Тёплый", dozhim: "Дожим", sale: "Продажа" };
  var ICON_CAMERA = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" width="20" height="20" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h3l2-2h6l2 2h3v11H4z"/><circle cx="12" cy="13.5" r="3.5"/></svg>';

  function opsStepHeader(body, title) {
    body.appendChild(el("h2", "wizard-title", title));
  }

  function loadOpsHub(root) {
    root.innerHTML = "";
    var rows = el("div", "card profile-nav-list");
    // Кнопки — по факту выданных функций (state.paFinance/paDebtors,
    // см. /api/me), "Администраторы" — ТОЛЬКО у главного админа, всегда
    // последней кнопкой, не выдаётся и не отзывается как функция.
    if (state.isMainAdmin || state.paFinance) {
      rows.appendChild(buildProfileRow(ICON_OPS_FINANCE, "Финансы", function () {
        wizardStep(function (body) {
          opsStepHeader(body, "Финансы");
          var sub = el("div");
          sub.appendChild(el("div", "skeleton-block"));
          body.appendChild(sub);
          loadOpsFinance(sub);
        });
      }));
    }
    if (state.isMainAdmin || state.paFinance || state.paDebtors) {
      rows.appendChild(buildProfileRow(ICON_OPS_DELIVERY, "Доставки", function () {
        wizardStep(function (body) {
          opsStepHeader(body, "Доставки");
          var sub = el("div");
          sub.appendChild(el("div", "skeleton-block"));
          body.appendChild(sub);
          loadOpsDelivery(sub);
        });
      }));
    }
    if (state.isMainAdmin || state.paFinance) {
      rows.appendChild(buildProfileRow(ICON_OPS_GIVEAWAY, "PAUSE GIFT «PAUSE DAY»", function () {
        wizardStep(function (body) {
          opsStepHeader(body, "PAUSE GIFT «PAUSE DAY»");
          var sub = el("div");
          sub.appendChild(el("div", "skeleton-block"));
          body.appendChild(sub);
          loadOpsGiveaway(sub);
        });
      }));
    }
    if (state.isMainAdmin || state.paMenu) {
      rows.appendChild(buildProfileRow(ICON_OPS_MENU, "Меню", function () {
        wizardStep(function (body) {
          opsStepHeader(body, "Меню");
          var menuRows = el("div", "card profile-nav-list");
          menuRows.appendChild(buildProfileRow(ICON_EDIT, "Меню дня", function () {
            wizardStep(function (b) { openMenuDraftWizard(b); });
          }));
          menuRows.appendChild(buildProfileRow(ICON_CAMERA, "Карточки сетов", function () {
            wizardStep(function (b) {
              opsStepHeader(b, "Карточки сетов");
              var sub = el("div");
              sub.appendChild(el("div", "skeleton-block"));
              b.appendChild(sub);
              loadMenuCatalogList(sub);
            });
          }));
          menuRows.appendChild(buildProfileRow(ICON_TAG, "Названия для покупателей", function () {
            wizardStep(function (b) {
              opsStepHeader(b, "Названия для покупателей");
              var sub = el("div");
              sub.appendChild(el("div", "skeleton-block"));
              b.appendChild(sub);
              loadMenuDisplayNames(sub);
            });
          }));
          body.appendChild(menuRows);
        });
      }));
    }
    if (state.isMainAdmin || state.paDebtors) {
      rows.appendChild(buildProfileRow(ICON_OPS_DEBTORS, "Должники", function () {
        wizardStep(function (body) {
          opsStepHeader(body, "Должники");
          var sub = el("div");
          sub.appendChild(el("div", "skeleton-block"));
          body.appendChild(sub);
          loadOpsDebtorsList(sub);
        });
      }));
    }
    if (state.isMainAdmin) {
      rows.appendChild(buildProfileRow(ICON_EDIT, "Управление Pause Club", function () {
        wizardStep(function (body) { renderClubAdminList(body); });
      }));
    }
    if (state.isMainAdmin) {
      rows.appendChild(buildProfileRow(ICON_OPS_CRM, "CRM", function () {
        wizardStep(function (body) {
          opsStepHeader(body, "CRM");
          var crmRows = el("div", "card profile-nav-list");
          crmRows.appendChild(buildProfileRow(ICON_OPS_DEBTORS, "Клиенты", function () {
            wizardStep(function (b) {
              opsStepHeader(b, "Клиенты");
              var sub = el("div");
              sub.appendChild(el("div", "skeleton-block"));
              b.appendChild(sub);
              loadCrmClientsList(sub);
            });
          }));
          crmRows.appendChild(buildProfileRow(ICON_OPS_LEADS, "Лиды", function () {
            wizardStep(function (b) {
              opsStepHeader(b, "Лиды");
              var sub = el("div");
              sub.appendChild(el("div", "skeleton-block"));
              b.appendChild(sub);
              loadCrmLeads(sub);
            });
          }));
          body.appendChild(crmRows);
        });
      }));
    }
    if (state.isMainAdmin) {
      rows.appendChild(buildProfileRow(ICON_OPS_ADMINS, "Администраторы", function () {
        wizardStep(function (body) {
          opsStepHeader(body, "Администраторы");
          var sub = el("div");
          sub.appendChild(el("div", "skeleton-block"));
          body.appendChild(sub);
          loadOpsAdminsList(sub);
        });
      }));
    }
    root.appendChild(rows);
  }

  // -------------------------------------------------------------------
  // "Меню" (Операционный центр → Меню, доступ — pa_menu) — создание меню
  // через сам Mini App, по той же механике, что и у бота (черновик ->
  // сеты -> гарниры -> фото/текст -> предпросмотр -> публикация, см.
  // pauseapp.py: api_ops_menu_draft*), только интерфейс — хаб с тремя
  // независимыми разделами внутри одного черновика, а не жёсткий порядок
  // шагов чата. "Карточки сетов" и "Названия для покупателей" — отдельные
  // от черновика, постоянные catalog-атрибуты (см. api_ops_menu_catalog).
  // -------------------------------------------------------------------

  // Общий блок-подсказка по формату фото + живое демо того же самого
  // переключателя "свёрнуто/развёрнуто", что видит клиент на карточке
  // сета (.menu-set-card/.menu-set-thumb — те же классы, тот же CSS, не
  // имитация). getPhotoUrl — функция, чтобы демо подхватывало СВЕЖЕЕ фото
  // сразу после выбора файла, до какой-либо отправки на сервер.
  function buildPhotoFormatDemo(getPhotoUrl) {
    var wrap = el("div", "photo-format-demo");
    wrap.appendChild(el("div", "field-hint",
      "Совет по фото: альбомная ориентация, примерно 4:3 (например 1600×1200), блюдо по центру кадра — " +
      "тогда оно одинаково хорошо смотрится и маленькой квадратной миниатюрой в списке, и широким баннером, " +
      "когда карточку разворачивают. Нажмите карточку ниже, чтобы увидеть оба варианта."));
    var expanded = false;
    var demoCard = el("div", "card menu-set-card");
    function render() {
      demoCard.innerHTML = "";
      demoCard.classList.toggle("expanded", expanded);
      var url = getPhotoUrl();
      if (url) {
        var img = el("img", "menu-set-thumb");
        img.alt = "";
        if (/^blob:|^https?:\/\//.test(url)) img.src = url; else setPhotoSrc(img, url);
        demoCard.appendChild(img);
      } else {
        demoCard.appendChild(el("div", "menu-set-thumb menu-set-thumb-empty", ICON_LEAF));
      }
      var body = el("div", "menu-set-card-body");
      body.appendChild(el("div", "menu-set-card-name", "Так будет выглядеть карточка"));
      body.appendChild(el("div", "menu-set-card-note",
        expanded ? "Развёрнуто (широкий формат 16:9) — нажмите, чтобы свернуть" : "Свёрнуто (квадрат) — нажмите, чтобы развернуть"));
      demoCard.appendChild(body);
    }
    demoCard.addEventListener("click", function () { expanded = !expanded; render(); });
    render();
    wrap.appendChild(demoCard);
    return wrap;
  }

  // Гарниры — чипы: уже добавленные (можно убрать тапом), подсказки из
  // общего справочника (sheets.get_garnishes, тап — добавить), и поле для
  // своего варианта. onChange зовётся с полным текущим списком при любом
  // изменении — вызывающий код сам решает, когда сохранять на сервер.
  function buildGarnishChipEditor(initial, referenceList, onChange) {
    var current = initial.slice();
    var wrap = el("div", "garnish-chip-editor");
    function render() {
      wrap.innerHTML = "";
      if (current.length) {
        var chips = el("div", "garnish-chips");
        current.forEach(function (g) {
          var chip = el("button", "garnish-chip active", escapeHtml(g) + " ✕");
          chip.addEventListener("click", function () {
            current = current.filter(function (x) { return x !== g; });
            onChange(current.slice());
            render();
          });
          chips.appendChild(chip);
        });
        wrap.appendChild(chips);
      }
      var suggestions = referenceList.filter(function (g) { return current.indexOf(g) === -1; });
      if (suggestions.length) {
        var sugWrap = el("div", "garnish-chips garnish-chips-suggestions");
        suggestions.forEach(function (g) {
          var chip = el("button", "garnish-chip suggestion", "+ " + escapeHtml(g));
          chip.addEventListener("click", function () {
            current.push(g);
            onChange(current.slice());
            render();
          });
          sugWrap.appendChild(chip);
        });
        wrap.appendChild(sugWrap);
      }
      var addRow = el("div", "garnish-add-row");
      var input = el("input");
      input.type = "text";
      input.placeholder = "Свой вариант";
      var addBtn = el("button", "btn-ghost", "Добавить");
      addBtn.addEventListener("click", function () {
        var v = input.value.trim();
        if (!v || current.indexOf(v) !== -1) return;
        current.push(v);
        input.value = "";
        onChange(current.slice());
        render();
      });
      addRow.appendChild(input);
      addRow.appendChild(addBtn);
      wrap.appendChild(addRow);
    }
    render();
    return wrap;
  }

  // --- Черновик "Меню дня" --------------------------------------------

  var menuDraft = null;          // последний загруженный черновик (см. GET /api/ops/menu/draft)
  var _menuSetsSelected = null;  // рабочая копия выбора на время шага "Сеты сегодня"

  function loadMenuDraft(onReady, onError) {
    api("/api/ops/menu/draft").then(function (data) {
      menuDraft = data;
      _menuSetsSelected = null;
      onReady();
    }).catch(function (err) {
      if (onError) onError(err);
    });
  }

  function openMenuDraftWizard(body) {
    wizardPhaseEl.innerHTML = "";
    body.appendChild(el("h2", "wizard-title", "Меню дня"));
    var sub = el("div");
    sub.appendChild(el("div", "skeleton-block"));
    body.appendChild(sub);
    loadMenuDraft(function () {
      wizardReplace(renderMenuDraftHub);
    }, function (err) {
      sub.innerHTML = "";
      sub.appendChild(el("div", "empty-note", "Не удалось загрузить черновик меню: " + err.message));
    });
  }

  function renderMenuDraftHub(body) {
    wizardPhaseEl.innerHTML = "";
    body.appendChild(el("h2", "wizard-title", "Меню дня"));

    var d = menuDraft;

    var rows = el("div", "card profile-nav-list");
    var setsLabel = d.selected_keys.length ? (d.selected_keys.length + " выбрано") : "весь каталог";
    rows.appendChild(buildProfileRow(ICON_ORDERS, "Сеты сегодня — " + setsLabel, function () { wizardStep(renderMenuDraftSetsStep); }));
    var garnishCount = Object.keys(d.garnish).length;
    rows.appendChild(buildProfileRow(ICON_SLIDERS, "Гарниры" + (garnishCount ? " — " + garnishCount : ""), function () { wizardStep(renderMenuDraftGarnishStep); }));
    var dishKeys = d.selected_keys.length ? d.selected_keys : d.catalog.map(function (c) { return c.key; });
    var missingDishes = dishKeys.filter(function (key) {
      var c = _menuDraftCatalogItem(key);
      return !c || !c.photo_url || !c.description;
    }).length;
    rows.appendChild(buildProfileRow(ICON_CAMERA, "Фото и описание блюд" + (missingDishes ? " — не хватает " + missingDishes : ""), function () { wizardStep(renderMenuDraftDishesStep); }));
    body.appendChild(rows);

    var photoCard = el("div", "card menu-draft-summary");
    photoCard.appendChild(el("div", "profile-section-title", "Текст и фото рассылки клиентам"));
    if (d.photo_urls.length) {
      var thumbRow = el("div", "menu-draft-photo-row");
      d.photo_urls.forEach(function (u) {
        var img = el("img", "menu-draft-photo-thumb");
        img.alt = "";
        setPhotoSrc(img, u);
        thumbRow.appendChild(img);
      });
      photoCard.appendChild(thumbRow);
    } else {
      photoCard.appendChild(el("div", "empty-note", "Фото пока не загружено"));
    }
    photoCard.appendChild(el("div", "menu-draft-caption", escapeHtml(d.caption || "Текста пока нет")));
    photoCard.addEventListener("click", function () { wizardStep(renderMenuDraftPhotoStep); });
    body.appendChild(photoCard);

    var previewBtn = el("button", "btn-ghost", "Предпросмотр как у клиента");
    previewBtn.addEventListener("click", function () { wizardStep(renderMenuDraftPreviewStep); });
    body.appendChild(previewBtn);

    var resetBtn = el("button", "btn-text", "Начать новый черновик");
    resetBtn.addEventListener("click", function () {
      showConfirm("Стереть текущий черновик (фото, текст, выбор сетов и гарниры) и начать заново?", "Да, начать заново", function () {
        api("/api/ops/menu/draft/new", { method: "POST", body: {} }).then(function () {
          haptic("success");
          wizardReplace(openMenuDraftWizard);
        }).catch(function (err) { toast("Не удалось сбросить черновик: " + err.message); });
      });
    });
    body.appendChild(resetBtn);

    var publishCard = el("div", "card");
    publishCard.appendChild(el("div", "profile-section-title", "Опубликовать"));
    var selectedDate = "";
    var dateField = el("div", "field");
    dateField.innerHTML = '<label>Дата доставки</label>';
    var tilesRow = el("div", "payment-tiles-row");
    var todayStr = _opsFmtDate(new Date());
    var tomorrowStr = _opsFmtDate(new Date(Date.now() + 86400000));
    var manualInput = el("input");
    manualInput.type = "text";
    manualInput.placeholder = "ДД.ММ.ГГГГ";
    [{ label: "Сегодня, " + todayStr, value: todayStr }, { label: "Завтра, " + tomorrowStr, value: tomorrowStr }].forEach(function (opt) {
      var tile = el("button", "payment-tile", opt.label);
      tile.addEventListener("click", function () {
        selectedDate = opt.value;
        haptic("select");
        Array.prototype.forEach.call(tilesRow.children, function (c) { c.classList.remove("active"); });
        tile.classList.add("active");
        manualInput.value = "";
      });
      tilesRow.appendChild(tile);
    });
    dateField.appendChild(tilesRow);
    manualInput.addEventListener("input", function () {
      selectedDate = manualInput.value.trim();
      Array.prototype.forEach.call(tilesRow.children, function (c) { c.classList.remove("active"); });
    });
    dateField.appendChild(manualInput);
    publishCard.appendChild(dateField);

    var publishBtn = el("button", "btn-primary wizard-footer-btn", "Опубликовать меню");
    publishBtn.addEventListener("click", function () {
      if (!/^\d{2}\.\d{2}\.\d{4}$/.test(selectedDate)) { toast("Укажите дату в формате ДД.ММ.ГГГГ"); return; }
      showConfirm("Опубликовать меню на " + selectedDate + "? Клиенты сразу увидят новое меню.", "Опубликовать", function () {
        publishBtn.disabled = true;
        api("/api/ops/menu/draft/publish", { method: "POST", body: { date: selectedDate } }).then(function (res) {
          haptic("success");
          toast(res.broadcasted ? "Меню опубликовано, рассылаем клиентам" : "Меню опубликовано");
          closeWizard();
        }).catch(function (err) {
          publishBtn.disabled = false;
          toast("Не удалось опубликовать: " + err.message);
        });
      });
    });
    publishCard.appendChild(publishBtn);
    body.appendChild(publishCard);
  }

  function renderMenuDraftSetsStep(body) {
    wizardPhaseEl.innerHTML = "";
    if (_menuSetsSelected === null) _menuSetsSelected = menuDraft.selected_keys.slice();
    body.appendChild(el("h2", "wizard-title", "Сеты сегодня"));
    body.appendChild(el("p", "center-note",
      "Отметьте, что сегодня в меню. Если не отметить ни одного — клиенты увидят весь каталог целиком " +
      "(так безопаснее, чем оставить меню вовсе без кнопок заказа)."));

    var listCard = el("div", "card");
    menuDraft.catalog.forEach(function (c) {
      var isSel = _menuSetsSelected.indexOf(c.key) !== -1;
      var row = el("div", "card option-row" + (isSel ? " selected" : ""));
      var priceText = c.is_group
        ? c.technical_names.map(function (t) { return fmtSum(c.prices[t]); }).join(" / ")
        : fmtSum(c.prices[c.key]);
      row.innerHTML = '<div><div class="option-row-label" style="font-weight:600">' + escapeHtml(c.display_name) +
        '</div><div class="option-row-sub">' + priceText + ' сум</div></div>';
      row.addEventListener("click", function () {
        haptic("select");
        var idx = _menuSetsSelected.indexOf(c.key);
        if (idx === -1) _menuSetsSelected.push(c.key); else _menuSetsSelected.splice(idx, 1);
        row.classList.toggle("selected");
      });
      listCard.appendChild(row);
    });
    body.appendChild(listCard);

    var selectAllBtn = el("button", "btn-ghost", _menuSetsSelected.length === menuDraft.catalog.length ? "Снять все" : "Выбрать все");
    selectAllBtn.addEventListener("click", function () {
      _menuSetsSelected = _menuSetsSelected.length === menuDraft.catalog.length ? [] : menuDraft.catalog.map(function (c) { return c.key; });
      wizardReplace(renderMenuDraftSetsStep);
    });
    body.appendChild(selectAllBtn);

    var saveBtn = el("button", "btn-primary wizard-footer-btn", "Сохранить");
    saveBtn.addEventListener("click", function () {
      saveBtn.disabled = true;
      api("/api/ops/menu/draft/sets", { method: "POST", body: { sets: _menuSetsSelected } }).then(function () {
        haptic("success");
        menuDraft.selected_keys = _menuSetsSelected;
        _menuSetsSelected = null;
        wizardBack();
      }).catch(function (err) {
        saveBtn.disabled = false;
        toast("Не удалось сохранить: " + err.message);
      });
    });
    body.appendChild(saveBtn);
  }

  function renderMenuDraftGarnishStep(body) {
    wizardPhaseEl.innerHTML = "";
    body.appendChild(el("h2", "wizard-title", "Гарниры на сегодня"));

    var garnishSets = menuDraft.catalog.filter(function (c) {
      return c.has_garnish && menuDraft.selected_keys.indexOf(c.key) !== -1;
    });
    if (!garnishSets.length) {
      body.appendChild(el("div", "empty-note",
        "Среди выбранных сегодня сетов нет ни одного с гарниром — сначала отметьте сеты на предыдущем шаге, " +
        "или включите гарнир сету в \"Карточки сетов\"."));
      return;
    }

    var working = {};
    garnishSets.forEach(function (c) { working[c.key] = (menuDraft.garnish[c.key] || []).slice(); });

    garnishSets.forEach(function (c) {
      var card = el("div", "card");
      card.appendChild(el("div", "profile-section-title", c.display_name));
      card.appendChild(buildGarnishChipEditor(working[c.key], menuDraft.garnish_reference, function (next) {
        working[c.key] = next;
      }));
      body.appendChild(card);
    });

    var saveBtn = el("button", "btn-primary wizard-footer-btn", "Сохранить");
    saveBtn.addEventListener("click", function () {
      saveBtn.disabled = true;
      var keys = Object.keys(working);
      function saveNext(i) {
        if (i >= keys.length) {
          haptic("success");
          keys.forEach(function (k) { menuDraft.garnish[k] = working[k]; });
          wizardBack();
          return;
        }
        api("/api/ops/menu/draft/garnish", { method: "POST", body: { set: keys[i], garnishes: working[keys[i]] } })
          .then(function () { saveNext(i + 1); })
          .catch(function (err) { saveBtn.disabled = false; toast("Не удалось сохранить гарниры: " + err.message); });
      }
      saveNext(0);
    });
    body.appendChild(saveBtn);
  }

  // Найти элемент каталога по ключу сета — тот же массив объектов, что
  // отдаёт /api/ops/menu/draft (menuDraft.catalog), используется и для
  // карточек предпросмотра, и для шага "Фото и описание блюд": один и
  // тот же объект, поэтому правка фото/описания в renderMenuCatalogDetail
  // (ниже) сразу видна и в предпросмотре, без повторной загрузки черновика.
  function _menuDraftCatalogItem(key) {
    for (var i = 0; i < menuDraft.catalog.length; i++) {
      if (menuDraft.catalog[i].key === key) return menuDraft.catalog[i];
    }
    return null;
  }

  // Третий шаг после "Сеты сегодня"/"Гарниры" — фото и состав КАЖДОГО
  // блюда (то, что клиент видит на самой карточке сета при развороте).
  // Отдельно от "Текст и фото рассылки" на хабе — та пара фото/текст это
  // объявление в чате бота, а не карточка сета в приложении.
  function renderMenuDraftDishesStep(body) {
    wizardPhaseEl.innerHTML = "";
    body.appendChild(el("h2", "wizard-title", "Фото и описание блюд"));
    body.appendChild(el("p", "center-note",
      "Фото и состав для каждого сегодняшнего блюда — именно это клиент видит на карточке в приложении. " +
      "Не путать с «Текстом и фото рассылки» на предыдущем экране — это текст объявления в чате бота."));

    var keys = menuDraft.selected_keys.length ? menuDraft.selected_keys : menuDraft.catalog.map(function (c) { return c.key; });
    if (!keys.length) {
      body.appendChild(el("div", "empty-note", "Сначала отметьте сеты на сегодня."));
      return;
    }
    var listCard = el("div", "card profile-nav-list");
    keys.forEach(function (key) {
      var c = _menuDraftCatalogItem(key);
      if (!c) return;
      var missing = [];
      if (!c.photo_url) missing.push("нет фото");
      if (!c.description) missing.push("нет описания");
      var label = c.display_name + (missing.length ? " — ⚠ " + missing.join(", ") : " — ✓ готово");
      listCard.appendChild(buildProfileRow(ICON_CAMERA, label, function () {
        wizardStep(function (b) { renderMenuCatalogDetail(b, c, menuDraft.garnish_reference); });
      }));
    });
    body.appendChild(listCard);
  }

  function renderMenuDraftPhotoStep(body) {
    wizardPhaseEl.innerHTML = "";
    body.appendChild(el("h2", "wizard-title", "Текст и фото рассылки"));
    body.appendChild(el("p", "center-note",
      "Фото и текст объявления, которое бот отправит клиентам о новом меню — не карточки блюд (их фото и " +
      "состав редактируются в «Фото и описание блюд»)."));

    var photoUrls = menuDraft.photo_urls.slice();
    var pendingFiles = [];

    var thumbsWrap = el("div", "menu-draft-photo-row");
    function renderThumbs() {
      thumbsWrap.innerHTML = "";
      photoUrls.forEach(function (u) {
        var img = el("img", "menu-draft-photo-thumb");
        img.alt = "";
        setPhotoSrc(img, u);
        thumbsWrap.appendChild(img);
      });
      pendingFiles.forEach(function (f) {
        var img = el("img", "menu-draft-photo-thumb");
        img.src = URL.createObjectURL(f);
        thumbsWrap.appendChild(img);
      });
    }
    renderThumbs();
    body.appendChild(thumbsWrap);

    body.appendChild(buildPhotoFormatDemo(function () {
      if (pendingFiles.length) return URL.createObjectURL(pendingFiles[pendingFiles.length - 1]);
      return photoUrls[0] || "";
    }));

    var fileInput = el("input");
    fileInput.type = "file";
    fileInput.accept = "image/*";
    fileInput.multiple = true;
    fileInput.style.display = "none";
    var attachBtn = el("button", "btn-ghost", "Выбрать фото (можно несколько)");
    attachBtn.addEventListener("click", function () { fileInput.click(); });
    fileInput.addEventListener("change", function () {
      if (!fileInput.files || !fileInput.files.length) return;
      pendingFiles = Array.prototype.slice.call(fileInput.files);
      photoUrls = [];
      renderThumbs();
    });
    body.appendChild(fileInput);
    body.appendChild(attachBtn);

    var captionField = el("div", "field");
    captionField.innerHTML = '<label>Текст объявления</label><textarea id="menu-draft-caption" rows="4"></textarea>';
    body.appendChild(captionField);
    var captionInput = captionField.querySelector("textarea");
    captionInput.value = menuDraft.caption || "";

    var saveBtn = el("button", "btn-primary wizard-footer-btn", "Сохранить");
    saveBtn.addEventListener("click", function () {
      saveBtn.disabled = true;
      saveBtn.textContent = "Сохраняю…";
      var fd = new FormData();
      fd.append("caption", captionInput.value);
      pendingFiles.forEach(function (f) { fd.append("photo", f, f.name); });
      fetch(API_BASE + "/api/ops/menu/draft/photo", {
        method: "POST", headers: { "X-Telegram-Init-Data": initData() }, body: fd,
      }).then(function (resp) {
        if (!resp.ok) throw new Error("HTTP " + resp.status);
        return resp.json();
      }).then(function (data) {
        haptic("success");
        menuDraft.photo_urls = data.photo_urls;
        menuDraft.caption = data.caption;
        wizardBack();
      }).catch(function (err) {
        saveBtn.disabled = false;
        saveBtn.textContent = "Сохранить";
        toast("Не удалось сохранить: " + err.message);
      });
    });
    body.appendChild(saveBtn);

    if (photoUrls.length || pendingFiles.length) {
      var clearBtn = el("button", "btn-text", "Удалить фото");
      clearBtn.addEventListener("click", function () {
        var fd2 = new FormData();
        fd2.append("clear_photos", "1");
        fd2.append("caption", captionInput.value);
        fetch(API_BASE + "/api/ops/menu/draft/photo", {
          method: "POST", headers: { "X-Telegram-Init-Data": initData() }, body: fd2,
        }).then(function (r) { return r.json(); }).then(function (data) {
          haptic("success");
          menuDraft.photo_urls = [];
          menuDraft.caption = data.caption;
          photoUrls = [];
          pendingFiles = [];
          renderThumbs();
        });
      });
      body.appendChild(clearBtn);
    }
  }

  function buildMenuPreviewItems() {
    var keys = menuDraft.selected_keys.length ? menuDraft.selected_keys : menuDraft.catalog.map(function (c) { return c.key; });
    return keys.map(function (key) {
      var c = null;
      for (var i = 0; i < menuDraft.catalog.length; i++) {
        if (menuDraft.catalog[i].key === key) { c = menuDraft.catalog[i]; break; }
      }
      if (!c) return null;
      var priceText = c.is_group
        ? c.technical_names.map(function (t) { return fmtSum(c.prices[t]); }).join(" / ")
        : fmtSum(c.prices[c.key]);
      return {
        display_name: c.display_name, price_text: priceText,
        garnish_list: menuDraft.garnish[key] || [],
        photo_url: c.photo_url,
        description: c.description ? c.description.split("\n").filter(function (l) { return l.trim(); }) : [],
      };
    }).filter(Boolean);
  }

  // Карточка предпросмотра — визуально ИДЕНТИЧНА клиентской
  // (.menu-set-card/.menu-set-thumb, тот же CSS), но полностью
  // read-only: без выбора гарнира/варианта, без "Добавить в заказ", без
  // избранного — это предпросмотр для админа, а не форма заказа, тап по
  // карточке только разворачивает/сворачивает фото, как и было.
  function buildMenuPreviewCard(item) {
    var card = el("div", "card menu-set-card");
    var expanded = false;
    function render() {
      card.innerHTML = "";
      card.classList.toggle("expanded", expanded);
      if (item.photo_url) {
        var img = el("img", "menu-set-thumb");
        img.alt = "";
        setPhotoSrc(img, item.photo_url);
        card.appendChild(img);
      } else {
        card.appendChild(el("div", "menu-set-thumb menu-set-thumb-empty", ICON_LEAF));
      }
      var cbody = el("div", "menu-set-card-body");
      var head = el("div", "menu-set-card-head");
      head.appendChild(el("div", "menu-set-card-name", escapeHtml(item.display_name)));
      head.appendChild(el("div", "menu-set-card-chevron" + (expanded ? " up" : ""), ICON_CHEVRON));
      cbody.appendChild(head);
      if (item.description.length) {
        var list = el("ul", "menu-set-card-desc");
        item.description.forEach(function (line) { list.appendChild(el("li", null, escapeHtml(line))); });
        cbody.appendChild(list);
      }
      cbody.appendChild(el("div", "menu-set-card-price", item.price_text));
      if (item.garnish_list.length) {
        cbody.appendChild(el("div", "menu-set-card-note", "Гарнир: " + item.garnish_list.map(function (g) { return escapeHtml(g); }).join(", ")));
      }
      card.appendChild(cbody);
    }
    card.addEventListener("click", function () { expanded = !expanded; render(); });
    render();
    return card;
  }

  function renderMenuDraftPreviewStep(body) {
    wizardPhaseEl.innerHTML = "";
    body.appendChild(el("h2", "wizard-title", "Предпросмотр"));
    body.appendChild(el("p", "center-note", "Ровно так сеты увидят клиенты — фото сворачивается/разворачивается по тапу, как в самом приложении."));

    if (menuDraft.photo_urls.length || menuDraft.caption) {
      var annCard = el("div", "card");
      if (menuDraft.photo_urls.length) {
        var row = el("div", "menu-draft-photo-row");
        menuDraft.photo_urls.forEach(function (u) {
          var img = el("img", "menu-draft-photo-thumb");
          img.alt = "";
          setPhotoSrc(img, u);
          row.appendChild(img);
        });
        annCard.appendChild(row);
      }
      if (menuDraft.caption) annCard.appendChild(el("div", "menu-draft-caption", escapeHtml(menuDraft.caption)));
      body.appendChild(annCard);
    }

    var items = buildMenuPreviewItems();
    if (!items.length) {
      body.appendChild(el("div", "empty-note", "Пока нет ни одного выбранного сета."));
    } else {
      items.forEach(function (item) { body.appendChild(buildMenuPreviewCard(item)); });
    }
  }

  // --- "Карточки сетов" — постоянные catalog-атрибуты (фото/описание/
  // гарнир-флаг), НЕ часть черновика меню (см. api_ops_menu_catalog). ---

  function _menuCatalogUrl(key, suffix) {
    return "/api/ops/menu/catalog/" + encodeURIComponent(key) + "/" + suffix;
  }

  function loadMenuCatalogList(root) {
    root.innerHTML = "";
    root.appendChild(el("div", "skeleton-block"));
    api("/api/ops/menu/catalog").then(function (data) {
      root.innerHTML = "";
      var list = el("div", "card profile-nav-list");
      data.sets.forEach(function (c) {
        list.appendChild(buildProfileRow(ICON_CAMERA, c.display_name, function () {
          wizardStep(function (b) { renderMenuCatalogDetail(b, c, data.garnish_reference); });
        }));
      });
      root.appendChild(list);
    }).catch(function (err) {
      root.innerHTML = "";
      root.appendChild(el("div", "empty-note", "Не удалось загрузить каталог: " + err.message));
    });
  }

  function renderMenuCatalogDetail(body, c, garnishReference) {
    wizardPhaseEl.innerHTML = "";
    body.appendChild(el("h2", "wizard-title", c.display_name));

    var photoUrl = c.photo_url;
    var pendingFile = null;
    var thumbWrap = el("div", "menu-draft-photo-row");
    function renderThumb() {
      thumbWrap.innerHTML = "";
      var img = el("img", "menu-draft-photo-thumb");
      img.alt = "";
      if (pendingFile) img.src = URL.createObjectURL(pendingFile);
      else if (photoUrl) setPhotoSrc(img, photoUrl);
      else { thumbWrap.appendChild(el("div", "empty-note", "Фото пока нет")); return; }
      thumbWrap.appendChild(img);
    }
    renderThumb();
    body.appendChild(thumbWrap);

    body.appendChild(buildPhotoFormatDemo(function () {
      if (pendingFile) return URL.createObjectURL(pendingFile);
      return photoUrl || "";
    }));

    var fileInput = el("input");
    fileInput.type = "file";
    fileInput.accept = "image/*";
    fileInput.style.display = "none";
    var attachBtn = el("button", "btn-ghost", "Выбрать фото");
    attachBtn.addEventListener("click", function () { fileInput.click(); });
    fileInput.addEventListener("change", function () {
      if (!fileInput.files || !fileInput.files[0]) return;
      pendingFile = fileInput.files[0];
      renderThumb();
      attachBtn.disabled = true;
      attachBtn.textContent = "Загружаю…";
      apiUpload(_menuCatalogUrl(c.key, "photo"), pendingFile, pendingFile.name).then(function (res) {
        haptic("success");
        photoUrl = res.photo_url;
        c.photo_url = res.photo_url;
        pendingFile = null;
        attachBtn.disabled = false;
        attachBtn.textContent = "Выбрать фото";
        renderThumb();
      }).catch(function (err) {
        attachBtn.disabled = false;
        attachBtn.textContent = "Выбрать фото";
        toast("Не удалось загрузить фото: " + err.message);
      });
    });
    body.appendChild(fileInput);
    body.appendChild(attachBtn);

    var descField = el("div", "field");
    descField.innerHTML = '<label>Описание (состав, каждая строка — отдельный пункт)</label><textarea id="menu-catalog-desc" rows="4"></textarea>';
    body.appendChild(descField);
    var descInput = descField.querySelector("textarea");
    descInput.value = c.description || "";
    var descSaveBtn = el("button", "btn-ghost", "Сохранить описание");
    descSaveBtn.addEventListener("click", function () {
      descSaveBtn.disabled = true;
      api(_menuCatalogUrl(c.key, "description"), { method: "POST", body: { description: descInput.value } }).then(function () {
        haptic("success");
        c.description = descInput.value;
        descSaveBtn.disabled = false;
        toast("Описание сохранено");
      }).catch(function (err) {
        descSaveBtn.disabled = false;
        toast("Не удалось сохранить: " + err.message);
      });
    });
    body.appendChild(descSaveBtn);

    var garnishCard = el("div", "card");
    garnishCard.appendChild(buildToggleRow("Гарнир доступен", "Можно ли вообще выбирать гарнир к этому сету", c.has_garnish, function (next) {
      api(_menuCatalogUrl(c.key, "garnish-flag"), { method: "POST", body: { enabled: next } }).then(function () {
        haptic("success");
        c.has_garnish = next;
      }).catch(function (err) {
        toast("Не удалось сохранить: " + err.message);
      });
    }));
    body.appendChild(garnishCard);

    if (garnishReference && garnishReference.length) {
      body.appendChild(el("p", "center-note", "Справочник гарниров: " + garnishReference.join(", ") + ". Какие именно доступны СЕГОДНЯ — задаётся в \"Меню дня\" → \"Гарниры\"."));
    }
  }

  // --- "Названия для покупателей" — переопределение texts.SET_DISPLAY_
  // NAMES через таблицу (см. sheets.set_set_display_name/display_set_
  // name — единая точка входа, подхватывается ВЕЗДЕ: и в боте, и в PAUSE
  // App, не только на этом экране). Пустое значение = откат к дефолту. ---

  function loadMenuDisplayNames(root) {
    root.innerHTML = "";
    root.appendChild(el("div", "skeleton-block"));
    api("/api/ops/menu/catalog").then(function (data) {
      root.innerHTML = "";
      root.appendChild(el("p", "center-note", "Как сет называется для покупателя — в боте и в приложении. Пусто — вернётся имя по умолчанию."));
      data.sets.forEach(function (c) {
        var card = el("div", "card");
        var techLabel = c.is_group ? c.technical_names.join(" / ") : c.key;
        card.appendChild(el("div", "profile-section-title", techLabel));
        var field = el("div", "field");
        var input = el("input");
        input.type = "text";
        input.value = c.display_name;
        input.placeholder = techLabel;
        field.appendChild(input);
        card.appendChild(field);

        function doSave(value) {
          saveBtn.disabled = true;
          api(_menuCatalogUrl(c.key, "display-name"), { method: "POST", body: { display_name: value } }).then(function () {
            haptic("success");
            toast(value ? "Имя сохранено" : "Сброшено к стандартному");
            // Перезагружаем весь список — после сброса реальное имя по
            // умолчанию (texts.SET_DISPLAY_NAMES или само техническое имя)
            // знает только сервер, локально его не угадать корректно.
            loadMenuDisplayNames(root);
          }).catch(function (err) {
            saveBtn.disabled = false;
            toast("Не удалось сохранить: " + err.message);
          });
        }

        var actionsRow = el("div", "checkout-attach-row");
        var saveBtn = el("button", "btn-ghost", "Сохранить");
        saveBtn.addEventListener("click", function () { doSave(input.value.trim()); });
        var resetBtn = el("button", "btn-text", "Сбросить к стандартному");
        resetBtn.addEventListener("click", function () { doSave(""); });
        actionsRow.appendChild(saveBtn);
        actionsRow.appendChild(resetBtn);
        card.appendChild(actionsRow);

        root.appendChild(card);
      });
    }).catch(function (err) {
      root.innerHTML = "";
      root.appendChild(el("div", "empty-note", "Не удалось загрузить список: " + err.message));
    });
  }

  // --- "Управление Pause Club" — список карточек вкладки Club: порядок,
  // добавление/удаление, правка текста и фото (см. sheets.get_club_cards).
  // Каждое действие сразу уходит на сервер, ответ — актуальный список. ---

  function _clubCardsUrl(id, suffix) {
    return "/api/ops/club/cards" + (id ? "/" + encodeURIComponent(id) : "") + (suffix ? "/" + suffix : "");
  }

  function _clubCardsApply(data) {
    state.clubCards = data.cards || [];
    renderClubNowCards();
    return state.clubCards;
  }

  function renderClubAdminList(body) {
    opsStepHeader(body, "Управление Pause Club");
    body.appendChild(el("p", "center-note", "Карточки блока «Сейчас в клубе» в том порядке, как их видят клиенты."));
    var listRoot = el("div");
    body.appendChild(listRoot);

    function act(promise, after) {
      promise.then(function (data) {
        _clubCardsApply(data);
        if (after) after(); else draw();
      }).catch(function (err) { toast("Не удалось: " + err.message); });
    }

    function draw() {
      listRoot.innerHTML = "";
      var cards = state.clubCards || DEFAULT_CLUB_CARDS;
      if (!cards.length) listRoot.appendChild(el("div", "empty-note", "Карточек нет. Добавьте первую."));
      cards.forEach(function (c, idx) {
        var tx = clubCardTexts(c);
        var row = el("div", "card club-admin-row");
        row.appendChild(el("div", "club-admin-kind", escapeHtml(CLUB_KIND_LABELS[c.kind] || c.kind) + (c.carousel ? " · карусель" : "")));
        row.appendChild(el("div", "club-admin-title", escapeHtml(tx.heading || tx.eyebrow || "Без заголовка")));
        var actions = el("div", "club-admin-actions");
        var up = el("button", "btn-ghost", "↑");
        up.disabled = idx === 0;
        up.addEventListener("click", function () { act(api(_clubCardsUrl(c.id, "move"), { method: "POST", body: { delta: -1 } })); });
        var down = el("button", "btn-ghost", "↓");
        down.disabled = idx === cards.length - 1;
        down.addEventListener("click", function () { act(api(_clubCardsUrl(c.id, "move"), { method: "POST", body: { delta: 1 } })); });
        var edit = el("button", "btn-ghost", "Изменить");
        edit.addEventListener("click", function () { wizardStep(function (b) { renderClubCardEditor(b, c.id); }); });
        var del = el("button", "btn-text", "Удалить");
        del.addEventListener("click", function () {
          showConfirm("Удалить карточку «" + (tx.heading || tx.eyebrow || "без заголовка") + "»?", "Удалить", function () {
            act(api(_clubCardsUrl(c.id, "delete"), { method: "POST", body: {} }));
          });
        });
        [up, down, edit, del].forEach(function (b) { actions.appendChild(b); });
        row.appendChild(actions);
        listRoot.appendChild(row);
      });

      var addBtn = el("button", "btn-primary", "Добавить карточку");
      addBtn.addEventListener("click", function () {
        addBtn.disabled = true;
        api(_clubCardsUrl(""), { method: "POST", body: { kind: "custom" } }).then(function (data) {
          var list = _clubCardsApply(data);
          wizardStep(function (b) { renderClubCardEditor(b, list[list.length - 1].id); });
        }).catch(function (err) { addBtn.disabled = false; toast("Не удалось: " + err.message); });
      });
      listRoot.appendChild(addBtn);

      // Удалённые стандартные карточки можно вернуть.
      var present = {};
      cards.forEach(function (c) { present[c.id] = true; });
      ["pday", "biggift", "top", "moments"].forEach(function (k) {
        if (present[k]) return;
        var restore = el("button", "btn-text", "Вернуть стандартную: " + CLUB_KIND_LABELS[k]);
        restore.addEventListener("click", function () { act(api(_clubCardsUrl(""), { method: "POST", body: { kind: k } })); });
        listRoot.appendChild(restore);
      });
    }
    draw();
  }

  function renderClubCardEditor(body, cardId) {
    var c = (state.clubCards || []).filter(function (x) { return x.id === cardId; })[0];
    if (!c) { body.appendChild(el("div", "empty-note", "Карточка не найдена")); return; }
    var builtin = c.kind !== "custom";
    var defaults = clubCardDefaultTexts(c.kind);
    opsStepHeader(body, CLUB_KIND_LABELS[c.kind] || "Карточка");
    if (builtin) body.appendChild(el("p", "center-note", "Пустое поле — вернётся стандартный текст. Счётчики (участники, дни) можно заменить своим текстом."));
    else body.appendChild(el("p", "center-note", "Пустое поле — этот элемент на карточке не показывается."));

    // Фото — сразу на сервер, отдельно от кнопки «Сохранить».
    var photoWrap = el("div", "menu-draft-photo-row");
    var photoBtns = el("div", "club-admin-actions");
    var attachBtn = el("button", "btn-ghost", "Выбрать фото");
    var removeBtn = el("button", "btn-text", "Удалить фото");
    var fileInput = el("input");
    fileInput.type = "file"; fileInput.accept = "image/*"; fileInput.style.display = "none";
    function drawPhoto() {
      photoWrap.innerHTML = "";
      if (c.photo_url) {
        var img = el("img", "menu-draft-photo-thumb");
        img.alt = "";
        setPhotoSrc(img, c.photo_url);
        photoWrap.appendChild(img);
      } else {
        photoWrap.appendChild(el("div", "empty-note", "Фото нет — сейчас фон-градиент"));
      }
      removeBtn.hidden = !c.photo_url;
    }
    function syncCard(data) {
      var list = _clubCardsApply(data);
      c = list.filter(function (x) { return x.id === cardId; })[0] || c;
      drawPhoto();
    }
    attachBtn.addEventListener("click", function () { fileInput.click(); });
    fileInput.addEventListener("change", function () {
      if (!fileInput.files || !fileInput.files[0]) return;
      var f = fileInput.files[0];
      attachBtn.disabled = true;
      attachBtn.textContent = "Загружаю…";
      apiUpload(_clubCardsUrl(cardId, "photo"), f, f.name).then(function (data) {
        haptic("success");
        syncCard(data);
      }).catch(function (err) {
        toast("Не удалось загрузить фото: " + err.message);
      }).then(function () {
        attachBtn.disabled = false;
        attachBtn.textContent = "Выбрать фото";
        fileInput.value = "";
      });
    });
    removeBtn.addEventListener("click", function () {
      api(_clubCardsUrl(cardId, "photo/delete"), { method: "POST", body: {} }).then(syncCard).catch(function (err) { toast("Не удалось: " + err.message); });
    });
    body.appendChild(photoWrap);
    body.appendChild(el("div", "field-hint", "Фото: альбомное, примерно 4:3 (от 1600 px по длинной стороне), JPEG до 500 КБ, главное — по центру. Лучше тёмное: текст на карточке светлый (поверх фото добавляется затемнение)."));
    photoBtns.appendChild(attachBtn);
    photoBtns.appendChild(removeBtn);
    body.appendChild(photoBtns);
    body.appendChild(fileInput);
    drawPhoto();

    var FIELDS = [
      ["eyebrow", "Надпись над заголовком", "input"],
      ["heading", "Заголовок", "input"],
      ["desc", "Описание", "textarea"],
      ["cta", "Текст кнопки", "input"],
      ["stat1", "Строка внизу — 1", "input"],
      ["stat2", "Строка внизу — 2", "input"],
    ];
    var inputs = {};
    FIELDS.forEach(function (f) {
      var wrap = el("div", "field");
      wrap.appendChild(el("label", null, f[1]));
      var inp = el(f[2]);
      if (f[2] === "input") inp.type = "text"; else inp.rows = 4;
      inp.value = c[f[0]] || (builtin ? defaults[f[0]] : "");
      inp.placeholder = builtin ? defaults[f[0]] : "";
      wrap.appendChild(inp);
      body.appendChild(wrap);
      inputs[f[0]] = inp;
    });

    // Цвет фона (пока нет фото) — те же четыре оттенка палитры бренда.
    var colorWrap = el("div", "field");
    colorWrap.appendChild(el("label", null, "Цвет карточки"));
    var colorRow = el("div", "club-admin-actions");
    var color = c.color || "green";
    var colorBtns = {};
    Object.keys(CLUB_COLOR_LABELS).forEach(function (k) {
      var b = el("button", "btn-ghost" + (k === color ? " active" : ""), CLUB_COLOR_LABELS[k]);
      b.addEventListener("click", function () {
        color = k;
        Object.keys(colorBtns).forEach(function (kk) { colorBtns[kk].classList.toggle("active", kk === k); });
      });
      colorBtns[k] = b;
      colorRow.appendChild(b);
    });
    colorWrap.appendChild(colorRow);
    body.appendChild(colorWrap);

    var carousel = !!c.carousel;
    var carCard = el("div", "card");
    carCard.appendChild(buildToggleRow("Слайд карусели", "Соседние карточки с этой галочкой листаются свайпом в одном месте", carousel, function (next) { carousel = next; }));
    body.appendChild(carCard);

    var saveBtn = el("button", "btn-primary", "Сохранить");
    saveBtn.addEventListener("click", function () {
      // Встроенной карточке уходит только то, что админ реально изменил, —
      // иначе стандартный текст "прилип" бы к одному языку навсегда.
      var payload = { color: color, carousel: carousel };
      FIELDS.forEach(function (f) {
        var v = inputs[f[0]].value.trim();
        payload[f[0]] = (builtin && v === defaults[f[0]]) ? "" : v;
      });
      saveBtn.disabled = true;
      api(_clubCardsUrl(cardId), { method: "POST", body: payload }).then(function (data) {
        haptic("success");
        _clubCardsApply(data);
        saveBtn.disabled = false;
        toast("Сохранено");
        wizardBack();
      }).catch(function (err) {
        saveBtn.disabled = false;
        toast("Не удалось сохранить: " + err.message);
      });
    });
    body.appendChild(saveBtn);
  }

  // Розыгрыш "Пауза в подарок" — полная история победителей (см.
  // pauseapp.py: api_ops_giveaway -> sheets.get_all_tickets), новые
  // сверху, с тем же статусом "Доступен"/"Использован", что и в самом
  // листе "Билеты клиентов" — экран admin-only, без i18n (как остальные
  // экраны Операционного центра).
  function loadOpsGiveaway(root) {
    root.innerHTML = "";
    root.appendChild(el("div", "skeleton-block"));
    api("/api/ops/giveaway").then(function (data) {
      root.innerHTML = "";
      var tickets = data.tickets || [];
      if (!tickets.length) {
        root.appendChild(el("div", "empty-note", "Пока ни одного победителя — розыгрыш подводится каждый день в 12:00."));
        return;
      }
      tickets.forEach(function (tk) {
        var used = tk.status === "Использован";
        var card = el("div", "card");
        card.innerHTML =
          '<div style="font-weight:600">' + escapeHtml(tk.name || ("ID " + tk.client_id)) + '</div>' +
          '<div class="option-row-sub">Выигран ' + escapeHtml(tk.date_won) + '</div>' +
          '<div class="option-row-sub">' + (used
            ? "Билет использован" + (tk.date_used ? " (" + escapeHtml(tk.date_used) + ")" : "")
            : "Билет доступен, пока не потрачен") + '</div>';
        root.appendChild(card);
      });
    }).catch(function (err) {
      root.innerHTML = "";
      root.appendChild(el("div", "empty-note", "Не удалось загрузить историю розыгрыша: " + err.message));
    });
  }

  function _opsFmtDate(d) {
    var dd = String(d.getDate()).padStart(2, "0");
    var mm = String(d.getMonth() + 1).padStart(2, "0");
    return dd + "." + mm + "." + d.getFullYear();
  }
  function _opsRuToIso(ru) {
    var p = (ru || "").split(".");
    return p.length === 3 ? (p[2] + "-" + p[1] + "-" + p[0]) : "";
  }
  function _opsIsoToRu(iso) {
    var p = (iso || "").split("-");
    return p.length === 3 ? (p[2] + "." + p[1] + "." + p[0]) : "";
  }
  var OPS_PAY_FILTERS = [
    { key: "", label: "Все" },
    { key: "paid", label: "Оплачено" },
    { key: "unpaid", label: "Не оплачено" },
    { key: "review", label: "На проверке" },
  ];

  // Телефон хранится как "+998 91 776 34 09" (см. sheets.format_uz_phone)
  // — здесь только визуально отделяем код страны от самого номера, как
  // попросили: "+998 - 91 776 34 09".
  function _opsFmtPhone(phone) {
    var p = (phone || "").trim();
    if (p.indexOf("+998") !== 0) return p;
    var rest = p.slice(4).trim();
    return rest ? "+998 - " + rest : "+998";
  }
  function _opsTelHref(phone) {
    var digits = (phone || "").replace(/[^\d+]/g, "");
    return digits ? "tel:" + digits : "";
  }
  // "Написать" (Должники/CRM) — обычная window.location.href на
  // "tg://user?id=..." внутри Mini App WebView молча ничего не делала:
  // кастомные URL-схемы там не резолвятся как во внешнем браузере,
  // воспроизведено и подтверждено. Для https://t.me/<юзернейм>
  // официальный способ открыть чат из Mini App — WebApp.openTelegramLink,
  // он единственный надёжно работает на всех платформах; tg://user?id=
  // (когда юзернейма нет вообще) этот метод не принимает (нужен именно
  // https://t.me/ домен), поэтому для него оставляем обычную навигацию
  // как единственный доступный вариант — хуже, но хоть что-то.
  function openTelegramChat(link) {
    if (!link) return;
    if (link.indexOf("https://t.me/") === 0 && tg && tg.openTelegramLink) {
      tg.openTelegramLink(link);
    } else {
      window.location.href = link;
    }
  }
  var ICON_OPS_MESSAGE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" width="18" height="18" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M4 7l8 6 8-6"/></svg>';
  var ICON_OPS_CALL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" width="18" height="18" stroke-linecap="round" stroke-linejoin="round"><path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4c0 1.1-0.9 2-2 2C9.6 21 3 14.4 3 6c0-1.1 0.9-2 2-2z"/></svg>';

  // Плашка сводки 2×2 (люди/заказы/выручка/прибыль) — та же плитка, что
  // уже использовалась в Профиле ("Мои заказы"), .profile-stat-clickable
  // даёт нажимаемый вид, своей CSS для этого не нужно. sub — необязательная
  // мелкая строка под основным числом (сумма маржи у "Валовая прибыль"/
  // "Чистая прибыль", см. вызовы ниже) — сама сумма прибыли (value) от
  // неё не зависит и не меняется.
  function opsStatTile(value, label, onClick, sub) {
    var tile = el("div", "profile-stat profile-stat-clickable");
    tile.innerHTML = '<div class="profile-stat-value">' + value + '</div>' +
      (sub ? '<div class="ops-stat-sub">' + sub + '</div>' : '') +
      '<div class="profile-stat-label">' + label + '</div>';
    tile.addEventListener("click", function () { haptic("select"); onClick(); });
    return tile;
  }

  // Детальный экран по одной из трёх плашек "по сетам" (заказы-%,
  // выручка, прибыль) — разные только значение в строке и итог внизу.
  function renderOpsSetBreakdownDetail(body, summary, valueFn, total) {
    if (!summary.by_set.length) {
      body.appendChild(el("div", "empty-note", "За этот период заказов нет."));
      return;
    }
    var card = el("div", "card");
    summary.by_set.forEach(function (s, idx) {
      var row = el("div", "ops-breakdown-row" + (idx ? " ops-breakdown-row-sep" : ""));
      row.innerHTML =
        '<div class="ops-breakdown-name">' + escapeHtml(s.display_name) + '</div>' +
        '<div class="ops-breakdown-nums"><span>' + s.qty + ' шт</span><span>' + valueFn(s) + '</span></div>';
      card.appendChild(row);
    });
    body.appendChild(card);
    if (total !== undefined) {
      body.appendChild(el("div", "ops-debtor-total", "Итого: " + fmtSum(total)));
    }
  }

  // Детальный экран "Кто заказал" — имя клиента и какие сеты/сколько штук.
  function renderOpsPeopleDetail(body, summary) {
    if (!summary.people.length) {
      body.appendChild(el("div", "empty-note", "За этот период заказов нет."));
      return;
    }
    summary.people.forEach(function (p) {
      var card = el("div", "card");
      var setsText = p.sets.map(function (s) { return s.qty + "× " + s.display_name; }).join(", ");
      card.innerHTML =
        '<div class="ops-order-name">' + escapeHtml(p.name) + '</div>' +
        '<div class="order-card-items">' + escapeHtml(setsText) + '</div>';
      body.appendChild(card);
    });
  }

  // Детальный экран "Чистая прибыль" — валовая прибыль минус расходы на
  // доставку через сторонние сервисы (вводятся в Mini App "Маршрут",
  // "Профиль" → "Расходы на логистику", см. sheets.get_delivery_expense_total).
  function renderOpsNetProfitDetail(body, summary) {
    var card = el("div", "card");
    var row = function (label, value, sep) {
      var r = el("div", "ops-breakdown-row" + (sep ? " ops-breakdown-row-sep" : ""));
      r.innerHTML =
        '<div class="ops-breakdown-name">' + escapeHtml(label) + '</div>' +
        '<div class="ops-breakdown-nums"><span>' + fmtSum(value) + '</span></div>';
      return r;
    };
    card.appendChild(row("Валовая прибыль", summary.profit, false));
    card.appendChild(row("Доставка", summary.delivery_cost, true));
    body.appendChild(card);
    body.appendChild(el("div", "ops-debtor-total", "Чистая прибыль: " + fmtSum(summary.net_profit)));
  }

  function loadOpsFinance(root) {
    var ops = {
      period: "today",
      customFrom: _opsFmtDate(new Date()),
      customTo: _opsFmtDate(new Date()),
      status: "", set: "", zone: "", q: "",
    };
    var reqId = 0;
    var searchTimer = null;

    function range() {
      var today = new Date();
      if (ops.period === "custom") return { from: ops.customFrom, to: ops.customTo };
      if (ops.period === "yesterday") {
        var y = new Date(today);
        y.setDate(y.getDate() - 1);
        return { from: _opsFmtDate(y), to: _opsFmtDate(y) };
      }
      var from = new Date(today);
      if (ops.period === "7d") from.setDate(from.getDate() - 6);
      else if (ops.period === "30d") from.setDate(from.getDate() - 29);
      return { from: _opsFmtDate(from), to: _opsFmtDate(today) };
    }

    function qs(obj) {
      return Object.keys(obj).filter(function (k) { return obj[k]; })
        .map(function (k) { return encodeURIComponent(k) + "=" + encodeURIComponent(obj[k]); })
        .join("&");
    }

    function payStatusLabel(key) {
      var f = OPS_PAY_FILTERS.filter(function (x) { return x.key === key; })[0];
      return f ? f.label : key;
    }
    function payPillClass(key) {
      if (key === "paid") return "pill paid";
      if (key === "review") return "pill gold";
      return "pill unpaid";
    }

    function render() {
      var r = range();
      var myReq = ++reqId;
      root.innerHTML = "";

      // --- период ---
      var periodChips = el("div", "feed-filters");
      [["today", "Сегодня"], ["yesterday", "Вчера"], ["7d", "7 дней"], ["30d", "30 дней"], ["custom", "Свой период"]].forEach(function (p) {
        var chip = el("button", "filter-chip" + (ops.period === p[0] ? " active" : ""), p[1]);
        chip.addEventListener("click", function () { ops.period = p[0]; render(); });
        periodChips.appendChild(chip);
      });
      root.appendChild(periodChips);

      if (ops.period === "custom") {
        var rangeRow = el("div", "ops-range-row");
        var fromField = el("div", "field");
        fromField.innerHTML = '<label>С</label>';
        var fromInput = el("input"); fromInput.type = "date"; fromInput.value = _opsRuToIso(ops.customFrom);
        fromInput.addEventListener("change", function () { ops.customFrom = _opsIsoToRu(fromInput.value) || ops.customFrom; render(); });
        fromField.appendChild(fromInput);
        var toField = el("div", "field");
        toField.innerHTML = '<label>По</label>';
        var toInput = el("input"); toInput.type = "date"; toInput.value = _opsRuToIso(ops.customTo);
        toInput.addEventListener("change", function () { ops.customTo = _opsIsoToRu(toInput.value) || ops.customTo; render(); });
        toField.appendChild(toInput);
        rangeRow.appendChild(fromField); rangeRow.appendChild(toField);
        root.appendChild(rangeRow);
      }

      var body = el("div");
      body.appendChild(el("div", "skeleton-block"));
      body.appendChild(el("div", "skeleton-block"));
      root.appendChild(body);

      Promise.all([
        api("/api/ops/summary?" + qs({ from: r.from, to: r.to })),
        api("/api/ops/orders?" + qs({ from: r.from, to: r.to, status: ops.status, set: ops.set, zone: ops.zone, q: ops.q })),
      ]).then(function (results) {
        if (myReq !== reqId) return;
        renderBody(body, results[0], results[1]);
      }).catch(function (err) {
        if (myReq !== reqId) return;
        body.innerHTML = "";
        body.appendChild(el("div", "empty-note", "Не удалось загрузить данные: " + err.message));
      });
    }

    function renderBody(body, summary, ordersData) {
      body.innerHTML = "";

      // --- сводка: 4 кликабельные плашки, 2×2 ---
      var statGrid = el("div", "ops-stat-grid");
      statGrid.appendChild(opsStatTile(summary.people_count, "человек", function () {
        wizardStep(function (b) { opsStepHeader(b, "Кто заказал"); renderOpsPeopleDetail(b, summary); });
      }));
      statGrid.appendChild(opsStatTile(summary.order_count, "заказов", function () {
        wizardStep(function (b) {
          opsStepHeader(b, "Заказы по сетам");
          renderOpsSetBreakdownDetail(b, summary, function (s) { return s.pct + "%"; });
        });
      }));
      statGrid.appendChild(opsStatTile(fmtSum(summary.revenue), "выручка", function () {
        wizardStep(function (b) {
          opsStepHeader(b, "Выручка по сетам");
          renderOpsSetBreakdownDetail(b, summary, function (s) { return fmtSum(s.revenue); }, summary.revenue);
        });
      }));
      statGrid.appendChild(opsStatTile(fmtSum(summary.profit), "валовая прибыль", function () {
        wizardStep(function (b) {
          opsStepHeader(b, "Валовая прибыль по сетам");
          renderOpsSetBreakdownDetail(b, summary, function (s) { return fmtSum(s.profit); }, summary.profit);
        });
      }, summary.profit_margin_pct + "%"));
      statGrid.appendChild(opsStatTile(fmtSum(summary.kitchen), "к оплате кухне", function () {
        wizardStep(function (b) {
          opsStepHeader(b, "К оплате кухне по сетам");
          renderOpsSetBreakdownDetail(b, summary, function (s) { return fmtSum(s.kitchen); }, summary.kitchen);
        });
      }));
      statGrid.appendChild(opsStatTile(fmtSum(summary.net_profit), "чистая прибыль", function () {
        wizardStep(function (b) { opsStepHeader(b, "Чистая прибыль"); renderOpsNetProfitDetail(b, summary); });
      }, summary.net_margin_pct + "%"));
      body.appendChild(statGrid);

      // --- разбивка по районам ---
      body.appendChild(el("h3", "ops-section-title", "По районам"));
      if (summary.by_zone.length) {
        var zonesCard = el("div", "card");
        summary.by_zone.forEach(function (z, idx) {
          var row = el("div", "ops-breakdown-row" + (idx ? " ops-breakdown-row-sep" : ""));
          row.innerHTML =
            '<div class="ops-breakdown-name">' + escapeHtml(z.zone) + '</div>' +
            '<div class="ops-breakdown-nums"><span>' + z.order_count + ' зак.</span><span>' + fmtSum(z.revenue) + '</span></div>';
          zonesCard.appendChild(row);
        });
        body.appendChild(zonesCard);
      }

      // --- фильтры списка заказов ---
      body.appendChild(el("h3", "ops-section-title", "Заказы"));

      var statusChips = el("div", "feed-filters");
      OPS_PAY_FILTERS.forEach(function (f) {
        var chip = el("button", "filter-chip" + (ops.status === f.key ? " active" : ""), f.label);
        chip.addEventListener("click", function () { ops.status = f.key; render(); });
        statusChips.appendChild(chip);
      });
      body.appendChild(statusChips);

      var selectRow = el("div", "ops-select-row");
      var setField = el("div", "field");
      setField.innerHTML = '<label>Сет</label>';
      var setSelect = el("select");
      setSelect.appendChild(el("option", null, "Все"));
      summary.by_set.forEach(function (s) {
        var opt = document.createElement("option");
        opt.value = s.display_name;
        opt.textContent = s.display_name;
        setSelect.appendChild(opt);
      });
      setSelect.value = ops.set;
      setSelect.addEventListener("change", function () { ops.set = setSelect.value; render(); });
      setField.appendChild(setSelect);

      var zoneField = el("div", "field");
      zoneField.innerHTML = '<label>Район</label>';
      var zoneSelect = el("select");
      zoneSelect.appendChild(el("option", null, "Все"));
      summary.by_zone.forEach(function (z) {
        var opt = document.createElement("option");
        opt.value = z.zone;
        opt.textContent = z.zone;
        zoneSelect.appendChild(opt);
      });
      zoneSelect.value = ops.zone;
      zoneSelect.addEventListener("change", function () { ops.zone = zoneSelect.value; render(); });
      zoneField.appendChild(zoneSelect);

      selectRow.appendChild(setField); selectRow.appendChild(zoneField);
      body.appendChild(selectRow);

      var searchField = el("div", "field");
      searchField.innerHTML = '<label>Поиск по имени клиента</label>';
      var searchInput = el("input");
      searchInput.type = "text";
      searchInput.placeholder = "Введите имя…";
      searchInput.value = ops.q;
      searchInput.addEventListener("input", function () {
        clearTimeout(searchTimer);
        var val = searchInput.value;
        searchTimer = setTimeout(function () { ops.q = val; render(); }, 400);
      });
      searchField.appendChild(searchInput);
      body.appendChild(searchField);

      // --- список заказов ---
      if (!ordersData.orders.length) {
        body.appendChild(el("div", "empty-note", "Ничего не нашлось по этим фильтрам."));
        return;
      }
      ordersData.orders.forEach(function (o) {
        var card = el("div", "card");
        var itemsText = o.items.map(function (it) {
          return it.qty + "× " + it.display_name + (it.garnish ? " (" + it.garnish + ")" : "");
        }).join(", ");
        card.innerHTML =
          '<div class="order-card-head">' +
            '<span class="order-card-date">' + o.date + '</span>' +
            '<span class="order-card-pills"><span class="' + payPillClass(o.pay_status) + '">' + payStatusLabel(o.pay_status) + '</span></span>' +
          '</div>' +
          '<div class="ops-order-name">' + escapeHtml(o.name) + '</div>' +
          '<div class="ops-order-zone">' + escapeHtml(o.zone) + (o.point ? ", " + escapeHtml(o.point) : "") + '</div>' +
          '<div class="order-card-items">' + escapeHtml(itemsText) + '</div>' +
          '<div class="ops-order-sum">' + fmtSum(o.sum) + '</div>';
        body.appendChild(card);
      });
    }

    render();
  }

  // --- Операционный центр → Доставки ----------------------------------------
  // Платная доставка (см. sheets.get_delivery_overview): сколько начислено,
  // оплачено, ждёт подтверждения и висит в долге — за выбранный период.
  var DLV_STATE_LABEL = { paid: "Оплачена", review: "Ждёт подтверждения", debt: "В долг", unpaid: "Не оплачена" };

  function loadOpsDelivery(root) {
    var days = 0; // 0 = сегодня
    function load() {
      root.innerHTML = "";
      root.appendChild(el("div", "skeleton-block"));
      var to = new Date(), from = new Date();
      from.setDate(from.getDate() - days);
      api("/api/ops/delivery?from=" + _opsFmtDate(from) + "&to=" + _opsFmtDate(to)).then(function (data) {
        root.innerHTML = "";
        var chips = el("div", "feed-filters");
        [[0, "Сегодня"], [6, "7 дней"], [29, "30 дней"]].forEach(function (f) {
          var chip = el("button", "filter-chip" + (days === f[0] ? " active" : ""), f[1]);
          chip.addEventListener("click", function () { days = f[0]; load(); });
          chips.appendChild(chip);
        });
        root.appendChild(chips);

        var sm = data.summary || {};
        var hero = el("div", "dlv-hero");
        hero.innerHTML =
          '<div class="dlv-hero-label">Начислено за доставку</div>' +
          '<div class="dlv-hero-value">' + fmtSum(sm.accrued || 0) + '</div>' +
          '<div class="dlv-hero-sub">' + (sm.count || 0) + ' заказов с платной доставкой</div>';
        root.appendChild(hero);

        var grid = el("div", "dlv-grid");
        [["paid", "Оплачено", sm.paid], ["review", "Ждёт подтверждения", sm.review],
         ["debt", "В долг", sm.debt], ["unpaid", "Не оплачено", sm.unpaid]].forEach(function (c) {
          var tile = el("div", "dlv-tile dlv-" + c[0]);
          tile.innerHTML = '<div class="dlv-tile-value">' + fmtSum(c[2] || 0) + '</div><div class="dlv-tile-label">' + c[1] + '</div>';
          grid.appendChild(tile);
        });
        root.appendChild(grid);

        if (!data.items.length) {
          root.appendChild(el("div", "empty-note", "За этот период платных доставок нет."));
          return;
        }
        root.appendChild(el("h3", "ops-section-title", "Заказы с доставкой"));
        data.items.forEach(function (it) {
          var card = el("div", "card dlv-row");
          card.innerHTML =
            '<div class="dlv-row-main"><div class="dlv-row-name">' + escapeHtml(it.name) + '</div>' +
            '<div class="dlv-row-sub">' + escapeHtml(it.date) + (it.point ? " · " + escapeHtml(it.point) : "") + '</div></div>' +
            '<div class="dlv-row-right"><div class="dlv-row-fee">' + fmtSum(it.fee) + '</div>' +
            '<span class="dlv-badge dlv-' + it.state + '">' + DLV_STATE_LABEL[it.state] + '</span></div>';
          if (it.state === "debt" && it.client_id && (state.isMainAdmin || state.paDebtors)) {
            card.classList.add("dlv-row-click");
            card.addEventListener("click", function () {
              haptic("select");
              wizardStep(function (body) {
                opsStepHeader(body, it.name);
                var sub = el("div");
                sub.appendChild(el("div", "skeleton-block"));
                body.appendChild(sub);
                loadOpsDebtorDetail(sub, it.client_id);
              });
            });
          }
          root.appendChild(card);
        });
      }).catch(function (err) {
        root.innerHTML = "";
        root.appendChild(el("div", "empty-note", "Не удалось загрузить доставки: " + err.message));
      });
    }
    load();
  }

  // --- Операционный центр → Должники ----------------------------------------
  // Сам долг по-прежнему считается на сервере из "Заказы" (не дублируем
  // подсчёт на фронте) — здесь только отображение + комментарии/
  // напоминания, которые хранятся в отдельных листах (см. pauseapp.py:
  // api_ops_debtor_*). "Написать" — через tg://user?id=... (настоящий
  // Telegram ID клиента, не вписанный вручную текст "юзернейма" в CRM),
  // этот URI-scheme Telegram-клиент перехватывает сам и открывает чат —
  // поэтому обычная навигация (location.href), а не window.open: попапы
  // в WebView Telegram часто просто блокируются.

  function loadOpsDebtorsList(root) {
    root.innerHTML = "";
    root.appendChild(el("div", "skeleton-block"));
    api("/api/ops/debtors").then(function (data) {
      root.innerHTML = "";
      if (!data.debtors.length) {
        root.appendChild(el("div", "empty-note", "Должников нет — приятная новость 🪴"));
        return;
      }
      var totalDebt = data.debtors.reduce(function (sum, d) { return sum + d.sum; }, 0);
      var totalRow = el("div", "profile-stat-row");
      var totalTile = el("div", "profile-stat");
      totalTile.innerHTML =
        '<div class="profile-stat-value">' + fmtSum(totalDebt) + '</div>' +
        '<div class="profile-stat-label">Общая сумма долгов</div>';
      totalRow.appendChild(totalTile);
      root.appendChild(totalRow);

      data.debtors.forEach(function (d) {
        var card = el("div", "card ops-debtor-row");
        card.innerHTML =
          '<div class="ops-debtor-name">' + escapeHtml(d.name) + '</div>' +
          '<div class="ops-debtor-sum">' + fmtSum(d.sum) + '</div>';
        card.addEventListener("click", function () {
          haptic("select");
          wizardStep(function (body) {
            opsStepHeader(body, d.name);
            var sub = el("div");
            sub.appendChild(el("div", "skeleton-block"));
            body.appendChild(sub);
            loadOpsDebtorDetail(sub, d.id);
          });
        });
        root.appendChild(card);
      });
    }).catch(function (err) {
      root.innerHTML = "";
      root.appendChild(el("div", "empty-note", "Не удалось загрузить список должников: " + err.message));
    });
  }

  function loadOpsDebtorDetail(root, clientId) {
    function load() {
      root.innerHTML = "";
      root.appendChild(el("div", "skeleton-block"));
      api("/api/ops/debtors/" + encodeURIComponent(clientId)).then(function (data) {
        render(data);
      }).catch(function (err) {
        root.innerHTML = "";
        root.appendChild(el("div", "empty-note", "Не удалось загрузить данные: " + err.message));
      });
    }

    function render(data) {
      root.innerHTML = "";

      // --- карточка клиента ---
      var card = el("div", "card");
      var cardBody = el("div");
      cardBody.innerHTML =
        '<div class="ops-debtor-card-name">' + escapeHtml(data.name) + '</div>' +
        (data.phone ? '<div class="ops-debtor-card-line">' + escapeHtml(_opsFmtPhone(data.phone)) + '</div>' : "") +
        (data.telegram ? '<div class="ops-debtor-card-line">@' + escapeHtml(data.telegram.replace(/^@/, "")) + '</div>' : "");
      card.appendChild(cardBody);

      var actionsRow = el("div", "ops-contact-actions");
      var writeBtn = el("button", "ops-contact-btn ops-contact-btn-primary");
      writeBtn.innerHTML = ICON_OPS_MESSAGE + '<span>Написать</span>';
      if (data.tg_link) {
        writeBtn.addEventListener("click", function () { openTelegramChat(data.tg_link); });
      } else {
        writeBtn.disabled = true;
        writeBtn.title = "Телеграм не привязан — юзер скрыт";
      }
      // "Позвонить" — обычная <a href="tel:..."> (не window.location.href
      // программно): именно ссылку с tel: надёжно подхватывает системный
      // диалер и на Android, и на iOS внутри Telegram WebView, а
      // программная JS-навигация на tel: на части устройств не срабатывает.
      var telHref = _opsTelHref(data.phone);
      var callBtn;
      if (telHref) {
        callBtn = document.createElement("a");
        callBtn.href = telHref;
        callBtn.className = "ops-contact-btn";
      } else {
        callBtn = el("button", "ops-contact-btn");
        callBtn.disabled = true;
        callBtn.title = "Номер телефона не указан";
      }
      callBtn.innerHTML = ICON_OPS_CALL + '<span>Позвонить</span>';
      actionsRow.appendChild(writeBtn);
      actionsRow.appendChild(callBtn);
      card.appendChild(actionsRow);
      root.appendChild(card);

      // --- история долга ---
      // Чекбоксы — только у непогашенных строк, для частичной оплаты
      // ("отметил несколько дней — одной кнопкой Оплатить отмеченные").
      // "Закрыть весь долг" рядом — тот же самый массовый эндпоинт
      // (/lines/pay), просто со ВСЕМИ непогашенными row сразу, без
      // необходимости сначала всё отмечать галочками по одной.
      var selected = new Set();
      root.appendChild(el("h3", "ops-section-title", "История долга"));
      var linesCard = el("div", "card");
      var unresolvedLines = data.lines.filter(function (l) { return !l.resolved; });
      if (data.lines.length) {
        data.lines.forEach(function (l, idx) {
          var row = el("div", "ops-debt-line" + (idx ? " ops-breakdown-row-sep" : "") + (l.resolved ? " ops-debt-line-resolved" : ""));
          if (!l.resolved) {
            var cb = document.createElement("input");
            cb.type = "checkbox";
            cb.className = "ops-debt-line-check";
            cb.addEventListener("change", function () {
              if (cb.checked) selected.add(l.row); else selected.delete(l.row);
              updateBulkPayBtn();
            });
            row.appendChild(cb);
          }
          var info = el("div", "ops-debt-line-info");
          info.innerHTML =
            '<div class="ops-breakdown-name">' + l.date + ' — ' + escapeHtml(l.display_name) + (l.qty && l.qty !== "0" ? ' ×' + l.qty : '') + '</div>' +
            (l.delivery ? '<div class="ops-debt-line-dlv">в т.ч. доставка ' + fmtSum(l.delivery) + '</div>' : '');
          var sumBtn = el("button", "ops-debt-line-sum", fmtSum(l.sum));
          if (l.resolved) {
            sumBtn.disabled = true;
          } else {
            sumBtn.addEventListener("click", function () {
              showConfirm(
                "Отметить " + l.date + " (" + fmtSum(l.sum) + ") оплаченным?",
                "Оплатил",
                function () {
                  hideConfirm();
                  api("/api/ops/debtors/" + encodeURIComponent(clientId) + "/line/pay", { method: "POST", body: { row: l.row } })
                    .then(function () { load(); })
                    .catch(function (err) { toast("Не удалось сохранить: " + err.message); });
                }
              );
            });
          }
          row.appendChild(info);
          row.appendChild(sumBtn);
          if (l.resolved) {
            var unpayBtn = el("button", "btn-text ops-debt-line-unpay", "Отменить оплату");
            unpayBtn.addEventListener("click", function () {
              showConfirm(
                "Отменить отметку оплаты за " + l.date + "?",
                "Отменить",
                function () {
                  hideConfirm();
                  api("/api/ops/debtors/" + encodeURIComponent(clientId) + "/line/unpay", { method: "POST", body: { row: l.row } })
                    .then(function () { load(); })
                    .catch(function (err) { toast("Не удалось отменить: " + err.message); });
                }
              );
            });
            row.appendChild(unpayBtn);
          }
          linesCard.appendChild(row);
        });
      } else {
        linesCard.appendChild(el("div", "empty-note", "Долгов не найдено."));
      }
      root.appendChild(linesCard);
      root.appendChild(el("div", "ops-debtor-total", "Итого долг: " + fmtSum(data.total)));

      function bulkPay(rows, confirmText) {
        showConfirm(confirmText, "Оплатил", function () {
          hideConfirm();
          api("/api/ops/debtors/" + encodeURIComponent(clientId) + "/lines/pay", { method: "POST", body: { rows: rows } })
            .then(function () { haptic("success"); load(); })
            .catch(function (err) { toast("Не удалось сохранить: " + err.message); });
        });
      }

      var bulkPayBtn = null;
      function updateBulkPayBtn() {
        if (!bulkPayBtn) return;
        var n = selected.size;
        bulkPayBtn.disabled = n === 0;
        bulkPayBtn.textContent = n ? "Оплатить отмеченные (" + n + ")" : "Оплатить отмеченные";
      }

      if (unresolvedLines.length) {
        bulkPayBtn = el("button", "btn-ghost ops-debt-bulk-btn", "Оплатить отмеченные");
        bulkPayBtn.disabled = true;
        bulkPayBtn.addEventListener("click", function () {
          var rows = Array.from(selected);
          var sum = data.lines.filter(function (l) { return rows.indexOf(l.row) !== -1; }).reduce(function (s, l) { return s + l.sum; }, 0);
          bulkPay(rows, "Отметить оплаченными выбранные дни (" + rows.length + ") на сумму " + fmtSum(sum) + "?");
        });
        root.appendChild(bulkPayBtn);

        var closeAllBtn = el("button", "ops-close-debt-btn", "Закрыть весь долг");
        closeAllBtn.addEventListener("click", function () {
          var rows = unresolvedLines.map(function (l) { return l.row; });
          bulkPay(rows, "Точно хотите закрыть весь долг (" + fmtSum(data.total) + ") целиком?");
        });
        root.appendChild(closeAllBtn);
      }

      // --- комментарии ---
      root.appendChild(el("h3", "ops-section-title", "Комментарии"));
      var commentBox = el("div", "ops-input-box ops-input-box-comment");
      var commentField = el("div", "field");
      var commentInput = el("textarea");
      commentInput.rows = 2;
      commentField.appendChild(commentInput);
      commentBox.appendChild(commentField);
      commentBox.appendChild(el("div", "ops-field-hint", "Пример: обещал отдать 5 числа"));
      var addCommentBtn = el("button", "btn-ghost", "Добавить комментарий");
      addCommentBtn.addEventListener("click", function () {
        var text = commentInput.value.trim();
        if (!text) return;
        addCommentBtn.disabled = true;
        api("/api/ops/debtors/" + encodeURIComponent(clientId) + "/comment", { method: "POST", body: { text: text } })
          .then(function () { load(); })
          .catch(function (err) { addCommentBtn.disabled = false; toast("Не удалось сохранить: " + err.message); });
      });
      commentBox.appendChild(addCommentBtn);
      root.appendChild(commentBox);

      if (data.comments.length) {
        var commentsCard = el("div", "card");
        data.comments.forEach(function (c, idx) {
          var row = el("div", "ops-comment-row" + (idx ? " ops-breakdown-row-sep" : ""));
          row.innerHTML = '<div class="ops-comment-date">' + c.date + '</div><div class="ops-comment-text">' + escapeHtml(c.text) + '</div>';
          commentsCard.appendChild(row);
        });
        root.appendChild(commentsCard);
      }

      // --- напоминание ---
      root.appendChild(el("h3", "ops-section-title", "Напоминание"));
      var remBox = el("div", "ops-input-box ops-input-box-reminder");
      var remRow = el("div", "ops-select-row");
      var dateField = el("div", "field");
      dateField.innerHTML = '<label>Дата</label>';
      var dateInput = el("input"); dateInput.type = "date";
      dateField.appendChild(dateInput);
      var noteField = el("div", "field");
      noteField.innerHTML = '<label>Заметка (необязательно)</label>';
      var noteInput = el("input"); noteInput.type = "text";
      noteField.appendChild(noteInput);
      remRow.appendChild(dateField); remRow.appendChild(noteField);
      remBox.appendChild(remRow);
      remBox.appendChild(el("div", "ops-field-hint", "Пример: перезвонить"));
      var setReminderBtn = el("button", "btn-ghost", "Установить напоминание");
      setReminderBtn.addEventListener("click", function () {
        if (!dateInput.value) { toast("Выберите дату"); return; }
        setReminderBtn.disabled = true;
        api("/api/ops/debtors/" + encodeURIComponent(clientId) + "/reminder", {
          method: "POST", body: { date: _opsIsoToRu(dateInput.value), note: noteInput.value.trim() },
        }).then(function () { load(); }).catch(function (err) {
          setReminderBtn.disabled = false; toast("Не удалось сохранить: " + err.message);
        });
      });
      remBox.appendChild(setReminderBtn);
      root.appendChild(remBox);

      if (data.reminders.length) {
        var remCard = el("div", "card");
        data.reminders.forEach(function (r, idx) {
          var row = el("div", "ops-reminder-row" + (idx ? " ops-breakdown-row-sep" : ""));
          var left = el("div", "ops-breakdown-name", r.date + (r.note ? ' — ' + escapeHtml(r.note) : ''));
          var cancelBtn = el("button", "btn-text", "Отменить");
          cancelBtn.addEventListener("click", function () {
            cancelBtn.disabled = true;
            api("/api/ops/debtors/" + encodeURIComponent(clientId) + "/reminder/delete", {
              method: "POST", body: { row: r.row },
            }).then(function () { load(); }).catch(function (err) {
              cancelBtn.disabled = false; toast("Не удалось отменить: " + err.message);
            });
          });
          row.appendChild(left); row.appendChild(cancelBtn);
          remCard.appendChild(row);
        });
        root.appendChild(remCard);
      }

      // --- удалить историю долгов (только когда всё погашено) ---
      if (data.all_resolved) {
        var deleteBtn = el("button", "ops-delete-history-btn", "Удалить историю долгов");
        deleteBtn.addEventListener("click", function () {
          showConfirm(
            "Удалить всю историю долгов " + data.name + "? Комментарии и напоминания пропадут, человек исчезнет из списка должников.",
            "Удалить",
            function () {
              hideConfirm();
              deleteBtn.disabled = true;
              api("/api/ops/debtors/" + encodeURIComponent(clientId) + "/delete-history", { method: "POST", body: {} })
                .then(function () { haptic("success"); wizardBack(); })
                .catch(function (err) { deleteBtn.disabled = false; toast("Не удалось удалить: " + err.message); });
            }
          );
        });
        root.appendChild(deleteBtn);
      }
    }

    load();
  }

  // --- Операционный центр → CRM (только главный админ) --------------------
  // "Клиенты" — учёт/фильтры/полная карточка. "Лиды" — холодные/тёплые/
  // дожим, комментарии, напоминания (та же форма, что и у "Должники" —
  // ops-input-box/ops-comment-row/ops-reminder-row переиспользуются как
  // есть). Стадия "cold" ВИРТУАЛЬНАЯ (нет строки в CRM Лиды) — см.
  // sheets.get_crm_stage/get_crm_leads_overview.

  function loadCrmClientsList(root) {
    root.innerHTML = "";
    root.appendChild(el("div", "skeleton-block"));
    api("/api/crm/clients").then(function (data) {
      render(data.clients || []);
    }).catch(function (err) {
      root.innerHTML = "";
      root.appendChild(el("div", "empty-note", "Не удалось загрузить список клиентов: " + err.message));
    });

    function render(clients) {
      root.innerHTML = "";

      // Поиск — свёрнут по умолчанию (иконка-лупа), разворачивается по
      // тапу в поле ввода, по прямой просьбе (раньше поле всегда
      // занимало место сверху, даже когда им не пользовались).
      var filterBox = el("div", "card crm-filter-box");
      var searchRow = el("div", "crm-search-row");
      var searchToggle = el("button", "crm-search-toggle", ICON_CRM_SEARCH);
      var searchField = el("div", "field crm-search-field");
      searchField.hidden = true;
      var searchInput = el("input");
      searchInput.type = "text";
      searchInput.placeholder = "Поиск по имени...";
      searchField.appendChild(searchInput);
      searchToggle.addEventListener("click", function () {
        searchField.hidden = !searchField.hidden;
        if (!searchField.hidden) {
          searchInput.focus();
        } else if (searchInput.value) {
          searchInput.value = "";
          applyFilters();
        }
      });
      searchRow.appendChild(searchToggle);
      filterBox.appendChild(searchRow);
      filterBox.appendChild(searchField);

      var zones = clients.reduce(function (acc, c) { if (c.zone && acc.indexOf(c.zone) === -1) acc.push(c.zone); return acc; }, []).sort();
      var zoneField = el("div", "field");
      zoneField.innerHTML = '<label>Район</label>';
      var zoneSelect = document.createElement("select");
      var allOpt = document.createElement("option");
      allOpt.value = ""; allOpt.textContent = "Все районы";
      zoneSelect.appendChild(allOpt);
      zones.forEach(function (z) {
        var o = document.createElement("option");
        o.value = z; o.textContent = z;
        zoneSelect.appendChild(o);
      });
      zoneField.appendChild(zoneSelect);
      filterBox.appendChild(zoneField);

      var orderFilter = "";
      var orderPills = el("div", "crm-pill-row");
      [{ key: "", label: "Все" }, { key: "yes", label: "Заказывал" }, { key: "no", label: "Не заказывал" }].forEach(function (opt) {
        var pill = el("button", "date-pill" + (opt.key === "" ? " active" : ""), opt.label);
        pill.addEventListener("click", function () {
          orderFilter = opt.key;
          Array.prototype.forEach.call(orderPills.children, function (p) { p.classList.remove("active"); });
          pill.classList.add("active");
          applyFilters();
        });
        orderPills.appendChild(pill);
      });
      filterBox.appendChild(orderPills);

      var stageFilter = "";
      var stagePills = el("div", "crm-pill-row");
      [{ key: "", label: "Все статусы" }].concat(
        Object.keys(CRM_STAGE_LABELS).map(function (k) { return { key: k, label: CRM_STAGE_LABELS[k] }; })
      ).forEach(function (opt) {
        var pill = el("button", "date-pill" + (opt.key === "" ? " active" : ""), opt.label);
        pill.addEventListener("click", function () {
          stageFilter = opt.key;
          Array.prototype.forEach.call(stagePills.children, function (p) { p.classList.remove("active"); });
          pill.classList.add("active");
          applyFilters();
        });
        stagePills.appendChild(pill);
      });
      filterBox.appendChild(stagePills);
      root.appendChild(filterBox);

      var listBox = el("div");
      root.appendChild(listBox);

      function applyFilters() {
        var q = searchInput.value.trim().toLowerCase();
        var zone = zoneSelect.value;
        var filtered = clients.filter(function (c) {
          if (q && c.name.toLowerCase().indexOf(q) === -1) return false;
          if (zone && c.zone !== zone) return false;
          if (orderFilter === "yes" && !(c.order_count > 0)) return false;
          if (orderFilter === "no" && c.order_count > 0) return false;
          if (stageFilter && c.stage !== stageFilter) return false;
          return true;
        });
        filtered.sort(function (a, b) { return a.name.localeCompare(b.name, "ru"); });
        renderList(filtered);
      }

      // Визуальное разделение — список разбит на буквенные секции (как в
      // обычном списке контактов), по прямой просьбе: сплошная лента
      // карточек без ориентиров плохо читалась на полном списке клиентов.
      function renderList(list) {
        listBox.innerHTML = "";
        if (!list.length) {
          listBox.appendChild(el("div", "empty-note", "Никого не нашли."));
          return;
        }
        var lastLetter = null;
        list.forEach(function (c) {
          var letter = (c.name || "?").trim().charAt(0).toUpperCase() || "?";
          if (letter !== lastLetter) {
            listBox.appendChild(el("div", "crm-alpha-label", letter));
            lastLetter = letter;
          }
          var row = el("div", "card crm-client-row");
          row.innerHTML =
            '<div class="crm-client-row-main">' +
              '<div class="crm-client-row-name">' + escapeHtml(c.name) + '</div>' +
              '<div class="crm-client-row-sub">' + escapeHtml(c.zone || "") + (c.point ? " — " + escapeHtml(c.point) : "") + '</div>' +
            '</div>' +
            '<div class="crm-client-row-side">' +
              '<div class="crm-client-row-orders">' + c.order_count + ' зак.</div>' +
              '<div class="crm-stage-badge crm-stage-' + c.stage + '">' + CRM_STAGE_LABELS[c.stage] + '</div>' +
            '</div>';
          row.addEventListener("click", function () {
            haptic("select");
            wizardStep(function (body) {
              opsStepHeader(body, c.name);
              var sub = el("div");
              sub.appendChild(el("div", "skeleton-block"));
              body.appendChild(sub);
              loadCrmClientDetail(sub, c.id);
            });
          });
          listBox.appendChild(row);
        });
      }

      searchInput.addEventListener("input", applyFilters);
      zoneSelect.addEventListener("change", applyFilters);
      applyFilters();
    }
  }

  function loadCrmClientDetail(root, clientId) {
    function load() {
      root.innerHTML = "";
      root.appendChild(el("div", "skeleton-block"));
      api("/api/crm/clients/" + encodeURIComponent(clientId)).then(function (data) {
        render(data);
      }).catch(function (err) {
        root.innerHTML = "";
        root.appendChild(el("div", "empty-note", "Не удалось загрузить данные: " + err.message));
      });
    }

    function render(data) {
      root.innerHTML = "";

      var card = el("div", "card");
      card.innerHTML =
        '<div class="ops-debtor-card-name">' + escapeHtml(data.name) + '</div>' +
        (data.contact ? '<div class="ops-debtor-card-line">' + escapeHtml(_opsFmtPhone(data.contact)) + '</div>' : "") +
        (data.telegram ? '<div class="ops-debtor-card-line">@' + escapeHtml(data.telegram.replace(/^@/, "")) + '</div>' : "") +
        '<div class="ops-debtor-card-line">' + escapeHtml(data.zone || "") + (data.point ? " — " + escapeHtml(data.point) : "") + '</div>' +
        (data.reg_date ? '<div class="ops-debtor-card-line">Регистрация: ' + escapeHtml(data.reg_date) + '</div>' : "");
      root.appendChild(card);

      var actionsRow = el("div", "ops-contact-actions");
      var writeBtn = el("button", "ops-contact-btn ops-contact-btn-primary");
      writeBtn.innerHTML = ICON_OPS_MESSAGE + '<span>Написать</span>';
      // Юзернейм в приоритете — см. openTelegramChat выше про tg://user?id=.
      var tgLink = data.telegram ? "https://t.me/" + data.telegram.replace(/^@/, "") : (data.tg_id ? "tg://user?id=" + data.tg_id : "");
      if (tgLink) {
        writeBtn.addEventListener("click", function () { openTelegramChat(tgLink); });
      } else {
        writeBtn.disabled = true;
        writeBtn.title = "Телеграм не привязан";
      }
      var telHref = _opsTelHref(data.contact);
      var callBtn;
      if (telHref) {
        callBtn = document.createElement("a");
        callBtn.href = telHref;
        callBtn.className = "ops-contact-btn";
      } else {
        callBtn = el("button", "ops-contact-btn");
        callBtn.disabled = true;
        callBtn.title = "Номер телефона не указан";
      }
      callBtn.innerHTML = ICON_OPS_CALL + '<span>Позвонить</span>';
      actionsRow.appendChild(writeBtn);
      actionsRow.appendChild(callBtn);
      root.appendChild(actionsRow);

      var statRow = el("div", "profile-stat-row");
      var ordersTile = el("div", "profile-stat");
      ordersTile.innerHTML = '<div class="profile-stat-value">' + data.order_count + '</div><div class="profile-stat-label">Заказов</div>';
      statRow.appendChild(ordersTile);
      var clubTile = el("div", "profile-stat");
      clubTile.innerHTML = '<div class="profile-stat-value">' + data.club.emoji + '</div><div class="profile-stat-label">' + escapeHtml(data.club.label) + '</div>';
      statRow.appendChild(clubTile);
      if (data.debt > 0) {
        var debtTile = el("div", "profile-stat");
        debtTile.innerHTML = '<div class="profile-stat-value">' + fmtSum(data.debt) + '</div><div class="profile-stat-label">Долг</div>';
        statRow.appendChild(debtTile);
      }
      root.appendChild(statRow);

      // --- стадия CRM — "Холодный" сюда намеренно не включён: это
      // виртуальное состояние "ещё не трогали", возврат в него через UI не
      // нужен (comментарий/напоминание и так уже необратимо "согрели" лида).
      root.appendChild(el("h3", "ops-section-title", "Стадия: " + CRM_STAGE_LABELS[data.stage]));
      var stageRow = el("div", "payment-tiles-row");
      [{ key: "warm", label: "Тёплый" }, { key: "dozhim", label: "Дожим" }, { key: "sale", label: "Продажа" }].forEach(function (opt) {
        var btn = el("button", "payment-tile" + (data.stage === opt.key ? " active" : ""), opt.label);
        btn.addEventListener("click", function () {
          haptic("select");
          api("/api/crm/clients/" + encodeURIComponent(clientId) + "/stage", { method: "POST", body: { stage: opt.key } })
            .then(function () { load(); })
            .catch(function (err) { toast("Не удалось сохранить: " + err.message); });
        });
        stageRow.appendChild(btn);
      });
      root.appendChild(stageRow);

      // --- комментарии ---
      root.appendChild(el("h3", "ops-section-title", "Комментарии"));
      var commentBox = el("div", "ops-input-box ops-input-box-comment");
      var commentField = el("div", "field");
      var commentInput = el("textarea");
      commentInput.rows = 2;
      commentField.appendChild(commentInput);
      commentBox.appendChild(commentField);
      var addCommentBtn = el("button", "btn-ghost", "Добавить комментарий");
      addCommentBtn.addEventListener("click", function () {
        var text = commentInput.value.trim();
        if (!text) return;
        addCommentBtn.disabled = true;
        api("/api/crm/clients/" + encodeURIComponent(clientId) + "/comment", { method: "POST", body: { text: text } })
          .then(function () { load(); })
          .catch(function (err) { addCommentBtn.disabled = false; toast("Не удалось сохранить: " + err.message); });
      });
      commentBox.appendChild(addCommentBtn);
      root.appendChild(commentBox);

      if (data.comments.length) {
        var commentsCard = el("div", "card");
        data.comments.forEach(function (c, idx) {
          var row = el("div", "ops-comment-row" + (idx ? " ops-breakdown-row-sep" : ""));
          row.innerHTML = '<div class="ops-comment-date">' + c.date + '</div><div class="ops-comment-text">' + escapeHtml(c.text) + '</div>';
          commentsCard.appendChild(row);
        });
        root.appendChild(commentsCard);
      }

      // --- напоминание ---
      root.appendChild(el("h3", "ops-section-title", "Напоминание"));
      var remBox = el("div", "ops-input-box ops-input-box-reminder");
      var remRow = el("div", "ops-select-row");
      var dateField = el("div", "field");
      dateField.innerHTML = '<label>Дата</label>';
      var dateInput = el("input");
      dateInput.type = "date";
      dateField.appendChild(dateInput);
      var noteField = el("div", "field");
      noteField.innerHTML = '<label>Заметка</label>';
      var noteInput = el("input");
      noteInput.type = "text";
      noteInput.placeholder = "Например: скинуть меню вечером";
      noteField.appendChild(noteInput);
      remRow.appendChild(dateField);
      remRow.appendChild(noteField);
      remBox.appendChild(remRow);
      var setReminderBtn = el("button", "btn-ghost", "Установить напоминание");
      setReminderBtn.addEventListener("click", function () {
        if (!dateInput.value) { toast("Выберите дату"); return; }
        setReminderBtn.disabled = true;
        api("/api/crm/clients/" + encodeURIComponent(clientId) + "/reminder", {
          method: "POST", body: { date: _opsIsoToRu(dateInput.value), note: noteInput.value.trim() },
        }).then(function () { load(); }).catch(function (err) {
          setReminderBtn.disabled = false; toast("Не удалось сохранить: " + err.message);
        });
      });
      remBox.appendChild(setReminderBtn);
      root.appendChild(remBox);

      if (data.reminders.length) {
        var remCard = el("div", "card");
        data.reminders.forEach(function (r, idx) {
          var row = el("div", "ops-reminder-row" + (idx ? " ops-breakdown-row-sep" : ""));
          var left = el("div", "ops-breakdown-name", r.date + (r.note ? ' — ' + escapeHtml(r.note) : ''));
          var doneBtn = el("button", "btn-text", "Готово");
          doneBtn.addEventListener("click", function () {
            doneBtn.disabled = true;
            api("/api/crm/clients/" + encodeURIComponent(clientId) + "/reminder/done", {
              method: "POST", body: { row: r.row },
            }).then(function () { load(); }).catch(function (err) {
              doneBtn.disabled = false; toast("Не удалось сохранить: " + err.message);
            });
          });
          row.appendChild(left);
          row.appendChild(doneBtn);
          remCard.appendChild(row);
        });
        root.appendChild(remCard);
      }

      // --- последние заказы ---
      if (data.orders && data.orders.length) {
        root.appendChild(el("h3", "ops-section-title", "Последние заказы"));
        var ordersCard = el("div", "card");
        data.orders.forEach(function (o, idx) {
          var row = el("div", "ops-comment-row" + (idx ? " ops-breakdown-row-sep" : ""));
          var statusNote = o.canceled ? " (отменён)" : (o.paid ? " · оплачено" : "");
          row.innerHTML = '<div class="ops-comment-date">' + escapeHtml(o.date) + '</div><div class="ops-comment-text">' + escapeHtml(o.summary) + escapeHtml(statusNote) + '</div>';
          ordersCard.appendChild(row);
        });
        root.appendChild(ordersCard);
      }
    }

    load();
  }

  function loadCrmLeads(root) {
    root.innerHTML = "";
    root.appendChild(el("div", "skeleton-block"));
    api("/api/crm/leads").then(function (data) {
      render(data);
    }).catch(function (err) {
      root.innerHTML = "";
      root.appendChild(el("div", "empty-note", "Не удалось загрузить лиды: " + err.message));
    });

    function buildLeadRow(l) {
      var row = el("div", "card crm-lead-row");
      var commentLine = l.last_comment ? '<div class="crm-lead-comment">💬 ' + escapeHtml(l.last_comment.text) + '</div>' : "";
      var reminderLine = l.reminder ? '<div class="crm-lead-reminder">⏰ ' + escapeHtml(l.reminder.date) + (l.reminder.note ? ' — ' + escapeHtml(l.reminder.note) : '') + '</div>' : "";
      // Явно показываем "0 заказов" (не просто пропускаем) — чтобы было
      // видно, что это реально тот, с кем вообще не было взаимодействия,
      // а не пропавшая строка.
      var ordersBadge = '<span class="crm-lead-orders' + (l.order_count > 0 ? '' : ' crm-lead-orders-zero') + '">' + l.order_count + ' зак.</span>';
      row.innerHTML =
        '<div class="crm-lead-row-top">' +
          '<div class="crm-lead-name">' + escapeHtml(l.name) + '</div>' +
          '<div class="crm-lead-date">' + escapeHtml(l.reg_date) + '</div>' +
        '</div>' +
        '<div class="crm-lead-sub">' + escapeHtml(l.zone || "") + (l.contact ? " · " + escapeHtml(_opsFmtPhone(l.contact)) : "") + ' · ' + ordersBadge + '</div>' +
        commentLine + reminderLine;
      row.addEventListener("click", function () {
        haptic("select");
        wizardStep(function (body) {
          opsStepHeader(body, l.name);
          var sub = el("div");
          sub.appendChild(el("div", "skeleton-block"));
          body.appendChild(sub);
          loadCrmClientDetail(sub, l.id);
        });
      });
      return row;
    }

    // "Сегодня" по значению data.today — дате, которую посчитал СЕРВЕР
    // (sheets.today_date_str), а не часами устройства админа: ровно то,
    // что уже один раз ловили на оплате доставки (другой часовой пояс на
    // телефоне даёт другую календарную дату) — здесь та же ловушка, с тем
    // же решением.
    function regDateInRange(regDate, todayStr, rangeKey) {
      if (rangeKey === "all") return true;
      var p = (todayStr || "").split(".");
      if (p.length !== 3) return true;
      var today = new Date(Number(p[2]), Number(p[1]) - 1, Number(p[0]));
      var rp = (regDate || "").split(".");
      if (rp.length !== 3) return false;
      var reg = new Date(Number(rp[2]), Number(rp[1]) - 1, Number(rp[0]));
      var diffDays = Math.round((today - reg) / 86400000);
      if (rangeKey === "today") return diffDays === 0;
      if (rangeKey === "yesterday") return diffDays === 1;
      if (rangeKey === "week") return diffDays >= 0 && diffDays <= 6;
      return true;
    }

    function render(data) {
      root.innerHTML = "";

      var counterRow = el("div", "profile-stat-row");
      var counterTile = el("div", "profile-stat");
      counterTile.innerHTML = '<div class="profile-stat-value">' + data.today_count + '</div><div class="profile-stat-label">Новых сегодня</div>';
      counterRow.appendChild(counterTile);
      root.appendChild(counterRow);

      // По прямой просьбе: раньше счётчик честно показывал "сегодня 2", а
      // список ниже всегда показывал ВСЕХ лидов разом (например 208) —
      // непонятно было, что это за два разных числа. Теперь день и статус
      // — отдельные фильтры, применяются вместе.
      var filterBox = el("div", "card crm-filter-box");
      var dayFilter = "today";
      filterBox.appendChild(el("div", "crm-filter-label", "Период"));
      // Сегодня/Вчера/7 дней — равные сегменты одного переключателя (как
      // в iOS/Android), "Все" — отдельная, визуально другая кнопка под
      // ним: это не "ещё один период", а явный "показать вообще всех"
      // (включая тех, у кого 0 заказов и не было ни одного
      // взаимодействия — они и так уже в "Холодных", просто раньше не
      // было понятно, что "Все" их тоже покажет).
      var daySegment = el("div", "crm-day-segment");
      [
        { key: "today", label: "Сегодня" },
        { key: "yesterday", label: "Вчера" },
        { key: "week", label: "7 дней" },
      ].forEach(function (opt) {
        var seg = el("button", "crm-day-segment-btn" + (opt.key === dayFilter ? " active" : ""), opt.label);
        seg.addEventListener("click", function () {
          dayFilter = opt.key;
          Array.prototype.forEach.call(daySegment.children, function (p) { p.classList.remove("active"); });
          seg.classList.add("active");
          allBtn.classList.remove("active");
          applyFilters();
        });
        daySegment.appendChild(seg);
      });
      filterBox.appendChild(daySegment);

      var allBtn = el("button", "crm-day-all-btn", "Показать всех лидов за всё время");
      allBtn.addEventListener("click", function () {
        dayFilter = "all";
        Array.prototype.forEach.call(daySegment.children, function (p) { p.classList.remove("active"); });
        allBtn.classList.add("active");
        applyFilters();
      });
      filterBox.appendChild(allBtn);

      var poolFilter = "";
      var poolDefs = [
        { key: "cold", label: "Холодные" },
        { key: "warm", label: "Тёплые" },
        { key: "dozhim", label: "Дожим" },
      ];
      filterBox.appendChild(el("div", "crm-filter-label crm-filter-label-pool", "Статус"));
      var poolPills = el("div", "crm-pill-row");
      [{ key: "", label: "Все статусы" }].concat(poolDefs).forEach(function (opt) {
        var pill = el("button", "date-pill" + (opt.key === "" ? " active" : ""), opt.label);
        pill.addEventListener("click", function () {
          poolFilter = opt.key;
          Array.prototype.forEach.call(poolPills.children, function (p) { p.classList.remove("active"); });
          pill.classList.add("active");
          applyFilters();
        });
        poolPills.appendChild(pill);
      });
      filterBox.appendChild(poolPills);
      root.appendChild(filterBox);

      var listBox = el("div");
      root.appendChild(listBox);

      function applyFilters() {
        listBox.innerHTML = "";
        var pools = poolFilter ? poolDefs.filter(function (p) { return p.key === poolFilter; }) : poolDefs;
        pools.forEach(function (pool) {
          var items = (data[pool.key] || [])
            .filter(function (l) { return regDateInRange(l.reg_date, data.today, dayFilter); })
            .slice().reverse(); // новые регистрации сверху
          listBox.appendChild(el("h3", "ops-section-title", pool.label + " (" + items.length + ")"));
          if (!items.length) {
            listBox.appendChild(el("div", "empty-note", "Пусто."));
            return;
          }
          items.forEach(function (l) { listBox.appendChild(buildLeadRow(l)); });
        });
      }

      applyFilters();
    }
  }

  // --- Операционный центр → Администраторы (только главный админ) ---------

  function loadOpsAdminsList(root) {
    function load() {
      root.innerHTML = "";
      root.appendChild(el("div", "skeleton-block"));
      api("/api/pause-admins").then(function (data) {
        render(data.admins);
      }).catch(function (err) {
        root.innerHTML = "";
        root.appendChild(el("div", "empty-note", "Не удалось загрузить список: " + err.message));
      });
    }

    function render(admins) {
      root.innerHTML = "";

      // --- добавить человека ---
      var addBox = el("div", "ops-input-box ops-input-box-comment");
      var addRow = el("div", "ops-select-row");
      var idField = el("div", "field");
      idField.innerHTML = '<label>Telegram ID</label>';
      var idInput = el("input"); idInput.type = "text"; idInput.inputMode = "numeric"; idInput.placeholder = "7118369020";
      idField.appendChild(idInput);
      var nameField = el("div", "field");
      nameField.innerHTML = '<label>Имя (необязательно)</label>';
      var nameInput = el("input"); nameInput.type = "text"; nameInput.placeholder = "Имя";
      nameField.appendChild(nameInput);
      addRow.appendChild(idField); addRow.appendChild(nameField);
      addBox.appendChild(addRow);
      var addBtn = el("button", "btn-ghost", "Добавить человека");
      addBtn.addEventListener("click", function () {
        var tgId = idInput.value.trim();
        if (!tgId || !/^-?\d+$/.test(tgId)) { toast("Введите Telegram ID числом"); return; }
        addBtn.disabled = true;
        api("/api/pause-admins", { method: "POST", body: { tg_id: tgId, name: nameInput.value.trim() } })
          .then(function () { haptic("success"); load(); })
          .catch(function (err) { addBtn.disabled = false; toast("Не удалось добавить: " + err.message); });
      });
      addBox.appendChild(addBtn);
      root.appendChild(addBox);

      // --- уже добавленные ---
      root.appendChild(el("h3", "ops-section-title", "Уже добавлены"));
      if (!admins.length) {
        root.appendChild(el("div", "empty-note", "Пока никого не добавили."));
        return;
      }
      var card = el("div", "card");
      admins.forEach(function (a, idx) {
        // ops-breakdown-row (не ops-debtor-row) — тут несколько строк в
        // ОДНОЙ общей карточке, как у строк долга/комментариев, а не
        // отдельная карточка на каждую запись (там своя роль у
        // ops-debtor-row, трогать её не нужно — список должников
        // по-прежнему использует её как задумано, с собственным
        // отступом от каждой карточки). У ops-debtor-row нет внутреннего
        // padding/gap — рядом друг с другом внутри одной карточки строки
        // были видны почти слитыми.
        var row = el("div", "ops-breakdown-row" + (idx ? " ops-breakdown-row-sep" : ""));
        var badges = '<span class="pill ' + (a.finance ? "paid" : "muted") + '">Финансы</span>' +
          '<span class="pill ' + (a.debtors ? "paid" : "muted") + '">Должники</span>';
        row.innerHTML =
          '<div class="ops-breakdown-name">' + escapeHtml(a.name || a.tg_id) + '</div>' +
          '<div class="ops-pa-badges">' + badges + '</div>';
        row.addEventListener("click", function () {
          haptic("select");
          wizardStep(function (body) {
            opsStepHeader(body, a.name || a.tg_id);
            var sub = el("div");
            sub.appendChild(el("div", "skeleton-block"));
            body.appendChild(sub);
            loadOpsAdminDetail(sub, a);
          });
        });
        card.appendChild(row);
      });
      root.appendChild(card);
    }

    load();
  }

  function loadOpsAdminDetail(root, admin) {
    function renderToggle(label, feature, allowed) {
      var row = el("div", "ops-breakdown-row ops-breakdown-row-sep");
      var left = el("div", "ops-breakdown-name", label);
      var switchLabel = document.createElement("label");
      switchLabel.className = "pa-switch";
      var input = document.createElement("input");
      input.type = "checkbox";
      input.checked = allowed;
      var slider = document.createElement("span");
      slider.className = "pa-switch-slider";
      switchLabel.appendChild(input);
      switchLabel.appendChild(slider);
      input.addEventListener("change", function () {
        input.disabled = true;
        api("/api/pause-admins/" + encodeURIComponent(admin.tg_id) + "/feature", {
          method: "POST", body: { feature: feature, allowed: input.checked },
        }).then(function (data) {
          admin.finance = data.admin.finance;
          admin.debtors = data.admin.debtors;
          input.disabled = false;
          toast(input.checked ? "Функция включена" : "Функция выключена");
        }).catch(function (err) {
          input.checked = !input.checked;
          input.disabled = false;
          toast("Не удалось сохранить: " + err.message);
        });
      });
      row.appendChild(left);
      row.appendChild(switchLabel);
      return row;
    }

    root.innerHTML = "";
    var card = el("div", "card");
    var head = el("div");
    head.innerHTML =
      '<div class="ops-debtor-card-name">' + escapeHtml(admin.name || "Без имени") + '</div>' +
      '<div class="ops-debtor-card-line">Telegram ID: ' + escapeHtml(admin.tg_id) + '</div>' +
      (admin.added ? '<div class="ops-debtor-card-line">Добавлен: ' + escapeHtml(admin.added) + '</div>' : "");
    card.appendChild(head);
    root.appendChild(card);

    root.appendChild(el("h3", "ops-section-title", "Функции"));
    var featuresCard = el("div", "card");
    featuresCard.appendChild(renderToggle("Финансы", "finance", admin.finance));
    featuresCard.appendChild(renderToggle("Должники", "debtors", admin.debtors));
    root.appendChild(featuresCard);

    var removeBtn = el("button", "ops-delete-history-btn", "Удалить администратора");
    removeBtn.addEventListener("click", function () {
      showConfirm(
        "Удалить " + (admin.name || admin.tg_id) + " из администраторов? Доступ к PAUSE App пропадёт полностью.",
        "Удалить",
        function () {
          hideConfirm();
          removeBtn.disabled = true;
          api("/api/pause-admins/" + encodeURIComponent(admin.tg_id) + "/remove", { method: "POST", body: {} })
            .then(function () { haptic("success"); wizardBack(); })
            .catch(function (err) { removeBtn.disabled = false; toast("Не удалось удалить: " + err.message); });
        }
      );
    });
    root.appendChild(removeBtn);
  }

  // --- Мои послания --------------------------------------------------------

  function loadMessages(root) {
    api("/api/messages").then(function (data) {
      root.innerHTML = "";
      if (!data.messages.length) {
        root.appendChild(el("div", "empty-note", t("profile.myMessagesEmpty")));
        return;
      }
      data.messages.forEach(function (m, idx) {
        var card = el("div", "card message-card is-clickable");
        card.innerHTML =
          '<div class="message-card-num">' + escapeHtml(t("care.numberLabel", { number: m.number, total: data.total })) + '</div>' +
          '<div class="message-card-text">«' + escapeHtml(m.text) + '»</div>' +
          '<div class="message-card-date">' + m.date + '</div>';
        card.addEventListener("click", function () {
          haptic("select");
          openCareViewer(data.messages, data.total, idx);
        });
        root.appendChild(card);
      });
    }).catch(function () {
      root.innerHTML = "";
      root.appendChild(el("div", "empty-note", t("profile.myMessagesLoadFailed")));
    });
  }

  // Колокольчик уведомлений (см. buildHeaderBell) — пока только выигрыш в
  // ежедневном розыгрыше "Пауза в подарок" (см. pauseapp.py:
  // run_daily_giveaway_draw), позже сюда же лягут объявления/обновления.
  // Отмечаем прочитанными сразу по открытию списка — пока человек видит
  // текст, нет смысла держать точку на колокольчике дальше; хаб (Главная)
  // перерисовывается следом, чтобы точка пропала, не дожидаясь обратного
  // перехода на вкладку.
  // Лепесток — "билет" PAUSE DAY (оплачивает один сет). Заливка currentColor.
  var ICON_PETAL = '<svg viewBox="0 0 24 24" fill="currentColor" width="22" height="22"><path d="M12 22.2C10.6 18.6 6 16.4 6 10.6 6 6.2 8.7 2.6 12 2c3.3.6 6 4.2 6 8.6 0 5.8-4.6 8-6 11.6z"/><path d="M12 20V8.6M12 14.6l-2.6-2.6M12 12.2l2.4-2.4" stroke="rgba(255,255,255,0.6)" stroke-width="1" stroke-linecap="round" fill="none"/></svg>';

  function loadNotifications(root) {
    api("/api/notifications").then(function (data) {
      root.innerHTML = "";
      var items = data.notifications || [];
      if (!items.length) {
        root.appendChild(el("div", "empty-note", t("notifications.empty")));
      } else {
        items.forEach(function (n) {
          var isWin = n.kind === "giveaway_win";
          var isComment = n.kind && n.kind.indexOf("moment_comment:") === 0;
          var card;
          if (isWin) {
            // Выигрыш в PAUSE DAY — праздничная карточка с лепестком; текст
            // берём из i18n, а не из таблицы (на языке клиента, и красиво
            // выглядит даже у старых уведомлений).
            card = el("div", "notif-win" + (n.read ? "" : " is-unread"));
            card.innerHTML =
              '<div class="notif-win-bg">' + ICON_PETAL + '</div>' +
              '<div class="notif-win-top"><span class="notif-win-icon">' + ICON_PETAL + '</span><span class="notif-win-eyebrow">PAUSE DAY</span>' +
                (n.read ? "" : '<span class="notif-new">' + escapeHtml(t("notif.new")) + '</span>') + '</div>' +
              '<div class="notif-win-title">' + escapeHtml(t("notif.win.title")) + '</div>' +
              '<div class="notif-win-body">' + escapeHtml(t("notif.win.body", { section: t("profile.bonuses") })) + '</div>' +
              '<div class="notif-win-foot"><span class="notif-win-cta">' + escapeHtml(t("notif.win.cta")) + '</span><span class="notif-win-date">' + escapeHtml(n.created) + '</span></div>';
          } else {
            card = el("div", "notif-row" + (n.read ? "" : " is-unread"));
            card.innerHTML =
              '<span class="notif-row-icon">' + (isComment ? ICON_MOM_COMMENT : ICON_LEAF) + '</span>' +
              '<div class="notif-row-main"><div class="notif-row-text">' + escapeHtml(n.text) + '</div>' +
              '<div class="notif-row-date">' + escapeHtml(n.created) + '</div></div>';
          }
          if (isWin) {
            card.classList.add("is-clickable");
            card.addEventListener("click", function () {
              haptic("select");
              openProfileSubscreen(t("bonuses.title"), loadBonuses);
            });
          }
          if (isComment) {
            var momId = n.kind.slice("moment_comment:".length);
            card.classList.add("is-clickable");
            card.addEventListener("click", function () {
              haptic("select");
              loadMoments(function () { openWizard(function (b) { renderMomentDetail(b, momId); }); });
            });
          }
          root.appendChild(card);
        });
      }
      if (data.unread_count > 0) {
        api("/api/notifications/read", { method: "POST", body: {} }).then(function () {
          state.notifUnread = 0;
          if (state.home) renderHomeScreen();
        }).catch(function () { /* не критично — просто не погасла точка до следующего открытия */ });
      }
    }).catch(function () {
      root.innerHTML = "";
      root.appendChild(el("div", "empty-note", t("notifications.loadFailed")));
    });
  }

  // "Бонусы и промокоды" — пока только билеты "Пауза в подарок",
  // выигранные в ежедневном розыгрыше (см. pauseapp.py: api_bonuses).
  // Новые сверху — тот же порядок, что уже отдаёт sheets.get_client_tickets.
  function loadBonuses(root) {
    api("/api/bonuses").then(function (data) {
      root.innerHTML = "";
      if (!data.registered) {
        root.appendChild(el("div", "empty-note", t("bonuses.notRegistered")));
        return;
      }
      var tickets = data.tickets || [];
      if (!tickets.length) {
        root.appendChild(el("div", "petal-empty", '<div class="petal-empty-icon">' + ICON_PETAL + '</div><p>' + escapeHtml(t("bonuses.empty")) + '</p>'));
        return;
      }
      var availableCount = tickets.filter(function (tk) { return tk.available; }).length;
      var hero = el("div", "petal-hero");
      hero.innerHTML =
        '<div class="petal-hero-bg">' + ICON_PETAL + '</div>' +
        '<div class="petal-hero-label">' + escapeHtml(t("bonuses.petalsLabel")) + '</div>' +
        '<div class="petal-hero-count">' + availableCount + '</div>' +
        '<div class="petal-hero-hint">' + escapeHtml(availableCount ? t("bonuses.ticketHint") : t("bonuses.noneLeft")) + '</div>';
      root.appendChild(hero);
      tickets.forEach(function (ticket) {
        var card = el("div", "petal-card" + (ticket.available ? " is-available" : " is-used"));
        card.innerHTML =
          '<span class="petal-card-icon">' + ICON_PETAL + '</span>' +
          '<div class="petal-card-main">' +
            '<div class="petal-card-name">' + escapeHtml(t("bonuses.ticketName")) + '</div>' +
            '<div class="petal-card-date">' + escapeHtml(t("bonuses.ticketWonOn", { date: ticket.date_won })) + '</div>' +
            (ticket.available ? "" : '<div class="petal-card-date">' + escapeHtml(t("bonuses.ticketUsedOn", { date: ticket.date_used })) + '</div>') +
          '</div>' +
          (ticket.available
            ? '<span class="petal-card-cta">' + escapeHtml(t("bonuses.use")) + '</span>'
            : '<span class="petal-card-status">' + escapeHtml(t("bonuses.ticketUsed")) + '</span>');
        // Доступный лепесток ведёт к оформлению заказа — закрываем визард
        // (он модальный поверх вкладок) и открываем "Меню", откуда
        // начинается выбор сетов; использованный никуда не ведёт.
        if (ticket.available) {
          card.classList.add("is-clickable");
          card.addEventListener("click", function () {
            haptic("select");
            closeWizard();
            showScreen("menu");
          });
        }
        root.appendChild(card);
      });
    }).catch(function () {
      root.innerHTML = "";
      root.appendChild(el("div", "empty-note", t("bonuses.loadFailed")));
    });
  }

  // --- Редактирование профиля ---------------------------------------------

  var editState = {};

  function applyEditPoint(sel) {
    editState = { zone: sel.zone, point: sel.point, isNewPoint: sel.isNewPoint, lat: sel.lat || null, lon: sel.lon || null };
    closeWizard();
    openEditDeliveryAddress();
  }

  // -------------------------------------------------------------------
  // Карта выбора точки доставки — общий пикер для Оформления заказа
  // (checkout.zone/point, см. applyCheckoutPoint) и Профиля → Адрес
  // доставки (editState, см. applyEditPoint). Три способа выбрать точку:
  //   1) тап по уже существующей метке на карте (см. loadDeliveryPoints —
  //      те же координаты, что видит курьерский Mini App "Маршрут", плюс
  //      подсказка района от sheets.get_point_zones — район того же
  //      названия у других клиентов);
  //   2) поиск по адресу (сам вводит текст — геокодер Nominatim/OSM,
  //      см. api_geocode, без API-ключа) — выбор результата переносит
  //      карту туда и ставит новую метку;
  //   3) тап прямо по карте — тоже ставит новую метку в этом месте.
  // Для новой метки (2 и 3) район подсказывается по ближайшей уже
  // существующей точке в радиусе NEARBY_ZONE_RADIUS_M, если рядом никого
  // нет — поле остаётся пустым, вписывается вручную (см. ТЗ: "район не
  // трогается, если рядом нет точек").
  // -------------------------------------------------------------------

  var NEARBY_ZONE_RADIUS_M = 700;

  var _deliveryPointsCache = null;
  function loadDeliveryPoints() {
    if (_deliveryPointsCache) return Promise.resolve(_deliveryPointsCache);
    return api("/api/delivery-points").then(function (data) {
      _deliveryPointsCache = data.points || [];
      return _deliveryPointsCache;
    });
  }

  function haversineMeters(lat1, lon1, lat2, lon2) {
    var R = 6371000;
    var toRad = function (d) { return (d * Math.PI) / 180; };
    var dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function nearestZoneFor(points, lat, lon) {
    var best = null, bestDist = Infinity;
    points.forEach(function (p) {
      var d = haversineMeters(lat, lon, p.lat, p.lon);
      if (d < bestDist) { bestDist = d; best = p; }
    });
    return (best && bestDist <= NEARBY_ZONE_RADIUS_M) ? (best.zone || "") : "";
  }

  var ICON_MAP_PIN = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12 21s7-6.5 7-12a7 7 0 1 0-14 0c0 5.5 7 12 7 12Z"/><circle cx="12" cy="9" r="2.4"/></svg>';

  function mapMarkerIcon(kind) {
    var isNew = kind === "new";
    var color = isNew ? "var(--accent-warm)" : "var(--ink)";
    var size = isNew ? 16 : 12;
    return L.divIcon({
      className: "",
      html: '<div style="width:' + size + 'px;height:' + size + 'px;border-radius:50%;background:' + color + ';border:2px solid var(--card);box-shadow:0 1px 4px rgba(43,40,35,.35)"></div>',
      iconSize: [size, size],
      iconAnchor: [size / 2, size / 2],
    });
  }

  function renderDeliveryMapPicker(body, onPicked) {
    wizardPhaseEl.innerHTML = "";
    body.appendChild(el("h2", "wizard-title", t("address.title")));

    var wrap = el("div", "map-picker-wrap");
    body.appendChild(wrap);

    if (typeof L === "undefined") {
      wrap.outerHTML = '<p class="menu-set-closed-note">' + escapeHtml(t("address.mapUnavailable")) + '</p>';
      return;
    }

    var mapWrap = el("div", "map-picker-map");
    wrap.appendChild(mapWrap);

    // Поиск поверх карты, как в Яндекс Картах
    var searchBox = el("div", "map-search-box");
    searchBox.innerHTML = '<span class="map-search-icon">' + ICON_MAP_PIN + '</span>';
    var searchInput = el("input", "map-search-input");
    searchInput.type = "text";
    searchInput.placeholder = t("address.searchPlaceholder");
    searchInput.setAttribute("enterkeyhint", "search");
    searchBox.appendChild(searchInput);
    var clearBtn = el("button", "map-search-clear", "×");
    clearBtn.hidden = true;
    searchBox.appendChild(clearBtn);
    wrap.appendChild(searchBox);
    var resultsList = el("div", "map-search-results");
    resultsList.hidden = true;
    wrap.appendChild(resultsList);

    // Неподвижная метка по центру: двигаем карту — адрес под меткой
    var centerPin = el("div", "map-center-pin");
    centerPin.innerHTML = '<svg viewBox="0 0 32 42" width="32" height="42"><path d="M16 41C16 41 3 27 3 15a13 13 0 1 1 26 0c0 12-13 26-13 26Z" fill="#2b2823"/><circle cx="16" cy="15" r="5" fill="#fffdf8"/></svg><i></i>';
    wrap.appendChild(centerPin);

    var locateBtn = el("button", "map-locate-btn");
    locateBtn.setAttribute("aria-label", t("address.locate"));
    locateBtn.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="3.2"/><circle cx="12" cy="12" r="7.5"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg>';
    wrap.appendChild(locateBtn);

    var sheet = el("div", "map-confirm-sheet");
    wrap.appendChild(sheet);
    if (window.ResizeObserver) new ResizeObserver(function () { wrap.style.setProperty("--sheet-h", (sheet.offsetHeight + 22) + "px"); }).observe(sheet);

    var map = L.map(mapWrap, { zoomControl: false, attributionControl: true }).setView([41.311081, 69.240562], 12);
    // OpenStreetMap — самая подробная бесплатная карта по Ташкенту (улицы,
    // номера домов, здания до 19 зума). Esri на больших приближениях
    // теряла улицы.
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19, maxNativeZoom: 19,
      attribution: "&copy; OpenStreetMap",
    }).addTo(map);
    setTimeout(function () { map.invalidateSize(); }, 0);
    map.attributionControl.setPrefix(false);

    var allPoints = [];
    var current = null;       // { kind: "new"|"existing", place|point }
    var reverseSeq = 0;
    var sheetLocked = false;  // идёт правка названия в шторке — не обновляем её
    var holdUntil = 0;        // после выбора подсказки не перезатираем адрес обратным геокодингом

    function lift(on) { centerPin.classList.toggle("lifted", !!on); }

    function renderSheetLoading() {
      sheet.innerHTML = '<div class="map-sheet-skel"></div><div class="map-sheet-skel short"></div>';
      sheet.classList.add("show");
    }

    // Уже известная точка: можно выбрать как есть, а можно поправить
    // название/район — тогда локация остаётся прежней, а сохраняется то
    // название, что ввёл клиент.
    function renderSheetExisting(p) {
      renderSheetNew({
        title: p.name, subtitle: p.address && p.address !== p.name ? p.address : "",
        label: p.name, district: p.zone || "", lat: p.lat, lon: p.lon,
      }, p);
    }

    function renderSheetNew(place, origin) {
      sheetLocked = false;
      current = { kind: origin ? "existing" : "new", place: place };
      var lat = parseFloat(place.lat), lon = parseFloat(place.lon);
      var district = place.district || nearestZoneFor(allPoints, lat, lon);
      var label = place.label || place.title || "";
      sheet.innerHTML = "";
      sheet.classList.add("show");
      sheet.appendChild(el("div", "map-confirm-title", escapeHtml(place.title || t("address.newPoint"))));
      var subTxt = [place.subtitle].filter(Boolean).join("");
      if (!place.district && district) subTxt = [subTxt, district].filter(Boolean).join(", ");
      if (subTxt) sheet.appendChild(el("div", "map-confirm-address", escapeHtml(subTxt)));

      // Название и район всегда можно поправить прямо здесь.
      var editBox = el("div", "map-edit-box");
      editBox.innerHTML =
        '<div class="field"><label>' + escapeHtml(t("address.newPointField")) + '</label><input type="text" class="mp-name"></div>' +
        '<div class="field"><label>' + escapeHtml(t("address.newZoneField")) + '</label><input type="text" class="mp-zone"></div>';
      var nameInput = editBox.querySelector(".mp-name");
      var zoneInput = editBox.querySelector(".mp-zone");
      nameInput.value = label;
      zoneInput.value = district;
      // Пока клиент печатает — карта не должна перерисовывать/перекидывать
      // шторку (клавиатура меняет размер карты и вызывает moveend).
      editBox.addEventListener("focusin", function () { sheetLocked = true; });
      sheet.appendChild(editBox);

      var confirmBtn = el("button", "btn-primary", t("address.confirmHere"));
      confirmBtn.addEventListener("click", function () {
        var pointVal = nameInput.value.trim();
        var zoneVal = zoneInput.value.trim();
        if (origin && pointVal === origin.name && zoneVal === (origin.zone || "")) {
          haptic("success");
          onPicked({ zone: origin.zone || "", point: origin.name, isNewPoint: false, lat: null, lon: null });
          return;
        }
        if (!pointVal || !zoneVal) { toast(t("address.fillBoth")); return; }
        haptic("success");
        onPicked({ zone: zoneVal, point: pointVal, isNewPoint: true, lat: lat, lon: lon });
      });
      sheet.appendChild(confirmBtn);
    }

    function lookupCenter() {
      var c = map.getCenter();
      var seq = ++reverseSeq;
      renderSheetLoading();
      api("/api/reverse?lat=" + c.lat + "&lon=" + c.lng).then(function (data) {
        if (seq !== reverseSeq) return;
        var place = data && data.place;
        if (!place) place = { title: "", subtitle: "", label: "", district: "", lat: c.lat, lon: c.lng };
        renderSheetNew(place);
      }).catch(function () {
        if (seq !== reverseSeq) return;
        renderSheetNew({ title: "", subtitle: "", label: "", district: "", lat: c.lat, lon: c.lng });
      });
    }

    function focusPlace(place) {
      var lat = parseFloat(place.lat), lon = parseFloat(place.lon);
      reverseSeq++;
      sheetLocked = false;
      holdUntil = Date.now() + 1800;
      renderSheetNew(place);
      map.setView([lat, lon], 17, { animate: true });
    }

    loadDeliveryPoints().then(function (points) {
      allPoints = points;
      points.forEach(function (p) {
        var marker = L.marker([p.lat, p.lon], { icon: mapMarkerIcon("existing") }).addTo(map);
        marker.on("click", function (e) {
          if (e.originalEvent) L.DomEvent.stopPropagation(e);
          haptic("select");
          reverseSeq++;
          holdUntil = Date.now() + 1800;
          renderSheetExisting(p);
          map.setView([p.lat, p.lon], Math.max(map.getZoom(), 16), { animate: true });
        });
      });
    });

    map.on("dragstart", function () { sheetLocked = false; holdUntil = 0; lift(true); resultsList.hidden = true; searchInput.blur(); });
    map.on("movestart", function () { lift(true); });
    map.on("moveend", function () {
      lift(false);
      if (sheetLocked || Date.now() < holdUntil) return;
      if (map.getZoom() < 13) { sheet.classList.remove("show"); current = null; return; }
      lookupCenter();
    });

    // Подсказки при вводе
    var searchTimer = null, searchSeq = 0;
    function showResults(items, emptyText) {
      resultsList.innerHTML = "";
      resultsList.hidden = false;
      if (!items.length) { resultsList.appendChild(el("div", "map-search-empty", escapeHtml(emptyText))); return; }
      items.forEach(function (r) {
        var row = el("button", "map-search-result");
        row.innerHTML = '<span class="map-search-result-ico">' + ICON_MAP_PIN + '</span><span class="map-search-result-txt"><b>' +
          escapeHtml(r.title) + '</b>' + (r.subtitle ? '<small>' + escapeHtml(r.subtitle) + '</small>' : '') + '</span>';
        row.addEventListener("click", function () {
          haptic("select");
          resultsList.hidden = true;
          searchInput.value = r.title;
          clearBtn.hidden = false;
          searchInput.blur();
          if (r.existing) {
            reverseSeq++;
            holdUntil = Date.now() + 1800;
            renderSheetExisting(r.existing);
            map.setView([r.existing.lat, r.existing.lon], 17, { animate: true });
          } else {
            focusPlace(r);
          }
        });
        resultsList.appendChild(row);
      });
    }
    searchInput.addEventListener("input", function () {
      clearTimeout(searchTimer);
      var q = searchInput.value.trim();
      clearBtn.hidden = !searchInput.value;
      if (q.length < 3) { resultsList.hidden = true; return; }
      var seq = ++searchSeq;
      // Свои сохранённые точки (БЦ, места, куда уже возим) — сразу и выше
      // всего, пока грузятся внешние подсказки; одноимённые внешние
      // (могут быть устаревшими) отбрасываем.
      var tokens = q.toLowerCase().split(/\s+/).filter(Boolean);
      var local = allPoints.filter(function (p) {
        var hay = ((p.name || "") + " " + (p.address || "") + " " + (p.zone || "")).toLowerCase();
        return tokens.every(function (tk) { return hay.indexOf(tk) !== -1; });
      }).sort(function (a, b) {
        var as = a.name.toLowerCase().indexOf(tokens[0]) === 0 ? 0 : 1;
        var bs = b.name.toLowerCase().indexOf(tokens[0]) === 0 ? 0 : 1;
        return as - bs;
      }).slice(0, 4).map(function (p) {
        return { title: p.name, subtitle: [p.address && p.address !== p.name ? p.address : "", p.zone].filter(Boolean).join(", "), existing: p };
      });
      var normName = function (x) { return (x || "").toLowerCase().replace(/[^0-9a-zа-яё]+/g, ""); };
      if (local.length) showResults(local, "");
      searchTimer = setTimeout(function () {
        api("/api/geocode?q=" + encodeURIComponent(q)).then(function (data) {
          if (seq !== searchSeq) return;
          var names = {};
          local.forEach(function (l) { names[normName(l.title)] = true; });
          var ext = (data.results || []).filter(function (r) { return !names[normName(r.title)]; });
          showResults(local.concat(ext), t("address.noResults"));
        }).catch(function () {});
      }, 350);
    });
    clearBtn.addEventListener("click", function () {
      searchInput.value = "";
      clearBtn.hidden = true;
      resultsList.hidden = true;
      searchInput.focus();
    });

    locateBtn.addEventListener("click", function () {
      haptic("select");
      if (!navigator.geolocation) { toast(t("address.locateFail")); return; }
      navigator.geolocation.getCurrentPosition(function (pos) {
        holdUntil = 0;
        map.setView([pos.coords.latitude, pos.coords.longitude], 17, { animate: true });
      }, function () { toast(t("address.locateFail")); }, { enableHighAccuracy: true, timeout: 8000 });
    });
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

  // Статические подписи вне рендер-функций экранов (нижняя навигация,
  // сплэш) — сами по себе не перерисовываются при заходе на вкладку,
  // поэтому обновляются отдельно здесь: один раз при старте и заново при
  // смене языка (см. applyLangToUI/setLang в openLanguageSubscreen).
  function applyStaticI18n() {
    document.getElementById("splash-tagline-1").textContent = t("splash.tagline1");
    document.getElementById("splash-tagline-2").textContent = t("splash.tagline2");
    document.getElementById("splash-start").textContent = t("splash.start");
    var navKeys = { home: "nav.home", menu: "nav.menu", club: "nav.club", messages: "nav.messages", profile: "nav.profile" };
    Array.prototype.forEach.call(document.querySelectorAll(".nav-item"), function (b) {
      var span = b.querySelector("span");
      var key = navKeys[b.dataset.screen];
      if (span && key) span.textContent = t(key);
      if (key) b.setAttribute("aria-label", t(key));
    });
  }

  // Перерисовывает то, что уже видно на экране, сразу после смены языка
  // в Настройках — без этого пришлось бы заново открывать вкладку, чтобы
  // увидеть эффект.
  function applyLangToUI() {
    applyStaticI18n();
    // Перерисовываем не только видимый сейчас экран, а все вкладки, для
    // которых уже есть загруженные данные — иначе смена языка в
    // Настройках (открываются только из Профиля) была бы видна сразу
    // лишь там, а остальные вкладки показывали бы старый язык до
    // следующей полной перезагрузки данных на них.
    if (state.home) renderHomeScreen();
    if (state.menu) renderMenuScreen();
    if (state.feed) { renderMessagesFeedScreen(); }
    if (state.leaderboard || state.giveaway || state.feed) renderClubNowCards();
    if (state.profile) renderProfileScreen();
  }

  // Послание за первый заказ на новую точку выдаётся не сразу, а после
  // подтверждения адреса — показываем окном поверх приложения при открытии.
  function checkPendingCare() {
    api("/api/care/pending").then(function (data) {
      var c = data && data.care;
      if (!c) return;
      openCareViewer([{ number: c.number, text: c.phrase }], c.total, 0, {
        banner: t("care.firstOrder"),
        onClose: function () {
          api("/api/care/seen", { method: "POST", body: { number: c.number } }).catch(function () {});
        },
      });
    }).catch(function () {});
  }

  function init() {
    applyStaticI18n();
    maybeShowSplash();
    resetCheckout();
    editState = {};
    initNav();
    initBottomNavScroll();
    api("/api/me").then(function (me) {
      state.myTgId = me.tg_id || "";
      state.isMainAdmin = !!me.is_main_admin;
      state.paFinance = !!me.pa_finance;
      state.paDebtors = !!me.pa_debtors;
      state.paMenu = !!me.pa_menu;
      showScreen("home");
      checkPendingCare();
      if (/[?&]pay=today\b/.test(location.search)) openProfileSubscreen(t("pay.title"), loadPayToday);
    }).catch(function (err) {
      var root = document.getElementById("home-root");
      root.innerHTML = "";
      if (err.status === 401 || err.status === 403) {
        root.appendChild(el("div", "menu-state", "<h2>" + t("access.deniedTitle") + "</h2><p>" + t("access.deniedText") + "</p>"));
      } else {
        root.appendChild(el("div", "menu-state", "<h2>" + t("access.errorTitle") + "</h2><p>" + t("access.errorText") + "</p>"));
      }
    });
  }

  document.addEventListener("DOMContentLoaded", init);
})();
