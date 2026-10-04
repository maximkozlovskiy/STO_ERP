"""Вимір нетипізованих роутів у OpenAPI-документі.

НАВІЩО СКРИПТ, А НЕ GREP. Цифра цього боргу перевизначалась тричі, і кожного разу
через вузький детектор: «59 контролерів без анотацій» (grep не бачив форму
@ApiResponse), «144 нетипізовані роути» (не відділяв 204/файлові), «60 потребують
типу» (рахував як нетипізовані ті, де тіла немає за задумом). Тут вимір іде по
ФАКТИЧНОМУ документу і розділяє три стани:

  типізовано   — 2xx має content.application/json зі схемою
  без тіла     — 204/205 або бінарна відповідь (pdf/xlsx): схеми немає ЗА ПРИЗНАЧЕННЯМ
  БЕЗ ТИПУ     — тіло є, схеми немає → справжній борг

Запуск (документ має бути свіжим):
  pnpm --filter @sto/api emit-openapi && python scripts/count-untyped-routes.py
"""

import json,io,sys
d=json.load(io.open('packages/shared/openapi.json',encoding='utf-8'))
out=io.StringIO()
total=typed=nobody=untyped=0
bymod={}
for p,ops in sorted(d['paths'].items()):
    for m,op in ops.items():
        if m not in ('get','post','put','patch','delete'): continue
        total+=1
        rs=op.get('responses',{})
        # успішний код
        ok=[c for c in rs if c.startswith('2')]
        has=False; body=False
        for c in ok:
            sch=rs[c].get('content',{})
            if sch:
                body=True
                j=sch.get('application/json',{}).get('schema')
                if j and ('$ref' in json.dumps(j)): has=True
                elif j: has=True  # inline-схема теж типізація
            if c in ('204','205'): pass
        if not body: nobody+=1
        elif has: typed+=1
        else:
            untyped+=1
            mod=p.split('/')[3] if len(p.split('/'))>3 else p
            bymod[mod]=bymod.get(mod,0)+1
            out.write('UNTYPED %-44s %s\n'%(p,m.upper()))
out.write('\nВСЬОГО роутів: %d | типізовано: %d | без тіла (204/файл): %d | БЕЗ ТИПУ: %d\n'%(total,typed,nobody,untyped))
out.write('по модулях: '+json.dumps(bymod,ensure_ascii=False,sort_keys=True)+'\n')
sys.stdout.reconfigure(encoding='utf-8')
print(out.getvalue())
