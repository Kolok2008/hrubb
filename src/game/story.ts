import type { Language } from './types';

export const STORY_DEBT = 2400;
export const STORY_DAYS = 20;
export const STORY_PAGES = 8;

export interface StoryCard {
  kind: 'letter' | 'page' | 'won' | 'lost';
  title: string;
  body: string;
  index?: number;
}

type L = Record<Language, [string, string]>;

const LETTER: L = {
  en: [
    'A Letter on the Table',
    "Dear grandchild,\n\nIf you are reading this, the cabin is yours now — together with my knife, my basket and, I am sorry to say, my debt to the forestry office: 2400 ₴. They gave me 20 days. Now they give them to you.\n\nDon't sell the cabin. The forest pays those who listen to it. I hid my diary pages along the paths — each one keeps a secret I learned in fifty autumns. Find them, and you will find what I could not finish.\n\nPay the debt at the buyer's stall. Be home before dark.\n\n— Grandma Olena",
  ],
  uk: [
    'Лист на столі',
    'Люба онучко чи онуче,\n\nякщо ти читаєш це, хатина тепер твоя — разом із моїм ножем, кошиком і, на жаль, боргом лісництву: 2400 ₴. Мені дали 20 днів. Тепер вони твої.\n\nНе продавай хатину. Ліс платить тим, хто вміє його слухати. Я сховала сторінки свого щоденника вздовж стежок — у кожній таємниця, яку я дізналась за п’ятдесят осеней. Знайди їх, і знайдеш те, що я не встигла закінчити.\n\nБорг сплачуй на скупці. Повертайся додому до темряви.\n\n— Бабуся Олена',
  ],
  ru: [
    'Письмо на столе',
    'Дорогой внук или внучка,\n\nесли ты читаешь это, избушка теперь твоя — вместе с моим ножом, корзиной и, увы, долгом лесничеству: 2400 ₴. Мне дали 20 дней. Теперь они твои.\n\nНе продавай избушку. Лес платит тем, кто умеет его слушать. Я спрятала страницы дневника вдоль тропинок — в каждой тайна, которую я узнала за пятьдесят осеней. Найди их, и найдёшь то, что я не успела закончить.\n\nДолг плати на скупке. Возвращайся домой до темноты.\n\n— Бабушка Олена',
  ],
};

