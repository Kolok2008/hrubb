import re, json, sys
sys.path.insert(0, 'scripts')
from en_strings import UI, SPECIES, KNIVES, UPGRADES, WEATHER, EVENTS, ACH
p = 'src/game/i18n.ts'; s = open(p).read()
q = lambda v: json.dumps(v, ensure_ascii=False)
# UI keys present in the uk block
uk_start = s.index('\n  uk: {', s.index('const UI_STRINGS'))
uk_end = s.index('\n  },\n};', uk_start)
keys = re.findall(r'^\s{4}([A-Za-z0-9_]+):', s[uk_start:uk_end], re.M)
missing = [k for k in keys if k not in UI]
print('missing', missing)
body = '\n'.join(f'    {k}: {q(UI.get(k, ""))},' for k in keys if k in UI)
s = s[:uk_end] + '\n  },\n  en: {\n' + body + s[uk_end:]
def add_block(const, data, field2):
    global s
    i = s.index(f'const {const}')
    j = s.index('\n};', i)
    lines = [f'    {k}: {{ name: {q(v[0])}, {field2}: {q(v[1])} }},' for k, v in data.items()]
    s = s[:j] + '\n  en: {\n' + '\n'.join(lines) + '\n  },' + s[j:]
add_block('SPECIES_LOC', SPECIES, 'desc'); add_block('KNIVES_LOC', KNIVES, 'desc'); add_block('UPGRADES_LOC', UPGRADES, 'desc')
add_block('WEATHER_LOC', WEATHER, 'hint'); add_block('EVENTS_LOC', EVENTS, 'desc'); add_block('ACHIEVEMENTS_LOC', ACH, 'desc')
s = s.replace("return UI_STRINGS[lang][key] ?? UI_STRINGS.ru[key] ?? key;", "return UI_STRINGS[lang]?.[key] ?? UI_STRINGS.en[key] ?? UI_STRINGS.ru[key] ?? key;")
open(p, 'w').write(s)
