/* Перевод Mini App «Маршрут» на узбекский (латиница). Русский — исходный язык:
   тексты в app.js/index.html остаются русскими, а при выбранном языке "uz" этот
   модуль заменяет их в DOM (текст, placeholder, title, aria-label) и в тостах.
   Формат пары: [русский, узбекский, "x"] — "x" значит "только полное совпадение
   текста" (для коротких слов, чтобы не задеть имена/адреса); без "x" — подстрока. */
(function () {
  "use strict";

  var LANG_KEY = "route_lang_v1";

  function detect() {
    try {
      var v = localStorage.getItem(LANG_KEY);
      if (v === "uz" || v === "ru") return v;
    } catch (e) {}
    try {
      var tg = window.Telegram && window.Telegram.WebApp;
      var u = tg && tg.initDataUnsafe && tg.initDataUnsafe.user;
      if (u && u.language_code === "uz") return "uz";
    } catch (e) {}
    return "ru";
  }

  var lang = detect();

  var PAIRS = [
    // --- навигация / общее ---
    ["Маршрут PAUSE", "PAUSE marshruti"],
    ["Маршрут", "Marshrut", "x"],
    ["Профиль", "Profil", "x"],
    ["Назад", "Orqaga", "x"],
    ["Закрыть", "Yopish", "x"],
    ["Отмена", "Bekor qilish", "x"],
    ["Готово", "Tayyor", "x"],
    ["Сохранить", "Saqlash", "x"],
    ["Изменить", "O'zgartirish", "x"],
    ["Удалить", "O'chirish", "x"],
    ["Повторить", "Qayta urinish", "x"],
    ["Подтвердить", "Tasdiqlash", "x"],
    ["Подтвердите действие", "Amalni tasdiqlang"],
    ["Загрузка…", "Yuklanmoqda…"],
    ["Сегодня", "Bugun", "x"],
    ["Завтра", "Ertaga", "x"],
    ["Вчера", "Kecha", "x"],
    ["сегодня", "bugun", "x"],
    ["Все", "Hammasi", "x"],
    ["Курьер", "Kuryer", "x"],
    ["Администратор", "Administrator", "x"],
    ["Админ", "Admin", "x"],
    ["Режим «Курьер» включён", "«Kuryer» rejimi yoqildi"],
    ["Режим «Администратор» включён", "«Administrator» rejimi yoqildi"],
    ["Не удалось переключить режим: ", "Rejimni almashtirib bo'lmadi: "],
    ["Без имени", "Ismsiz", "x"],
    ["Временная проблема связи с сервером", "Serverga ulanishda vaqtinchalik muammo"],
    ["Этот экран доступен только зарегистрированным курьерам и админу.", "Bu ekran faqat ro'yxatdan o'tgan kuryerlar va adminga ochiq."],
    // --- маршрут ---
    ["На сегодня точек с заказами пока нет 🌿", "Bugun buyurtmali nuqtalar hozircha yo'q 🌿"],
    ["На эту дату заказов пока нет 🌿", "Bu sana uchun buyurtmalar hozircha yo'q 🌿"],
    ["У этого курьера нет точек на эту дату 🌿", "Bu kuryerning shu sanada nuqtalari yo'q 🌿"],
    ["Маршрут на этот день ещё готовится — сообщим, как будет готов 🌿", "Bu kunning marshruti hali tayyorlanmoqda — tayyor bo'lganda xabar beramiz 🌿"],
    ["Не получилось загрузить маршрут — временная проблема с сервером.", "Marshrutni yuklab bo'lmadi — serverda vaqtinchalik muammo."],
    ["Не удалось загрузить маршрут: ", "Marshrutni yuklab bo'lmadi: "],
    ["Не удалось сохранить порядок, показываю сохранённый: ", "Tartibni saqlab bo'lmadi, saqlangan holat ko'rsatilmoqda: "],
    ["+ Добавить точку", "+ Nuqta qo'shish"],
    ["Добавить точку", "Nuqta qo'shish"],
    ["Удалённые точки", "O'chirilgan nuqtalar"],
    ["Удалённых точек нет", "O'chirilgan nuqtalar yo'q"],
    [" — вернуть", " — qaytarish"],
    ["Точка возвращена", "Nuqta qaytarildi"],
    ["Не удалось вернуть: ", "Qaytarib bo'lmadi: "],
    ["Ошибка загрузки", "Yuklashda xatolik"],
    ["Все точки из справочника уже в маршруте", "Ma'lumotnomadagi barcha nuqtalar marshrutda"],
    ["Не удалось добавить: ", "Qo'shib bo'lmadi: "],
    ["Не удалось убрать точку: ", "Nuqtani olib tashlab bo'lmadi: "],
    ["Убрать «", "«"],
    ["» из маршрута на ", "» nuqtasini marshrutdan olib tashlash: "],
    ["Да, убрать", "Ha, olib tashlash"],
    ["Курьер не назначен", "Kuryer tayinlanmagan"],
    ["Назначить курьеров", "Kuryerlarni tayinlash"],
    ["Нет ни одного курьера в справочнике «Курьеры»", "«Kuryerlar» ro'yxatida birorta ham kuryer yo'q"],
    ["Не удалось изменить курьеров: ", "Kuryerlarni o'zgartirib bo'lmadi: "],
    ["Закрепить", "Mahkamlash", "x"],
    ["Открепить", "Mahkamlashni olib tashlash", "x"],
    ["Не удалось изменить закрепление: ", "Mahkamlashni o'zgartirib bo'lmadi: "],
    ["Комментарий для курьера", "Kuryer uchun izoh"],
    ["заберёт Тимур, звоните ему", "Timur oladi, unga qo'ng'iroq qiling"],
    ["Комментарий сохранён", "Izoh saqlandi"],
    ["Не удалось сохранить комментарий: ", "Izohni saqlab bo'lmadi: "],
    ["Телефон", "Telefon", "x"],
    ["Скопировать номер", "Raqamni nusxalash"],
    ["Номер скопирован: ", "Raqam nusxalandi: "],
    ["Не удалось скопировать номер", "Raqamni nusxalab bo'lmadi"],
    ["Нет координат в «Точки доставки» — впишите широту/долготу", "«Yetkazib berish nuqtalari»da koordinatalar yo'q — kenglik/uzunlikni kiriting"],
    ["Точки доставки", "Yetkazib berish nuqtalari", "x"],
    ["Поехали", "Yo'lga chiqdim", "x"],
    ["Сдано", "Topshirildi", "x"],
    ["Сдано ", "Topshirildi "],
    [" — Сдано ", " — Topshirildi "],
    ["Следующая", "Keyingi", "x"],
    ["Не удалось отметить: ", "Belgilab bo'lmadi: "],
    ["Подъезжаю", "Yaqinlashyapman"],
    ["Выехал", "Yo'lga chiqdi"],
    ["Клиентам придёт: курьер выехал", "Mijozlarga xabar: kuryer yo'lga chiqdi", "x"],
    ["Клиентам придёт: курьер будет через 5 минут", "Mijozlarga xabar: kuryer 5 daqiqadan keyin yetib keladi", "x"],
    ["Заказ передан клиенту", "Buyurtma mijozga topshirildi", "x"],
    ["Отправляем…", "Yuborilmoqda…", "x"],
    ["Не получилось, нажмите ещё раз", "Bo'lmadi, yana bir marta bosing", "x"],
    ["Уже отправлено ранее", "Avval yuborilgan", "x"],
    ["Отмечено (получателей нет)", "Belgilandi (qabul qiluvchilar yo'q)", "x"],
    ["Клиентам сообщили", "Mijozlarga xabar berildi", "x"],
    ["Клиентам отправлено: ", "Mijozlarga yuborildi: "],
    ["Клиенты уже предупреждены", "Mijozlar allaqachon ogohlantirilgan"],
    ["Не удалось: ", "Bajarib bo'lmadi: "],
    ["Старт: ", "Boshlash: "],
    ["Старт", "Boshlash", "x"],
    ["нет точек", "nuqtalar yo'q", "x"],
    ["нет заказов", "buyurtmalar yo'q", "x"],
    ["На сегодня", "Bugunga", "x"],
    ["Неизвестно", "Noma'lum", "x"],
    ["Ожидает", "Kutilmoqda", "x"],
    ["В пути", "Yo'lda", "x"],
    ["Убрано", "Olib tashlangan", "x"],
    // --- наличные ---
    ["Наличные — кто дал?", "Naqd pul — kim berdi?"],
    ["Наличные — ", "Naqd pul — "],
    ["Наличные у курьера", "Kuryerdagi naqd pul", "x"],
    ["Наличные от клиентов", "Mijozlardan naqd pul", "x"],
    ["Наличные", "Naqd pul", "x"],
    ["вкл. доставку", "yetkazib berish bilan"],
    ["💵 Наличные", "💵 Naqd pul", "x"],
    ["На точке нет заказов", "Nuqtada buyurtmalar yo'q"],
    ["← Назад к списку", "← Ro'yxatga qaytish"],
    ["Сумма, которую дал клиент", "Mijoz bergan summa", "x"],
    ["Введите сумму", "Summani kiriting"],
    ["Записано: ", "Yozildi: "],
    ["Не удалось записать: ", "Yozib bo'lmadi: "],
    ["Забрать наличные", "Naqd pulni olish", "x"],
    ["Забрать все наличные", "Barcha naqd pulni olish", "x"],
    ["Забрать выбранное", "Tanlanganini olish", "x"],
    ["Забрано наличных: ", "Olingan naqd pul: "],
    ["У курьера сейчас нет наличных на руках.", "Kuryerning qo'lida hozir naqd pul yo'q."],
    ["Забрать сумму (на руках ", "Summani olish (qo'lida "],
    ["Забрать эту сумму", "Shu summani olish", "x"],
    ["На руках только ", "Qo'lida faqat "],
    ["Или выбрать дни", "Yoki kunlarni tanlang", "x"],
    ["Отметьте хотя бы один день", "Kamida bitta kunni belgilang"],
    ["Кто дал наличные", "Naqd pulni kim berdi", "x"],
    ["Нет записей от клиентов за этот день.", "Bu kun uchun mijozlardan yozuvlar yo'q."],
    ["Пока нет записей.", "Hozircha yozuvlar yo'q."],
    ["Получено от клиентов: ", "Mijozlardan olingan: "],
    ["Забрано администратором: ", "Administrator olgan: "],
    ["Общая сумма у курьера", "Kuryerdagi umumiy summa", "x"],
    ["Общая сумма денег от клиентов", "Mijozlardan olingan pulning umumiy summasi", "x"],
    ["Собрано всего ", "Jami yig'ilgan "],
    [" − забрали ", " − olingan "],
    [" − оплачено из наличных ", " − naqd puldan to'langan "],
    ["Не удалось загрузить кассу: ", "Kassani yuklab bo'lmadi: "],
    ["Не удалось загрузить остаток наличных: ", "Naqd pul qoldig'ini yuklab bo'lmadi: "],
    // --- заработок ---
    ["Доход курьера", "Kuryer daromadi", "x"],
    ["Мой заработок", "Mening daromadim", "x"],
    ["Мои доходы", "Mening daromadlarim", "x"],
    ["Заработок", "Daromad", "x"],
    ["Оплата за смену", "Smena uchun to'lov", "x"],
    ["Сумма за смену", "Smena summasi", "x"],
    ["Дата", "Sana", "x"],
    ["С", "Dan", "x"],
    ["По", "Gacha", "x"],
    ["Оплатить", "To'lash", "x"],
    ["Оплатить курьеру наличными?", "Kuryerga naqd pul bilan to'laysizmi?"],
    ["Собрано наличными у курьера: ", "Kuryerda yig'ilgan naqd pul: "],
    [". Сумма оплаты за смену: ", ". Smena to'lovi summasi: "],
    ["Да, из наличных", "Ha, naqd puldan"],
    ["Оплатить отдельно", "Alohida to'lash"],
    ["Оплата сохранена", "To'lov saqlandi"],
    ["Вы уже оплатили курьеру", "Siz kuryerga allaqachon to'lagansiz"],
    [" уже оплачено ", " allaqachon to'langan: "],
    [". Заплатить ещё ", ". Yana to'lansinmi: "],
    ["? Итого будет ", "? Jami bo'ladi: "],
    ["Да, заплатить ещё", "Ha, yana to'lash"],
    ["Недостаточно наличных у курьера: доступно ", "Kuryerda naqd pul yetarli emas: mavjud "],
    ["Не удалось сохранить: ", "Saqlab bo'lmadi: "],
    ["Оплачено из наличных клиентов", "Mijozlarning naqd pulidan to'langan"],
    ["Оплачено отдельно", "Alohida to'langan"],
    ["Оплачено ", "To'langan "],
    ["Удалить оплату?", "To'lov o'chirilsinmi?"],
    [". Эта сумма вернётся в «Наличные у курьера».", ". Bu summa «Kuryerdagi naqd pul»ga qaytadi."],
    ["Оплата удалена", "To'lov o'chirildi"],
    ["Изменить оплату", "To'lovni o'zgartirish"],
    [" — сумма за смену", " — smena summasi"],
    ["Да, удалить", "Ha, o'chirish", "x"],
    ["Удалено", "O'chirildi", "x"],
    ["Сохранено", "Saqlandi", "x"],
    ["Не удалось удалить: ", "O'chirib bo'lmadi: "],
    ["Не удалось загрузить: ", "Yuklab bo'lmadi: "],
    ["Не удалось загрузить доходы: ", "Daromadlarni yuklab bo'lmadi: "],
    ["Не удалось загрузить список: ", "Ro'yxatni yuklab bo'lmadi: "],
    ["Не удалось загрузить показатели: ", "Ko'rsatkichlarni yuklab bo'lmadi: "],
    ["Не удалось загрузить расходы: ", "Xarajatlarni yuklab bo'lmadi: "],
    ["Не удалось загрузить список дат: ", "Sanalar ro'yxatini yuklab bo'lmadi: "],
    // --- очистка истории ---
    ["Передать другому курьеру", "Boshqa kuryerga berish", "x"],
    ["Изменить остаток", "Qoldiqni o'zgartirish", "x"],
    ["Передать наличные", "Naqd pulni berish", "x"],
    ["Кому передать:", "Kimga berish:", "x"],
    ["Вся сумма на руках", "Qo'ldagi butun summa", "x"],
    ["Передать", "Berish", "x"],
    ["Сколько реально на руках у курьера", "Kuryerning qo'lida haqiqatda qancha bor", "x"],
    ["Наличные у курьеров", "Kuryerlardagi naqd pul", "x"],
    ["Показывать во вкладках на главном экране", "Asosiy ekrandagi yorliqlarda ko'rsatish", "x"],
    ["Сохранить имя", "Ismni saqlash", "x"],
    ["Перенести историю в другого курьера", "Tarixni boshqa kuryerga o'tkazish", "x"],
    ["Остаток сохранён", "Qoldiq saqlandi", "x"],
    ["Имя сохранено", "Ism saqlandi", "x"],
    ["Очистить историю платежей курьера?", "Kuryerning to'lovlar tarixi tozalansinmi?"],
    ["Очистить историю платежей", "To'lovlar tarixini tozalash"],
    ["Удалятся его оплаты за смену и списания наличных (копия сохранится в листе «Архив истории курьеров»), ", "Uning smena to'lovlari va naqd pul yechimlari o'chiriladi (nusxasi «Kuryerlar tarixi arxivi» varag'ida saqlanadi), "],
    ["наличные и остаток начнут считаться с сегодняшнего дня. Записи «кто сколько дал» останутся. ", "naqd pul va qoldiq bugundan boshlab hisoblanadi. «Kim qancha bergan» yozuvlari qoladi. "],
    ["Расходы на этого курьера пропадут и из Финансов за прошлые дни. Остаток наличных на руках у курьера тоже обнулится в приложении.", "Bu kuryer xarajatlari o'tgan kunlar uchun Moliyadan ham yo'qoladi. Kuryer qo'lidagi naqd pul qoldig'i ham ilovada nolga tushadi."],
    ["Да, очистить", "Ha, tozalash", "x"],
    ["История очищена: оплат ", "Tarix tozalandi: to'lovlar "],
    [", списаний ", ", yechimlar "],
    ["Не удалось очистить: ", "Tozalab bo'lmadi: "],
    // --- расходы на доставку/логистику ---
    ["Расходы на логистику", "Logistika xarajatlari", "x"],
    ["Расходы сохранены", "Xarajatlar saqlandi"],
    ["Доставка через сервисы (Яндекс, Uklon и др.)", "Servislar orqali yetkazib berish (Yandex, Uklon va boshqalar)"],
    ["Доставка через сервисы", "Servislar orqali yetkazib berish", "x"],
    ["Сохранить расходы на доставку", "Yetkazib berish xarajatlarini saqlash"],
    ["История расходов на сервисы", "Servis xarajatlari tarixi"],
    ["Удалить расход?", "Xarajat o'chirilsinmi?"],
    ["Изменить расход", "Xarajatni o'zgartirish"],
    [" — сумма, сум", " — summa, so'm"],
    ["Всего: ", "Jami: "],
    ["Нет действующих курьеров", "Faol kuryerlar yo'q"],
    ["сум", "so'm", "x"],
    // --- центр управления ---
    ["Центр управления", "Boshqaruv markazi", "x"],
    ["Видимость маршрутов", "Marshrutlar ko'rinishi", "x"],
    ["Курьеры", "Kuryerlar", "x"],
    ["Оповещения клиентам", "Mijozlarga xabarnomalar", "x"],
    ["Курьер рядом", "Kuryer yaqin", "x"],
    ["Клиентам точки приходит «вы следующие» (после сдачи предыдущей точки) и «курьер подъезжает» (по кнопке «Подъезжаю»).", "Nuqta mijozlariga «siz keyingisiz» (oldingi nuqta topshirilgach) va «kuryer yaqinlashmoqda» («Yaqinlashyapman» tugmasi bo'yicha) xabarlari yuboriladi."],
    ["Оповещения включены", "Xabarnomalar yoqildi"],
    ["Оповещения выключены", "Xabarnomalar o'chirildi"],
    ["Уведомить", "Xabar berish", "x"],
    ["Курьеров уведомлено: ", "Xabar berilgan kuryerlar: "],
    ["Никто не получил: на эту дату нет курьеров на точках", "Hech kim olmadi: bu sanada nuqtalarda kuryerlar yo'q"],
    ["Никто не получил: у назначенных курьеров (", "Hech kim olmadi: tayinlangan kuryerlarda ("],
    [") выключены уведомления или бот недоступен", ") xabarnomalar o'chirilgan yoki bot mavjud emas"],
    ["Курьер уведомлён — маршрут на ", "Kuryerga xabar berildi — marshrut: "],
    [" для него открыт", " uning uchun ochiq"],
    ["Видимость включена. Уведомление не отправлено: курьер не назначен на точки этой даты, у него выключены уведомления или видимость уже была включена. Кнопка «Уведомить» отправит повторно.", "Ko'rinish yoqildi. Xabar yuborilmadi: kuryer bu sana nuqtalariga tayinlanmagan, uning xabarnomalari o'chirilgan yoki ko'rinish avval yoqilgan edi. «Xabar berish» tugmasi qayta yuboradi."],
    ["Видимость выключена", "Ko'rinish o'chirildi"],
    ["Не удалось изменить видимость: ", "Ko'rinishni o'zgartirib bo'lmadi: "],
    ["Найти дату — например, 15.09.2026", "Sanani toping — masalan, 15.09.2026"],
    ["Ничего не найдено", "Hech narsa topilmadi"],
    ["Пока нет доступных дат", "Hozircha mavjud sanalar yo'q"],
    [" · сегодня", " · bugun"],
    ["Время сдачи заказов", "Buyurtmalarni topshirish vaqti", "x"],
    ["Дедлайн", "Muddat", "x"],
    ["Дедлайн сохранён", "Muddat saqlandi"],
    ["Укажите время", "Vaqtni kiriting"],
    ["Что это значит", "Bu nima degani"],
    ["Время, после которого каждая минута считается опозданием и снижает показатель эффективности доставки.", "Shundan keyin har bir daqiqa kechikish hisoblanadi va yetkazib berish samaradorligi ko'rsatkichini pasaytiradi."],
    ["Эффективность доставки", "Yetkazib berish samaradorligi", "x"],
    ["Свой период", "O'z davringiz", "x"],
    ["7 дней", "7 kun", "x"],
    ["30 дней", "30 kun", "x"],
    ["Показать", "Ko'rsatish", "x"],
    ["Среднее время сдачи за период: ", "Davr bo'yicha o'rtacha topshirish vaqti: "],
    ["За этот период ещё нет ни одной сданной точки.", "Bu davrda hali birorta ham topshirilgan nuqta yo'q."],
    ["Курьер не найден", "Kuryer topilmadi"],
    ["Не удалось открыть карточку курьера: ", "Kuryer kartochkasini ochib bo'lmadi: "],
    ["Написать", "Yozish", "x"],
    ["Позвонить", "Qo'ng'iroq qilish", "x"],
    ["Написать курьеру", "Kuryerga yozish", "x"],
    ["Позвонить курьеру", "Kuryerga qo'ng'iroq qilish", "x"],
    ["Номер телефона не указан", "Telefon raqami ko'rsatilmagan"],
    ["+ Добавить курьера", "+ Kuryer qo'shish"],
    ["Имя курьера", "Kuryer ismi", "x"],
    ["Имя", "Ism", "x"],
    ["Телефон (необязательно)", "Telefon (majburiy emas)", "x"],
    ["Введите Telegram ID числом", "Telegram ID ni raqam bilan kiriting"],
    ["Введите имя курьера", "Kuryer ismini kiriting"],
    ["Курьер добавлен", "Kuryer qo'shildi"],
    ["Уже добавлены", "Allaqachon qo'shilgan", "x"],
    ["Пока ни одного курьера не добавлено.", "Hozircha birorta kuryer qo'shilmagan."],
    ["Доступ к Mini App Маршрут", "«Marshrut» Mini App'iga kirish", "x"],
    ["Полностью включает или выключает доступ курьера к Mini App «Маршрут». При выключении курьер не может открыть приложение, но его данные не удаляются.", "Kuryerning «Marshrut» Mini App'iga kirishini to'liq yoqadi yoki o'chiradi. O'chirilganda kuryer ilovani ocha olmaydi, lekin uning ma'lumotlari o'chmaydi."],
    ["Доступ к Mini App отключён", "Mini App'ga kirish o'chirildi"],
    ["Доступ к Mini App включён", "Mini App'ga kirish yoqildi"],
    ["Не удалось изменить: ", "O'zgartirib bo'lmadi: "],
    ["Уведомления", "Xabarnomalar", "x"],
    ["Присылать ли этому курьеру уведомление, когда администратор открывает ему видимость маршрута. Доступ к самому приложению не меняет — это отдельный переключатель выше.", "Administrator marshrut ko'rinishini ochganda bu kuryerga xabar yuborilsinmi. Ilovaga kirishni o'zgartirmaydi — bu yuqoridagi alohida tugma."],
    ["Уведомления выключены", "Xabarnomalar o'chirildi"],
    ["Уведомления включены", "Xabarnomalar yoqildi"],
    ["Показывать на главном экране KPI", "KPI bosh ekranida ko'rsatish", "x"],
    ["Показывает или скрывает кружок эффективности этого курьера на главном экране KPI в Профиле. Скрытый курьер продолжает учитываться в общем среднем — скрывается только его собственный кружок.", "Profildagi KPI bosh ekranida bu kuryerning samaradorlik doirasini ko'rsatadi yoki yashiradi. Yashirilgan kuryer umumiy o'rtachaga baribir kiradi — faqat uning doirasi yashiriladi."],
    ["Скрыт с главного экрана KPI", "KPI bosh ekranidan yashirildi"],
    ["Снова виден на главном экране KPI", "KPI bosh ekranida yana ko'rinadi"],
    ["Администратор Маршрута", "Marshrut administratori", "x"],
    ["Даёт курьеру доступ к «Центру управления» — курьерами, кассой и расходами на логистику, как у главного администратора.", "Kuryerga «Boshqaruv markazi»ga kirish beradi — kuryerlar, kassa va logistika xarajatlari bilan ishlash, bosh administrator kabi."],
    ["Назначен администратором Маршрута", "Marshrut administratori etib tayinlandi"],
    ["Снят с администратора Маршрута", "Marshrut administratorligidan olindi"],
    // --- месяцы ---
    ["Январь", "Yanvar"], ["Февраль", "Fevral"], ["Март", "Mart"], ["Апрель", "Aprel"], ["Май", "May"], ["Июнь", "Iyun"],
    ["Июль", "Iyul"], ["Август", "Avgust"], ["Сентябрь", "Sentabr"], ["Октябрь", "Oktabr"], ["Ноябрь", "Noyabr"], ["Декабрь", "Dekabr"]
  ];

  var exact = {};
  var frags = [];
  PAIRS.forEach(function (p) {
    if (p[2] === "x") exact[p[0]] = p[1];
    else frags.push(p);
  });
  // длинные фразы первыми, чтобы короткие не «перебили» их
  frags.sort(function (a, b) { return b[0].length - a[0].length; });

  var CYR = "А-Яа-яЁё";
  function esc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
  var fragRes = frags.map(function (p) {
    var src = p[0];
    var pre = /^[А-Яа-яЁё]/.test(src) ? "(?<![" + CYR + "])" : "";
    var post = /[А-Яа-яЁё]$/.test(src) ? "(?![" + CYR + "])" : "";
    return [new RegExp(pre + esc(src) + post, "g"), p[1]];
  });

  function tr(text) {
    if (lang !== "uz" || !text || !/[А-Яа-яЁё]/.test(text)) return text;
    var trimmed = text.trim();
    if (exact.hasOwnProperty(trimmed)) return text.replace(trimmed, exact[trimmed]);
    var out = text;
    // числа и единицы, которые собираются из кусков
    out = out.replace(/(\d)\s*сум(?![А-Яа-яЁё])/g, "$1 so'm");
    out = out.replace(/(\d+)\s*человек(?:\(а\))?(?![А-Яа-яЁё])/g, "$1 kishi");
    out = out.replace(/(^|\s)За (\d{2}\.\d{2}\.\d{4})/g, "$1$2 sanasi uchun");
    out = out.replace(/so'm от /g, "so'm — ");
    for (var i = 0; i < fragRes.length; i++) out = out.replace(fragRes[i][0], fragRes[i][1]);
    return out;
  }

  function translateNode(root) {
    if (lang !== "uz") return;
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, null);
    var n = walker.currentNode;
    var list = [];
    while (n) { list.push(n); n = walker.nextNode(); }
    list.forEach(function (node) {
      if (node.nodeType === 3) {
        var p = node.parentNode;
        if (p && (p.tagName === "SCRIPT" || p.tagName === "STYLE" || p.tagName === "TEXTAREA")) return;
        var v = tr(node.nodeValue);
        if (v !== node.nodeValue) node.nodeValue = v;
      } else if (node.nodeType === 1) {
        ["placeholder", "title", "aria-label"].forEach(function (a) {
          var val = node.getAttribute && node.getAttribute(a);
          if (val) { var t = tr(val); if (t !== val) node.setAttribute(a, t); }
        });
      }
    });
  }

  function start() {
    if (lang !== "uz") return;
    document.documentElement.lang = "uz";
    document.title = tr(document.title);
    translateNode(document.body);
    var obs = new MutationObserver(function (muts) {
      muts.forEach(function (m) {
        if (m.type === "characterData") {
          var v = tr(m.target.nodeValue);
          if (v !== m.target.nodeValue) m.target.nodeValue = v;
        } else if (m.type === "attributes") {
          var el = m.target, val = el.getAttribute(m.attributeName);
          var t = val && tr(val);
          if (t && t !== val) el.setAttribute(m.attributeName, t);
        } else {
          m.addedNodes.forEach(function (nd) {
            if (nd.nodeType === 3) {
              var v = tr(nd.nodeValue);
              if (v !== nd.nodeValue) nd.nodeValue = v;
            } else if (nd.nodeType === 1) translateNode(nd);
          });
        }
      });
    });
    obs.observe(document.body, {
      childList: true, subtree: true, characterData: true,
      attributes: true, attributeFilter: ["placeholder", "title", "aria-label"],
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();

  window.RouteI18n = {
    lang: lang,
    tr: tr,
    set: function (l) {
      try { localStorage.setItem(LANG_KEY, l); } catch (e) {}
      // язык курьера сохраняем и на сервере — чтобы пуши приходили на нём же
      try {
        var tg = window.Telegram && window.Telegram.WebApp;
        fetch("/api/me/lang", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Telegram-Init-Data": (tg && tg.initData) || "" },
          body: JSON.stringify({ lang: l }),
        }).catch(function () {}).then(function () { location.reload(); });
      } catch (e) { location.reload(); }
    },
  };
})();