const PAGES: Record<Language, [string, string][]> = {
  en: [
    ['Page 1 — The first autumn', 'I came to this cabin at nineteen with nothing but a borrowed knife. The old buyer laughed at my torn stems. "Cut low and clean," he said, "and the forest will trust you." He was right.'],
    ['Page 2 — Listening', 'Some mushrooms hear. I swear it. When I ran, they vanished into the leaves; when I crouched and held my breath, they stayed. Rain is your friend — it hides your steps.'],
    ['Page 3 — The rings', 'Where mushrooms grow in a circle, the old folk say the forest is breathing. I always found the finest one standing in the middle, as if waiting for me.'],
    ['Page 4 — Wolves', 'The wolves are not cruel, only hungry. A stone thrown wide sends them chasing the sound. I never wanted to hurt them. But when I had to, I did not hesitate.'],
    ['Page 5 — The dryer', 'Your grandfather built the drying rack the winter before he left us. Dried porcini fed us through the hardest years. Fresh is quick money; dried is patience paid back.'],
    ['Page 6 — The light in the thicket', 'Tonight I saw a glow far from the path, deep where the spruces close together. Gold, like a candle under the moss. It was gone before I reached it.'],
    ['Page 7 — The debt', 'The forestry office wants the land for a road. They lent me money for the roof and now ask for it back all at once. I am too old to hunt every day. Forgive me, child.'],
    ['Page 8 — The Golden Mushroom', 'I found it again. The Golden Mushroom grows only where nobody walks. It is not about the price. It means the forest is still alive and still ours. Keep the cabin, and keep the path quiet.'],
  ],
  uk: [
    ['Сторінка 1 — Перша осінь', 'Я прийшла до цієї хатини в дев’ятнадцять, маючи лише позичений ніж. Старий скупник сміявся з моїх рваних ніжок. «Ріж низько й чисто, — казав він, — і ліс тобі довірятиме». Він мав рацію.'],
    ['Сторінка 2 — Слухати', 'Деякі гриби чують. Присягаюсь. Коли я бігла, вони зникали в листі; коли присідала й затамовувала подих — залишались. Дощ — твій друг, він ховає кроки.'],
    ['Сторінка 3 — Кола', 'Де гриби ростуть колом, старі люди кажуть, що ліс дихає. Найкращий гриб я завжди знаходила посередині, ніби він чекав на мене.'],
    ['Сторінка 4 — Вовки', 'Вовки не жорстокі, лише голодні. Камінь, кинутий убік, змушує їх бігти на звук. Я ніколи не хотіла їм шкодити. Але коли мусила — не вагалась.'],
    ['Сторінка 5 — Сушарка', 'Твій дідусь збудував сушарку тієї зими, перш ніж нас покинути. Сушені білі годували нас у найважчі роки. Свіжі — швидкі гроші, сушені — терпіння, яке окупається.'],
    ['Сторінка 6 — Світло в гущавині', 'Сьогодні вночі я бачила сяйво далеко від стежки, там, де ялини сходяться щільно. Золоте, як свічка під мохом. Воно зникло, перш ніж я дійшла.'],
    ['Сторінка 7 — Борг', 'Лісництво хоче цю землю під дорогу. Вони позичили мені гроші на дах, а тепер вимагають усе одразу. Я надто стара, щоб ходити в ліс щодня. Пробач мені, дитино.'],
    ['Сторінка 8 — Золотий гриб', 'Я знову його знайшла. Золотий гриб росте лише там, де ніхто не ходить. Справа не в ціні. Він означає, що ліс ще живий і ще наш. Збережи хатину і бережи тишу стежки.'],
  ],
  ru: [
    ['Страница 1 — Первая осень', 'Я пришла в эту избушку в девятнадцать, с одним одолженным ножом. Старый скупщик смеялся над моими рваными ножками. «Режь низко и чисто, — говорил он, — и лес будет тебе доверять». Он был прав.'],
    ['Страница 2 — Слушать', 'Некоторые грибы слышат. Клянусь. Когда я бежала, они исчезали в листве; когда приседала и затаивала дыхание — оставались. Дождь — твой друг, он прячет шаги.'],
    ['Страница 3 — Кольца', 'Где грибы растут кругом, старики говорят, что лес дышит. Лучший гриб я всегда находила в середине, будто он ждал меня.'],
    ['Страница 4 — Волки', 'Волки не жестокие, только голодные. Камень, брошенный в сторону, заставляет их бежать на звук. Я никогда не хотела им вредить. Но когда приходилось — не колебалась.'],
    ['Страница 5 — Сушилка', 'Твой дедушка построил сушилку той зимой, перед тем как нас покинуть. Сушёные белые кормили нас в самые тяжёлые годы. Свежие — быстрые деньги, сушёные — терпение, которое окупается.'],
    ['Страница 6 — Свет в чаще', 'Этой ночью я видела сияние далеко от тропы, там, где ели смыкаются плотно. Золотое, как свеча под мхом. Оно исчезло, прежде чем я дошла.'],
    ['Страница 7 — Долг', 'Лесничество хочет эту землю под дорогу. Мне одолжили деньги на крышу, а теперь требуют всё сразу. Я слишком стара, чтобы ходить в лес каждый день. Прости меня, дитя.'],
    ['Страница 8 — Золотой гриб', 'Я снова его нашла. Золотой гриб растёт только там, где никто не ходит. Дело не в цене. Он значит, что лес ещё жив и ещё наш. Сохрани избушку и береги тишину тропы.'],
  ],
};

