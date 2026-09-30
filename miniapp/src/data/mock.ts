export type MenuCategory = 'bowls' | 'soups' | 'salads' | 'hot'

export type MenuItem = {
  id: string
  category: MenuCategory
  title: string
  price: number
  image: string
  items: string[]
}

export const menu: MenuItem[] = [
  {
    id: 'pauza-dnya',
    category: 'hot',
    title: 'Пауза дня.',
    price: 60000,
    image: '/images/dish-1.jpg',
    items: [
      'Кордон-блю с сыром и ветчиной',
      'Гарнир рис с горошком и кукурузой',
      'Салат с фетой и помидорами черри',
      'Соус «Бешамель»',
      'Хлеб + приборы',
    ],
  },
  {
    id: 'teriyaki-bowl',
    category: 'bowls',
    title: 'Боул с курицей терияки',
    price: 60000,
    image: '/images/dish-2.jpg',
    items: [
      'Боул с курицей терияки',
      'Отварной рис',
      'Свежие овощи с зеленью и кукурузой',
      'Азиатский соус «Чили-крем»',
      'Компот «Фруктовый»',
      'Хлеб + приборы',
    ],
  },
  {
    id: 'blyudo-dnya',
    category: 'hot',
    title: 'Блюдо дня',
    price: 60000,
    image: '/images/dish-3.jpg',
    items: [
      'Кордон-блю с сыром и ветчиной',
      'Гарнир рис с горошком и кукурузой',
      'Салат с фетой и помидорами черри',
      'Соус «Бешамель»',
      'Хлеб + приборы',
    ],
  },
]

export const menuCategories: { id: MenuCategory | 'all'; label: string }[] = [
  { id: 'all', label: 'Все' },
  { id: 'bowls', label: 'Боулы' },
  { id: 'soups', label: 'Супы' },
  { id: 'salads', label: 'Салаты' },
  { id: 'hot', label: 'Горячее' },
]

export type ClubPost = {
  id: string
  author: string
  date: string
  text: string
  image: string
  likes: number
  comments: number
  shares: number
}

export const clubPosts: ClubPost[] = [
  {
    id: 'club-1',
    author: 'Pause Club',
    date: '12 апреля',
    text: 'Делитесь своими моментами с нашими боулами! 🥗 Самые красивые фото попадают в наш канал и получают приятные подарки.',
    image: '/images/club-post.jpg',
    likes: 245,
    comments: 32,
    shares: 12,
  },
]

// Позиция 5 (индекс 4) в сетке — специальная бежевая карточка с текстом,
// а не фото (см. SPEC.md 4.6): остальные 11 плиток — обычные фото клуба.
export const clubPhotoGrid: { id: string; image: string | null; caption?: string[] }[] = Array.from(
  { length: 12 },
  (_, i) => {
    if (i === 4) {
      return { id: 'club-photo-quote', image: null, caption: ['Счастье', 'в мелочах', '(и в хорошем', 'обеде)'] }
    }
    const n = i < 4 ? i + 1 : i
    return { id: `club-photo-${i}`, image: `/images/club/${n}.jpg` }
  },
)

export type MessagePost =
  | {
      id: string
      type: 'giveaway'
      date: string
      title: string
      steps: string[]
    }
  | {
      id: string
      type: 'announcement'
      date: string
      title: string
      text: string
      image: string
    }

export const messages: MessagePost[] = [
  {
    id: 'msg-giveaway-1',
    type: 'giveaway',
    date: '15 апреля',
    title: 'Разыгрываем 3 набора боулов от Pause! 🎁',
    steps: [
      'Подпишись на наш канал',
      'Оставь реакцию на этот пост',
      'Напиши в комментариях, какой боул ты любишь больше всего',
    ],
  },
  {
    id: 'msg-announcement-1',
    type: 'announcement',
    date: '10 апреля',
    title: 'Новое весеннее меню 🌿',
    text: 'Уже доступно в приложении! Встречай сезонные вкусы и свежие ингредиенты.',
    image: '/images/spring-menu.jpg',
  },
]

export const messageCategories = [
  { id: 'all', label: 'Все' },
  { id: 'announcement', label: 'Анонсы' },
  { id: 'giveaway', label: 'Розыгрыши' },
  { id: 'post', label: 'Посты' },
] as const

export type ProfileMenuRow = {
  id: string
  label: string
  icon: 'orders' | 'heart' | 'bell' | 'gift' | 'help'
}

export const profile = {
  name: 'Алексей',
  phone: '+998 90 123 45 67',
  stats: { orders: 12, promos: 3, posts: 5 },
  menuRows: [
    { id: 'orders', label: 'Мои заказы', icon: 'orders' },
    { id: 'favorites', label: 'Избранное', icon: 'heart' },
    { id: 'notifications', label: 'Уведомления', icon: 'bell' },
    { id: 'bonuses', label: 'Бонусы и промокоды', icon: 'gift' },
    { id: 'support', label: 'Поддержка', icon: 'help' },
  ] as ProfileMenuRow[],
}

export function formatSum(n: number): string {
  return n.toLocaleString('ru-RU').replace(/,/g, ' ') + ' UZS'
}
