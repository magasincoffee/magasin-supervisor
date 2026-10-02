import json, sqlite3, sys
db, out = sys.argv[1], sys.argv[2]
con = sqlite3.connect(db)
rows = con.execute("""
SELECT url
FROM urls
WHERE url LIKE 'https://chatgpt.com/c/%'
   OR url LIKE 'https://chatgpt.com/g/%'
   OR url LIKE 'https://chatgpt.com/project/%'
ORDER BY last_visit_time DESC
LIMIT 100
""").fetchall()
seen = []
for (url,) in rows:
    url = str(url).split('#', 1)[0].split('?', 1)[0]
    if url not in seen:
        seen.append(url)
with open(out, 'w', encoding='utf-8') as f:
    json.dump(seen, f)
print("DIAG_HISTORY_URL_COUNT=" + str(len(seen)))
