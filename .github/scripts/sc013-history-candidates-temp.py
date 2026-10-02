import datetime, json, sqlite3, sys

db, out, start_iso, end_iso = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]

def chrome_time(iso):
    dt = datetime.datetime.fromisoformat(iso.replace("Z", "+00:00"))
    unix_us = int(dt.timestamp() * 1_000_000)
    return unix_us + 11644473600 * 1_000_000

start = chrome_time(start_iso)
end = chrome_time(end_iso)
con = sqlite3.connect(db)
rows = con.execute("""
SELECT u.url, MAX(v.visit_time) AS vt
FROM visits v
JOIN urls u ON u.id = v.url
WHERE v.visit_time BETWEEN ? AND ?
  AND (
    u.url LIKE 'https://chatgpt.com/c/%'
    OR u.url LIKE 'https://chatgpt.com/g/%'
    OR u.url LIKE 'https://chatgpt.com/project/%'
  )
GROUP BY u.url
ORDER BY vt DESC
LIMIT 50
""", (start, end)).fetchall()

seen = []
for url, _ in rows:
    url = str(url).split('#', 1)[0].split('?', 1)[0]
    if url not in seen:
        seen.append(url)

with open(out, 'w', encoding='utf-8') as f:
    json.dump(seen, f)
print("DIAG_HISTORY_WINDOW_URL_COUNT=" + str(len(seen)))
