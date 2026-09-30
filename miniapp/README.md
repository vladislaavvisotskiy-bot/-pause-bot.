# PAUSE Mini App — UI-прототип

React 18 + TypeScript + Vite + Tailwind CSS, по [SPEC.md](./SPEC.md).
Функциональности нет — все данные из `src/data/mock.ts`, работает только
навигация. Backend (см. `../pauseapp.py`) отдаёт этот билд и проверяет
доступ (только админы из `ADMIN_IDS`), но никаких данных не отдаёт.

## Разработка

```bash
npm install
npm run dev
```

## Деплой

На Railway нет Node — только Python (см. `../Procfile`). Поэтому билд
собирается **здесь**, руками, и коммитится в репозиторий как обычные
статические файлы:

```bash
npm run build      # соберёт dist/
git add dist/
git commit -m "..."
```

`../pauseapp.py` отдаёт `dist/` напрямую, серверу не нужен ни Node, ни
шаг сборки — если забыть пересобрать и закоммитить `dist/` после правки
`src/`, на сервере останется старая версия.

## Реальные фото

Пока файлов нет — везде тёплая бежевая заглушка (см.
`src/components/ImageWithFallback.tsx`). Чтобы подставить свои,
положите файлы в `public/images/` под именами из `src/data/mock.ts`
(`splash.jpg`, `dish-1.jpg`, `club/1.jpg` … `club/11.jpg` и т.д.),
пересоберите (`npm run build`) и закоммитьте `dist/`.
