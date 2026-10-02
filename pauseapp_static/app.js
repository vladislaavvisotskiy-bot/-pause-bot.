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
    messagesFilter: "all", // тот же принцип, отдельный фильтр экрана Послания
    favoriteKeys: null,    // null — ещё не грузили; иначе Set(s.key) избранных блюд клиента
    cart: [],              // корзина заказа — переживает закрытие визарда, см. addToCart/syncCartBar
    isMainAdmin: false,    // главный админ бота (config.ADMIN_IDS) — доступ ко всем функциям всегда
    paFinance: false,      // видит "Финансы" в Операционном центре (главному админу — всегда true)
    paDebtors: false,      // видит "Должники" в Операционном центре (главному админу — всегда true)
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
      "home.welcomeName": "Добро пожаловать, {name}",
      "home.welcome": "Добро пожаловать",
      "home.tagline": "Вкусные обеды. Забота о тебе.",
      "home.notify": "Уведомления",
      "home.notifySoon": "Уведомления — скоро добавим",
      "home.todayMenu": "Сегодняшнее меню",
      "home.todayMenuOpen": "На {date} — открыт приём заказов",
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

      "cart.barLabel": "Позиций: {count}",
      "cart.barButton": "Корзина",
      "cart.title": "Ваша корзина",
      "cart.total": "Итого",
      "cart.checkoutBtn": "Оформить заказ",

      "checkout.title": "Оформление заказа",
      "checkout.deliveryTitle": "Куда доставить",
      "checkout.change": "Изменить",
      "checkout.commentTitle": "Комментарий к заказу",
      "checkout.commentPlaceholder": "Необязательно — например, код домофона",
      "checkout.paymentTitle": "Оплата",
      "checkout.cash": "Наличные",
      "checkout.card": "Карта",
      "checkout.attachScreenshot": "Прикрепить скрин",
      "checkout.attachLater": "Прикреплю позже",
      "checkout.screenshotAttached": "Скрин приложен ✓",
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

      "club.title": "Pause Club", "club.more": "Ещё", "club.moreSoon": "Скоро добавим",
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
      "feed.type.giveaway": "Розыгрыш", "feed.type.news": "Новость",

      "messages.title": "Послания",
      "messages.empty": "Пока никаких посланий нет.",
      "messages.loadFailed": "Не удалось загрузить послания — потяните вниз, чтобы попробовать снова.",

      "profile.title": "Профиль", "profile.settings": "Настройки",
      "profile.loadFailed": "Не удалось загрузить профиль: {msg}",
      "profile.notRegistered": "Вы ещё не зарегистрированы. Наберите /start в чате с ботом, чтобы завести профиль.",
      "profile.noName": "Без имени",
      "profile.member": "Участник",
      "profile.toNextLevel": "До статуса «{emoji} {label}» осталось заказов: {left}",
      "profile.topLevel": "Вы уже на высшем уровне PAUSE Club 🎉",
      "club.level.guest": "Гость PAUSE", "club.level.regular": "Своя пауза",
      "club.level.circle": "Внутренний круг", "club.level.ambassador": "VIP Pause Club",
      "profile.statOrders": "заказов", "profile.statPromo": "акции", "profile.statPosts": "постов",
      "profile.myOrders": "Мои заказы", "profile.favorites": "Избранное", "profile.notifications": "Уведомления",
      "profile.bonuses": "Бонусы и промокоды", "profile.support": "Поддержка",
      "profile.bonusesSoon": "Бонусы и промокоды — скоро добавим",
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
      "address.point": "Точка доставки", "address.setPoint": "Указать точку",
      "address.save": "Сохранить", "address.saved": "Сохранено",
      "address.pickFirst": "Сначала выберите точку",
      "address.saveFailed": "Не удалось сохранить: {msg}",
      "address.newPoint": "Новая точка", "address.newPointField": "Адрес / название точки",
      "address.newZoneField": "Район", "address.done": "Готово", "address.fillBoth": "Заполните район и точку",
      "address.searchPlaceholder": "Введите адрес — например, Malika Plaza",
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
      "home.welcomeName": "Xush kelibsiz, {name}",
      "home.welcome": "Xush kelibsiz",
      "home.tagline": "Mazali tushliklar. Sizga g'amxo'rlik.",
      "home.notify": "Bildirishnomalar",
      "home.notifySoon": "Bildirishnomalar — tez orada qo'shamiz",
      "home.todayMenu": "Bugungi menyu",
      "home.todayMenuOpen": "{date} uchun — buyurtmalar qabul qilinmoqda",
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

      "cart.barLabel": "Pozitsiyalar: {count}",
      "cart.barButton": "Savatcha",
      "cart.title": "Savatchangiz",
      "cart.total": "Jami",
      "cart.checkoutBtn": "Buyurtmani rasmiylashtirish",

      "checkout.title": "Buyurtmani rasmiylashtirish",
      "checkout.deliveryTitle": "Qayerga yetkazish",
      "checkout.change": "O'zgartirish",
      "checkout.commentTitle": "Buyurtmaga izoh",
      "checkout.commentPlaceholder": "Ixtiyoriy — masalan, domofon kodi",
      "checkout.paymentTitle": "To'lov",
      "checkout.cash": "Naqd pul",
      "checkout.card": "Karta",
      "checkout.attachScreenshot": "Skrinshot biriktirish",
      "checkout.attachLater": "Keyinroq yuboraman",
      "checkout.screenshotAttached": "Skrinshot biriktirildi ✓",
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

      "club.title": "Pause Club", "club.more": "Yana", "club.moreSoon": "Tez orada qo'shamiz",
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
      "feed.type.giveaway": "Sovg'a o'yini", "feed.type.news": "Yangilik",

      "messages.title": "Xabarlar",
      "messages.empty": "Hozircha xabarlar yo'q.",
      "messages.loadFailed": "Xabarlarni yuklab bo'lmadi — qayta urinish uchun pastga torting.",

      "profile.title": "Profil", "profile.settings": "Sozlamalar",
      "profile.loadFailed": "Profilni yuklab bo'lmadi: {msg}",
      "profile.notRegistered": "Siz hali ro'yxatdan o'tmagansiz. Profil ochish uchun botga /start yozing.",
      "profile.noName": "Ismsiz",
      "profile.member": "A'zo",
      "profile.toNextLevel": "«{emoji} {label}» darajasigacha qolgan buyurtmalar: {left}",
      "profile.topLevel": "Siz allaqachon PAUSE Club eng yuqori darajasidasiz 🎉",
      "club.level.guest": "PAUSE mehmoni", "club.level.regular": "Shaxsiy pauza",
      "club.level.circle": "Ichki doira", "club.level.ambassador": "VIP Pause Club",
      "profile.statOrders": "buyurtma", "profile.statPromo": "aksiya", "profile.statPosts": "post",
      "profile.myOrders": "Buyurtmalarim", "profile.favorites": "Sevimlilar", "profile.notifications": "Bildirishnomalar",
      "profile.bonuses": "Bonus va promokodlar", "profile.support": "Yordam",
      "profile.bonusesSoon": "Bonus va promokodlar — tez orada qo'shamiz",
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
      "address.point": "Yetkazib berish nuqtasi", "address.setPoint": "Nuqtani belgilash",
      "address.save": "Saqlash", "address.saved": "Saqlandi",
      "address.pickFirst": "Avval nuqtani tanlang",
      "address.saveFailed": "Saqlab bo'lmadi: {msg}",
      "address.newPoint": "Yangi nuqta", "address.newPointField": "Manzil / nuqta nomi",
      "address.newZoneField": "Tuman", "address.done": "Tayyor", "address.fillBoth": "Tuman va nuqtani to'ldiring",
      "address.searchPlaceholder": "Manzilni kiriting — masalan, Malika Plaza",
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
      "home.welcomeName": "Welcome, {name}",
      "home.welcome": "Welcome",
      "home.tagline": "Tasty lunches. Care for you.",
      "home.notify": "Notifications",
      "home.notifySoon": "Notifications — coming soon",
      "home.todayMenu": "Today's menu",
      "home.todayMenuOpen": "For {date} — orders are open",
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

      "cart.barLabel": "Items: {count}",
      "cart.barButton": "Cart",
      "cart.title": "Your cart",
      "cart.total": "Total",
      "cart.checkoutBtn": "Proceed to checkout",

      "checkout.title": "Checkout",
      "checkout.deliveryTitle": "Delivery address",
      "checkout.change": "Change",
      "checkout.commentTitle": "Order comment",
      "checkout.commentPlaceholder": "Optional — e.g. intercom code",
      "checkout.paymentTitle": "Payment",
      "checkout.cash": "Cash",
      "checkout.card": "Card",
      "checkout.attachScreenshot": "Attach screenshot",
      "checkout.attachLater": "I'll send it later",
      "checkout.screenshotAttached": "Screenshot attached ✓",
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

      "club.title": "Pause Club", "club.more": "More", "club.moreSoon": "Coming soon",
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
      "feed.type.giveaway": "Giveaway", "feed.type.news": "News",

      "messages.title": "Messages",
      "messages.empty": "No messages yet.",
      "messages.loadFailed": "Couldn't load messages — pull down to try again.",

      "profile.title": "Profile", "profile.settings": "Settings",
      "profile.loadFailed": "Couldn't load profile: {msg}",
      "profile.notRegistered": "You're not registered yet. Send /start in the bot chat to create a profile.",
      "profile.noName": "No name",
      "profile.member": "Member",
      "profile.toNextLevel": "{left} orders left to «{emoji} {label}»",
      "club.level.guest": "PAUSE guest", "club.level.regular": "My Pause",
      "club.level.circle": "Inner Circle", "club.level.ambassador": "VIP Pause Club",
      "profile.topLevel": "You're already at the top PAUSE Club level 🎉",
      "profile.statOrders": "orders", "profile.statPromo": "promos", "profile.statPosts": "posts",
      "profile.myOrders": "My orders", "profile.favorites": "Favorites", "profile.notifications": "Notifications",
      "profile.bonuses": "Bonuses & promo codes", "profile.support": "Support",
      "profile.bonusesSoon": "Bonuses & promo codes — coming soon",
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
      "address.point": "Delivery point", "address.setPoint": "Set a point",
      "address.save": "Save", "address.saved": "Saved",
      "address.pickFirst": "Choose a point first",
      "address.saveFailed": "Couldn't save: {msg}",
      "address.newPoint": "New point", "address.newPointField": "Address / point name",
      "address.newZoneField": "Area", "address.done": "Done", "address.fillBoth": "Fill in the area and the point",
      "address.searchPlaceholder": "Type an address — e.g. Malika Plaza",
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
    regular: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" width="15" height="15" style="vertical-align:-3px"><path d="M12 4c4 2 6 6 6 10a6 6 0 0 1-12 0c0-4 2-8 6-10z"/><path d="M12 7v13"/></svg>',
    circle: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" width="15" height="15" style="vertical-align:-3px"><circle cx="7" cy="12" r="3.3"/><path d="M10.1 12H20"/><path d="M17 12v3M20 12v3"/></svg>',
    ambassador: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" width="15" height="15" style="vertical-align:-3px"><path d="M4 18L6 8L9 13L12 6L15 13L18 8L20 18Z"/></svg>',
  };
  function clubLevelIcon(key) {
    return CLUB_LEVEL_ICONS[key] || "";
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
  //   logo   — true на Главной: веточка + "PAUSE." слева вместо кнопки "назад"
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
      backBtn.setAttribute("aria-label", t("common.back"));
      backBtn.addEventListener("click", function () { haptic("select"); opts.back(); });
      left.appendChild(backBtn);
    } else if (opts.logo) {
      var logo = el("div", "screen-header-logo");
      logo.innerHTML = ICON_SPRIG + '<span>PAUSE.</span>';
      left.appendChild(logo);
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
  // Веточка с листьями рядом с "PAUSE." на Главной — по присланному
  // макету (тонкая линия-стебель + несколько листьев вдоль неё), вместо
  // эмодзи "🌿". Координаты листьев посчитаны (не нарисованы на глаз) —
  // предыдущие попытки руками привели к нечитаемой кляксе, см. отчёт.
  var ICON_SPRIG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" width="19" height="19"><path d="M12.5 21 Q11.85 12.75 10 4.5"/><path d="M11.90 15.22 Q13.86 14.89 14.85 13.16 Q12.88 13.50 11.90 15.22 Z"/><path d="M11.55 12.75 Q10.42 11.11 8.43 10.95 Q9.57 12.59 11.55 12.75 Z"/><path d="M11.06 9.78 Q12.82 9.63 13.83 8.18 Q12.07 8.33 11.06 9.78 Z"/><path d="M10.53 6.97 Q9.95 5.64 8.54 5.30 Q9.11 6.64 10.53 6.97 Z"/></svg>';
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
    if (name === "club") { if (state.feed) renderFeedScreen(); else loadFeed(); }
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
    ]).then(function (results) {
      state.profile = results[0];
      state.menu = results[1];
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

  function renderHomeScreen() {
    screenHeader("home-header", {
      logo: true,
      right: { icon: ICON_BELL_HDR, label: t("home.notify"), onClick: function () { toast(t("home.notifySoon")); } },
    });
    var root = document.getElementById("home-root");
    root.innerHTML = "";
    var p = state.profile;
    var m = state.menu;

    var firstName = (p && p.registered && p.name) ? p.name.trim().split(/\s+/)[0] : "";
    var hero = el("div", "home-hero");
    hero.innerHTML =
      '<h2>' + (firstName ? t("home.welcomeName", { name: escapeHtml(firstName) }) : t("home.welcome")) + '</h2>' +
      '<p>' + t("home.tagline") + '</p>';
    root.appendChild(hero);

    var promo = el("div", "card home-promo");
    promo.addEventListener("click", function () { showScreen("menu"); });
    if (m.published && !m.cutoff_passed) {
      promo.innerHTML =
        '<div class="home-promo-icon">' + ICON_LEAF + '</div>' +
        '<div><div class="home-promo-title">' + t("home.todayMenu") + '</div>' +
        '<div class="home-promo-sub">' + t("home.todayMenuOpen", { date: escapeHtml(m.date || "") }) + '</div></div>' +
        '<div class="home-promo-arrow"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M9 6l6 6-6 6"/></svg></div>';
    } else {
      promo.innerHTML =
        '<div class="home-promo-icon">' + ICON_CLOCK + '</div>' +
        '<div><div class="home-promo-title">' + t("home.menuToday") + '</div>' +
        '<div class="home-promo-sub">' + (m.published ? t("home.cutoffClosed") : t("home.cominSoon")) + '</div></div>';
    }
    root.appendChild(promo);

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
  var ICON_LEAF = '<svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M5 19c8 0 14-6 14-14-8 0-14 6-14 14Z"/><path d="M5 19c3-6 6-9 12-12"/></svg>';

  function renderMenuScreen() {
    screenHeader("menu-header", {
      back: function () { showScreen("home"); },
      title: t("menu.title"),
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
    hero.appendChild(el("h2", null, t("menu.hero")));
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
    sets.forEach(function (s) { grid.appendChild(buildMenuSetCard(s)); });
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
  function buildMenuSetCard(s) {
    var card = el("div", "card menu-set-card");
    var expanded = false;
    var sel = { variantIdx: 0, garnish: "", qty: 1 };
    var localizedName = localizedSetName(s.display_name);

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

      if (s.description && s.description.length) {
        var list = el("ul", "menu-set-card-desc");
        s.description.forEach(function (line) { list.appendChild(el("li", null, escapeHtml(line))); });
        body.appendChild(list);
      }

      if (!expanded) {
        if (s.is_variant_group) {
          var minP = Math.min.apply(null, s.variants.map(function (v) { return v.price; }));
          body.appendChild(el("div", "menu-set-card-price", t("menu.from", { sum: fmtSum(minP) })));
        } else {
          body.appendChild(el("div", "menu-set-card-price", fmtSum(s.price)));
          if (s.has_garnish) body.appendChild(el("div", "menu-set-card-note", t("menu.withGarnish")));
        }
        card.appendChild(body);
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

      var effSet = currentEffSet();
      body.appendChild(el("div", "menu-set-card-price", fmtSum(effSet.price)));

      if (s.is_variant_group) {
        var variantRow = el("div", "menu-set-chip-row");
        variantRow.addEventListener("click", function (e) { e.stopPropagation(); });
        s.variants.forEach(function (v, idx) {
          var chip = el("button", "menu-set-chip" + (sel.variantIdx === idx ? " active" : ""), escapeHtml(localizedVariantLabel(v.label)));
          chip.addEventListener("click", function () { sel.variantIdx = idx; sel.garnish = ""; render(); });
          variantRow.appendChild(chip);
        });
        body.appendChild(variantRow);
      }

      if (effSet.has_garnish && effSet.garnish_options.length) {
        var garnishRow = el("div", "menu-set-chip-row");
        garnishRow.addEventListener("click", function (e) { e.stopPropagation(); });
        effSet.garnish_options.forEach(function (g) {
          var chip = el("button", "menu-set-chip" + (sel.garnish === g.value ? " active" : ""), escapeHtml(g.display));
          chip.addEventListener("click", function () { sel.garnish = g.value; render(); });
          garnishRow.appendChild(chip);
        });
        body.appendChild(garnishRow);
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
          sel = { variantIdx: 0, garnish: "", qty: 1 };
          render();
        });
        addBtnWrap.appendChild(addBtn);
        body.appendChild(addBtnWrap);
      }

      card.appendChild(body);
    }

    render();
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
      root.appendChild(el("div", "feed-empty", t("club.loadFailed")));
      var msgRoot = document.getElementById("messages-feed-root");
      msgRoot.innerHTML = "";
      msgRoot.appendChild(el("div", "feed-empty", t("messages.loadFailed")));
    });
  }

  function renderFeedFilters() {
    var root = document.getElementById("feed-filters");
    root.innerHTML = "";
    var counts = {};
    (state.feed || []).forEach(function (p) { counts[p.type] = (counts[p.type] || 0) + 1; });

    var allChip = el("button", "filter-chip" + (state.feedFilter === "all" ? " active" : ""), t("menu.all"));
    allChip.addEventListener("click", function () { state.feedFilter = "all"; renderFeedScreen(); });
    root.appendChild(allChip);

    FEED_TYPES_ORDER.forEach(function (ft) {
      if (!counts[ft]) return;
      var chip = el("button", "filter-chip" + (state.feedFilter === ft ? " active" : ""), feedTypeLabel(ft));
      chip.addEventListener("click", function () { state.feedFilter = ft; renderFeedScreen(); });
      root.appendChild(chip);
    });
  }

  function renderFeedScreen() {
    screenHeader("club-header", {
      title: t("club.title"),
      right: { icon: ICON_KEBAB, label: t("club.more"), onClick: function () { toast(t("club.moreSoon")); } },
    });
    renderFeedFilters();
    var root = document.getElementById("feed-root");
    root.innerHTML = "";
    var posts = (state.feed || []).filter(function (p) { return state.feedFilter === "all" || p.type === state.feedFilter; });

    if (!posts.length) {
      root.appendChild(el("div", "feed-empty", "<div>" + ICON_LEAF + "</div><p>" + t("club.empty") + "</p>"));
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
    var root = document.getElementById("messages-feed-root");
    renderMessagesFeedFilters();
    root.innerHTML = "";
    var posts = messagesFeedPosts().filter(function (p) {
      return state.messagesFilter === "all" || p.type === state.messagesFilter;
    });
    if (!posts.length) {
      root.appendChild(el("div", "feed-empty", "<div>" + ICON_LEAF + "</div><p>" + t("messages.empty") + "</p>"));
      return;
    }
    posts.forEach(function (post) { root.appendChild(buildFeedPostCard(post)); });
  }

  function buildFeedPostCard(post) {
    var card = el("div", "card feed-post feed-post-" + post.type);

    var delBtn = el("button", "feed-post-delete", "×");
    delBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      showConfirm(t("club.deleteConfirm"), t("club.deleteYes"), function () { deleteFeedPost(post.id); });
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
      renderFeedScreen();
    }).catch(function (err) { toast(t("club.deleteFailed", { msg: err.message })); });
  }

  document.getElementById("feed-compose-btn").addEventListener("click", openComposeFeed);

  function openComposeFeed() {
    var compose = { type: "photo", caption: "", files: [] };

    function renderComposeStep(body) {
      wizardPhaseEl.innerHTML = "";
      body.appendChild(el("h2", "wizard-title", t("club.newPost")));

      var typeRow = el("div", "type-picker-row");
      FEED_TYPES_ORDER.forEach(function (ft) {
        var chip = el("button", "type-picker-chip" + (compose.type === ft ? " selected" : ""), feedTypeLabel(ft));
        chip.addEventListener("click", function () { compose.type = ft; wizardReplace(renderComposeStep); });
        typeRow.appendChild(chip);
      });
      body.appendChild(typeRow);

      var captionField = el("div", "field");
      captionField.innerHTML = '<label>' + (compose.type === "photo" ? t("club.captionOptional") : t("club.postText")) + '</label><textarea id="feed-caption" rows="4"></textarea>';
      body.appendChild(captionField);
      body.querySelector("#feed-caption").value = compose.caption;
      body.querySelector("#feed-caption").addEventListener("input", function (e) { compose.caption = e.target.value; });

      if (compose.type === "photo") {
        var uploadZone = el("div", "upload-zone", t("club.uploadHint"));
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

      var submit = el("button", "btn-primary wizard-footer-btn", t("club.publish"));
      submit.addEventListener("click", function () {
        if (compose.type === "photo" && !compose.files.length) { toast(t("club.needPhoto")); return; }
        if (compose.type !== "photo" && !compose.caption.trim()) { toast(t("club.needText")); return; }
        submit.disabled = true;
        submit.textContent = t("club.publishing");
        apiUploadFeed(compose.type, compose.caption, compose.files).then(function () {
          haptic("success");
          toast(t("club.published"));
          closeWizard();
          state.feed = null;
          loadFeed();
        }).catch(function (err) {
          submit.disabled = false;
          submit.textContent = t("club.publish");
          toast(t("club.publishFailed", { msg: err.message }));
        });
      });
      body.appendChild(submit);
    }

    openWizard(renderComposeStep);
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
    checkout = { zone: "", point: "", isNewPoint: false, lat: null, lon: null, comment: "", payment: "", screenshotFileId: null };
  }
  resetCheckout();

  function garnishDisplayFor(s, value) {
    if (!value || !s.garnish_options) return "";
    var found = s.garnish_options.filter(function (g) { return g.value === value; })[0];
    return found ? found.display : value;
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
      setBtn.appendChild(el("div", "option-row-label", t("address.setPoint")));
      setBtn.addEventListener("click", function () { wizardStep(function (b) { renderDeliveryMapPicker(b, applyCheckoutPoint); }); });
      deliveryField.appendChild(setBtn);
    }
    body.appendChild(deliveryField);
    if (checkout.isNewPoint) body.appendChild(el("p", "center-note", t("checkout.newPointNote")));

    var commentField = el("div", "field");
    commentField.innerHTML =
      '<label>' + escapeHtml(t("checkout.commentTitle")) + '</label>' +
      '<textarea id="checkout-comment" rows="2" placeholder="' + escapeHtml(t("checkout.commentPlaceholder")) + '"></textarea>';
    body.appendChild(commentField);
    var commentInput = commentField.querySelector("textarea");
    commentInput.value = checkout.comment || "";
    commentInput.addEventListener("input", function (e) { checkout.comment = e.target.value; });

    var payField = el("div", "field");
    payField.innerHTML = '<label>' + escapeHtml(t("checkout.paymentTitle")) + '</label>';
    var cashValue = (state.menu.payment_options || []).filter(function (p) { return !/карт/i.test(p); })[0] || t("checkout.cash");
    var cardValue = (state.menu.payment_options || []).filter(function (p) { return /карт/i.test(p); })[0] || t("checkout.card");
    var tilesRow = el("div", "payment-tiles-row");
    [{ value: cashValue, label: t("checkout.cash") }, { value: cardValue, label: t("checkout.card") }].forEach(function (opt) {
      var tile = el("button", "payment-tile" + (checkout.payment === opt.value ? " active" : ""), escapeHtml(opt.label));
      tile.addEventListener("click", function () {
        haptic("select");
        checkout.payment = opt.value;
        if (opt.value === cashValue) checkout.screenshotFileId = null;
        wizardReplace(stepCheckout);
      });
      tilesRow.appendChild(tile);
    });
    payField.appendChild(tilesRow);

    if (checkout.payment && checkout.payment === cardValue) {
      payField.appendChild(el("div", "requisites-box", escapeHtml(state.menu.card_requisites || "")));
      if (checkout.screenshotFileId) {
        payField.appendChild(el("div", "checkout-screenshot-ok", escapeHtml(t("checkout.screenshotAttached"))));
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
        laterBtn.addEventListener("click", function () { checkout.screenshotFileId = null; wizardReplace(stepCheckout); });
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
    if (!checkout.payment) { toast(t("checkout.needPayment")); return; }
    btn.disabled = true;
    btn.textContent = t("checkout.sending");
    api("/api/order", {
      method: "POST",
      body: {
        cart: state.cart.map(function (i) { return { set: i.set, garnish: i.garnish, qty: i.qty }; }),
        zone: checkout.zone, point: checkout.point, is_new_point: checkout.isNewPoint,
        lat: checkout.lat, lon: checkout.lon,
        comment: checkout.comment, payment: checkout.payment, screenshot_file_id: checkout.screenshotFileId,
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
      // сессии, что и происходило до фикса.
      wizardStep(function (b) { stepOrderConfirmed(b, pending, care); });
    }).catch(function () {
      btn.disabled = false;
      btn.textContent = t("checkout.confirmBtn");
      haptic("error");
      toast(t("checkout.submitFailed"));
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

  function stepCareMessageCard(body, care) {
    wizardPhaseEl.innerHTML = "";
    document.getElementById("wizard-back").style.visibility = "hidden";
    var card = el("div", "care-message-card");
    card.innerHTML =
      '<div class="care-message-number">' + escapeHtml(t("care.numberLabel", { number: care.number, total: care.total })) + '</div>' +
      '<div class="care-message-text">«' + escapeHtml(care.phrase) + '»</div>';
    body.appendChild(card);
    var done = el("button", "btn-primary wizard-footer-btn", t("checkout.doneBtn"));
    done.addEventListener("click", function () { closeWizard(); showScreen("menu"); loadMenu(); });
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
      root.appendChild(el("div", "empty-note", t("profile.loadFailed", { msg: err.message })));
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
      pointBtn.innerHTML = '<div class="option-row-label">' + escapeHtml((curZone && curPoint) ? (curZone + ", " + curPoint) : t("address.setPoint")) + '</div>';
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
    var photo = tgPhotoUrl();
    if (photo) {
      var img = el("img", "avatar");
      img.src = photo;
      head.appendChild(img);
    } else {
      head.appendChild(el("div", "avatar", initials(p.name)));
    }
    head.appendChild(el("div", "profile-name", p.name || t("profile.noName")));
    head.appendChild(el("div", "profile-contact", formatPhone(p.phone)));

    // Статус клуба виден сразу, с первого заказа (даже на "Гость PAUSE",
    // 0 заказов) — не прячем, пока не наберётся хоть один, как было
    // раньше. По тапу — сколько осталось до следующего уровня (см.
    // sheets.get_club_level — та же самая чистая функция, что и в боте).
    var badge = el("button", "pill profile-club-badge", clubLevelIcon(p.club.key) + "<span>" + t("profile.member") + " " + clubLevelLabel(p.club.key, p.club.label) + "</span>");
    badge.addEventListener("click", function () {
      haptic("select");
      if (p.club.next_label) {
        var total = p.order_count + p.club.left;
        var pct = total ? Math.min(100, Math.round((p.order_count / total) * 100)) : 0;
        showInfo(
          '<div class="club-progress-label">' + t("profile.toNextLevel", { emoji: clubLevelIcon(p.club.next_key), label: escapeHtml(clubLevelLabel(p.club.next_key, p.club.next_label)), left: p.club.left }) + '</div>' +
          '<div class="club-progress-track"><div class="club-progress-fill" style="width:' + pct + '%"></div></div>'
        );
      } else {
        showInfo('<div class="club-progress-label">' + t("profile.topLevel") + '</div>');
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
    s1.innerHTML = '<div class="profile-stat-value">' + p.order_count + '</div><div class="profile-stat-label">' + t("profile.statOrders") + '</div>';
    s1.addEventListener("click", function () { haptic("select"); openProfileSubscreen(t("orders.title"), loadOrders); });
    var s2 = el("div", "profile-stat");
    s2.innerHTML = '<div class="profile-stat-value">—</div><div class="profile-stat-label">' + t("profile.statPromo") + '</div>';
    var s3 = el("div", "profile-stat");
    var postsCount = (state.feed || []).filter(function (post) { return post.author === p.name; }).length;
    s3.innerHTML = '<div class="profile-stat-value">' + postsCount + '</div><div class="profile-stat-label">' + t("profile.statPosts") + '</div>';
    statRow.appendChild(s1); statRow.appendChild(s2); statRow.appendChild(s3);
    root.appendChild(statRow);

    // Пять строк — ровно как на макете. "Настройки" (точка доставки,
    // имя/телефон) и "Мои послания" туда не входят: первое теперь
    // отдельная иконка-шестерёнка в шапке, второе — уже своя вкладка
    // нижней навигации (Послания), дублировать её здесь незачем.
    var rows = el("div", "card profile-nav-list");
    rows.appendChild(buildProfileRow(ICON_ORDERS, t("profile.myOrders"), function () { openProfileSubscreen(t("orders.title"), loadOrders); }));
    rows.appendChild(buildProfileRow(ICON_HEART, t("profile.favorites"), function () { openProfileSubscreen(t("favorites.title"), loadFavorites); }));
    rows.appendChild(buildProfileRow(ICON_BELL, t("profile.notifications"), openNotifySubscreen));
    rows.appendChild(buildProfileRow(ICON_TAG, t("profile.bonuses"), function () { toast(t("profile.bonusesSoon")); }));
    rows.appendChild(buildProfileRow(ICON_SUPPORT, t("profile.support"), openSupportSubscreen));
    root.appendChild(rows);

    // Операционный центр — пока отдельная карточка под основным списком,
    // не строка внутри него: это админский инструмент, а не часть
    // клиентского профиля, визуально не путаем одно с другим (хотя
    // доступ к ЛЮБОЙ части PAUSE App сейчас и так только у админа).
    // У делегированного админа без единой выданной функции (см.
    // "Операционный центр" → "Администраторы") скрываем саму карточку —
    // незачем вести в пустой хаб без единой доступной кнопки.
    if (state.isMainAdmin || state.paFinance || state.paDebtors) {
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
          var payPill = '<span class="pill ' + (g.paid ? "paid" : "unpaid") + '">' + (g.paid ? t("orders.paid") : t("orders.unpaid")) + '</span>';
          card.innerHTML =
            '<div class="order-card-head"><span class="order-card-date">' + g.date + '</span>' +
            '<span class="order-card-pills">' + payPill + statusPill + '</span></div>' +
            '<div class="order-card-items">' + itemsText(g.items) + (g.is_debt ? t("orders.debtTag") : "") + '</div>';
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
        }
      }
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
  var ICON_OPS_DEBTORS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" width="22" height="22" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3.2"/><path d="M3 20c0.9-3.6 3.2-5.4 6-5.4s5.1 1.8 6 5.4"/><path d="M17 4.5c1.6 0.4 2.8 1.8 2.8 3.5s-1.2 3.1-2.8 3.5M21 20c-0.6-2.4-1.8-4-3.5-4.8"/></svg>';
  var ICON_OPS_ADMINS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" width="22" height="22" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 3v5c0 4.5-2.9 8-7 10-4.1-2-7-5.5-7-10V6l7-3z"/><path d="M9 12l2 2 4-4"/></svg>';

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
        writeBtn.addEventListener("click", function () { window.location.href = data.tg_link; });
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
      root.appendChild(el("h3", "ops-section-title", "История долга"));
      var linesCard = el("div", "card");
      if (data.lines.length) {
        data.lines.forEach(function (l, idx) {
          var row = el("div", "ops-debt-line" + (idx ? " ops-breakdown-row-sep" : "") + (l.resolved ? " ops-debt-line-resolved" : ""));
          var info = el("div", "ops-debt-line-info");
          info.innerHTML =
            '<div class="ops-breakdown-name">' + l.date + ' — ' + escapeHtml(l.display_name) + (l.qty ? ' ×' + l.qty : '') + '</div>';
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

    var searchInput = el("input", "map-search-input");
    searchInput.type = "text";
    searchInput.placeholder = t("address.searchPlaceholder");
    body.appendChild(searchInput);
    var resultsList = el("div", "map-search-results");
    body.appendChild(resultsList);

    var mapWrap = el("div", "map-picker-map");
    body.appendChild(mapWrap);
    body.appendChild(el("p", "map-picker-hint", t("address.mapHint")));

    var sheet = el("div", "map-confirm-sheet");
    sheet.hidden = true;
    body.appendChild(sheet);

    if (typeof L === "undefined") {
      // Leaflet не подгрузился (нет связи с CDN) — без карты пикер
      // бесполезен, честно говорим об этом вместо пустого серого блока.
      mapWrap.outerHTML = '<p class="menu-set-closed-note">' + escapeHtml(t("address.mapUnavailable")) + '</p>';
      return;
    }

    var map = L.map(mapWrap, { zoomControl: false, attributionControl: true }).setView([41.311081, 69.240562], 12);
    L.tileLayer(
      "https://services.arcgisonline.com/arcgis/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}",
      { maxZoom: 18, attribution: "Tiles &copy; Esri" }
    ).addTo(map);
    L.tileLayer(
      "https://services.arcgisonline.com/arcgis/rest/services/Canvas/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}",
      { maxZoom: 18 }
    ).addTo(map);
    setTimeout(function () { map.invalidateSize(); }, 0);

    var allPoints = [];
    var newPinMarker = null;

    function renderSheetExisting(p) {
      sheet.innerHTML = "";
      sheet.hidden = false;
      sheet.appendChild(el("div", "map-confirm-title", escapeHtml(p.name)));
      if (p.address && p.address !== p.name) sheet.appendChild(el("div", "map-confirm-address", escapeHtml(p.address)));
      var confirmBtn = el("button", "btn-primary", t("address.confirmHere"));
      confirmBtn.addEventListener("click", function () {
        haptic("success");
        onPicked({ zone: p.zone || "", point: p.name, isNewPoint: false, lat: null, lon: null });
      });
      sheet.appendChild(confirmBtn);
    }

    function renderSheetNew(lat, lon, addressGuess) {
      var zoneGuess = nearestZoneFor(allPoints, lat, lon);
      sheet.innerHTML = "";
      sheet.hidden = false;
      sheet.appendChild(el("div", "map-confirm-title", t("address.newPoint")));

      var field = el("div", "field");
      field.innerHTML = '<label>' + escapeHtml(t("address.newPointField")) + '</label><input type="text" id="map-point-name">';
      sheet.appendChild(field);
      var pointInput = field.querySelector("input");
      pointInput.value = addressGuess || "";

      var zf = el("div", "field");
      zf.innerHTML = '<label>' + escapeHtml(t("address.newZoneField")) + '</label><input type="text" id="map-zone-name">';
      sheet.appendChild(zf);
      var zoneInput = zf.querySelector("input");
      zoneInput.value = zoneGuess;

      var confirmBtn = el("button", "btn-primary", t("address.confirmHere"));
      confirmBtn.addEventListener("click", function () {
        var pointVal = pointInput.value.trim();
        var zoneVal = zoneInput.value.trim();
        if (!pointVal || !zoneVal) { toast(t("address.fillBoth")); return; }
        haptic("success");
        onPicked({ zone: zoneVal, point: pointVal, isNewPoint: true, lat: lat, lon: lon });
      });
      sheet.appendChild(confirmBtn);
    }

    function placeNewPin(lat, lon) {
      if (newPinMarker) map.removeLayer(newPinMarker);
      newPinMarker = L.marker([lat, lon], { icon: mapMarkerIcon("new") }).addTo(map);
      map.setView([lat, lon], 16);
    }

    loadDeliveryPoints().then(function (points) {
      allPoints = points;
      points.forEach(function (p) {
        var marker = L.marker([p.lat, p.lon], { icon: mapMarkerIcon("existing") }).addTo(map);
        marker.on("click", function () { haptic("select"); renderSheetExisting(p); });
      });
    });

    map.on("click", function (e) {
      haptic("select");
      placeNewPin(e.latlng.lat, e.latlng.lng);
      renderSheetNew(e.latlng.lat, e.latlng.lng, "");
    });

    var searchTimer = null;
    searchInput.addEventListener("input", function () {
      clearTimeout(searchTimer);
      var q = searchInput.value.trim();
      if (q.length < 3) { resultsList.innerHTML = ""; return; }
      searchTimer = setTimeout(function () {
        api("/api/geocode?q=" + encodeURIComponent(q)).then(function (data) {
          resultsList.innerHTML = "";
          (data.results || []).forEach(function (r) {
            var row = el("div", "map-search-result", escapeHtml(r.display_name));
            row.addEventListener("click", function () {
              haptic("select");
              resultsList.innerHTML = "";
              var lat = parseFloat(r.lat), lon = parseFloat(r.lon);
              placeNewPin(lat, lon);
              renderSheetNew(lat, lon, r.display_name);
            });
            resultsList.appendChild(row);
          });
        }).catch(function () {});
      }, 400);
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
    var composeBtn = document.getElementById("feed-compose-btn");
    if (composeBtn) composeBtn.textContent = t("club.publish");
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
    if (state.feed) { renderFeedScreen(); renderMessagesFeedScreen(); }
    if (state.profile) renderProfileScreen();
  }

  function init() {
    applyStaticI18n();
    maybeShowSplash();
    resetCheckout();
    editState = {};
    initNav();
    initBottomNavScroll();
    api("/api/me").then(function (me) {
      state.isMainAdmin = !!me.is_main_admin;
      state.paFinance = !!me.pa_finance;
      state.paDebtors = !!me.pa_debtors;
      showScreen("home");
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