const WON: L = {
  en: ['The Cabin Is Yours', 'The forestry clerk counts the last coins twice and signs the paper. The debt is paid.\n\nThat evening you sit by the fire with Grandma Olena’s diary on your knees. The forest is quiet, the dryer smells of porcini, and the path is still yours.\n\nThank you for playing Mushroom Hollow. The woods stay open — keep foraging as long as you like.'],
  uk: ['Хатина твоя', 'Писар лісництва двічі перераховує останні монети й підписує папір. Борг сплачено.\n\nУвечері ти сидиш біля вогнища з бабусиним щоденником на колінах. Ліс тихий, сушарка пахне білими, і стежка досі твоя.\n\nДякуємо, що грали в Mushroom Hollow. Ліс відкритий — збирай гриби скільки завгодно.'],
  ru: ['Избушка твоя', 'Писарь лесничества дважды пересчитывает последние монеты и подписывает бумагу. Долг уплачен.\n\nВечером ты сидишь у костра с бабушкиным дневником на коленях. Лес тихий, сушилка пахнет белыми, и тропа всё ещё твоя.\n\nСпасибо, что играли в Mushroom Hollow. Лес открыт — собирай грибы сколько угодно.'],
};

const LOST: L = {
  en: ['The Deadline Has Passed', 'A notice is nailed to the cabin door: the debt was not paid in time.\n\nBut the old clerk is a forager too. "Olena helped my family once," he mutters, and gives you one more chance — the debt stays, but the deadline is gone.\n\nKeep picking, pay what you owe, and the cabin will still be yours.'],
  uk: ['Термін минув', 'На дверях хатини прибито повідомлення: борг не сплачено вчасно.\n\nАле старий писар теж грибник. «Олена колись допомогла моїй родині», — бурмоче він і дає ще один шанс: борг лишається, але термін знято.\n\nЗбирай далі, сплати борг — і хатина все одно буде твоєю.'],
  ru: ['Срок истёк', 'На двери избушки прибито уведомление: долг не уплачен вовремя.\n\nНо старый писарь тоже грибник. «Олена когда-то помогла моей семье», — бормочет он и даёт ещё один шанс: долг остаётся, но срок снят.\n\nСобирай дальше, заплати долг — и избушка всё равно будет твоей.'],
};

export function storyLetter(lang: Language): StoryCard {
  const [title, body] = LETTER[lang];
  return { kind: 'letter', title, body };
}
export function storyPage(lang: Language, i: number): StoryCard {
  const [title, body] = PAGES[lang][i];
  return { kind: 'page', title, body, index: i };
}
export function storyEnding(lang: Language, won: boolean): StoryCard {
  const [title, body] = (won ? WON : LOST)[lang];
  return { kind: won ? 'won' : 'lost', title, body };
}

export const STORY_UI: Record<Language, Record<string, string>> = {
  en: { debt: 'Debt', daysLeft: 'days left', pay: 'Pay toward the debt', paid: 'Debt paid', pages: 'Diary pages', cont: 'Continue', keep: 'Keep foraging', page: 'A diary page is somewhere on the trail today — look for the glow.', noDeadline: 'no deadline', pagePrompt: 'Diary page' },
  uk: { debt: 'Борг', daysLeft: 'дн. лишилось', pay: 'Сплатити частину боргу', paid: 'Борг сплачено', pages: 'Сторінки щоденника', cont: 'Далі', keep: 'Збирати далі', page: 'Сьогодні десь біля стежки лежить сторінка щоденника — шукай сяйво.', noDeadline: 'без терміну', pagePrompt: 'Сторінка щоденника' },
  ru: { debt: 'Долг', daysLeft: 'дн. осталось', pay: 'Заплатить часть долга', paid: 'Долг уплачен', pages: 'Страницы дневника', cont: 'Дальше', keep: 'Собирать дальше', page: 'Сегодня где-то у тропы лежит страница дневника — ищи сияние.', noDeadline: 'без срока', pagePrompt: 'Страница дневника' },
};
