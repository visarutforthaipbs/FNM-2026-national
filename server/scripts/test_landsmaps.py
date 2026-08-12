import urllib.request
import ssl
import re

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

headers = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8"
}

try:
    req = urllib.request.Request("https://landsmaps.dol.go.th/", headers=headers)
    with urllib.request.urlopen(req, context=ctx, timeout=10) as res:
        html = res.read().decode("utf-8")
        print(f"HTML length: {len(html)}")
        scripts = re.findall(r'src=["\'](.*?)["\']', html)
        print("Scripts found:")
        for s in scripts:
            print(" -", s)
except Exception as e:
    print("Error:", e)
